import type { Plugin } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";
import * as path from "path";
import { Database } from "bun:sqlite";
import { Cron } from "croner";

// =============================================================================
// Types
// =============================================================================

interface CronJob {
  name: string;
  agent_name: string;
  schedule: string;
  timezone: string | null;
  message: string;
  enabled: number;
  created_at: number;
  last_run: number | null;
}

interface CronHistory {
  job_name: string;
  executed_at: number;
  success: number;
  error_message: string | null;
}

// =============================================================================
// Database
// =============================================================================

let dbFile: string | null = null;
let db: Database | null = null;

// Track active Croner job instances per agent
const activeCronJobs = new Map<string, Map<string, Cron>>();

async function getDbFile(client: ReturnType<typeof createOpencodeClient>): Promise<string> {
  if (!dbFile) {
    const result = await client.path.get();
    dbFile = path.join(result.data!.config, "cron.db");
  }
  return dbFile;
}

async function getDatabase(client: ReturnType<typeof createOpencodeClient>): Promise<Database> {
  if (!db) {
    const file = await getDbFile(client);
    db = new Database(file);
    
    // Enable WAL mode for better concurrency
    db.run("PRAGMA journal_mode = WAL");
    
    // Create the cron_jobs table (with timezone column)
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT,
        message TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_run INTEGER
      )
    `);
    
    // Add timezone column if it doesn't exist (migration)
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN timezone TEXT`);
    } catch (e) {
      // Column already exists, ignore error
    }
    
    // Create unique index on name+agent_name for fast lookups and uniqueness
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_name_owner ON cron_jobs(name, owner)
    `);
    
    // Create index on agent_name for filtering by agent_name
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner ON cron_jobs(owner)
    `);
    
    // Create index on enabled for watch queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled)
    `);
    
    // Create the execution history table
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        executed_at INTEGER NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        FOREIGN KEY (job_name) REFERENCES cron_jobs(name)
      )
    `);
    
    // Create index on job_name for history lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_history_job_name ON cron_history(job_name)
    `);
    
    // Create index on executed_at for sorting
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_history_executed_at ON cron_history(executed_at DESC)
    `);
  }
  return db;
}

async function createCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string,
  schedule: string,
  timezone: string | null,
  message: string
): Promise<void> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    INSERT INTO cron_jobs (name, owner, schedule, timezone, message, enabled, created_at, last_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(name, agent_name, schedule, timezone, message, 1, Date.now());
}

async function getCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string
): Promise<CronJob | null> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    SELECT name, owner as agent_name, schedule, timezone, message, enabled, created_at, last_run
    FROM cron_jobs
    WHERE name = ? AND owner = ?
  `);
  const result = stmt.get(name, agent_name) as CronJob | undefined;
  return result || null;
}

async function listCronJobs(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string
): Promise<CronJob[]> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    SELECT name, owner as agent_name, schedule, timezone, message, enabled, created_at, last_run
    FROM cron_jobs
    WHERE owner = ?
    ORDER BY name ASC
  `);
  return stmt.all(agent_name) as CronJob[];
}

async function deleteCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string
): Promise<boolean> {
  const database = await getDatabase(client);
  
  // First delete history (only for jobs owned by this agent)
  const deleteHistoryStmt = database.prepare(`
    DELETE FROM cron_history WHERE job_name = ? AND EXISTS (
      SELECT 1 FROM cron_jobs WHERE name = ? AND owner = ?
    )
  `);
  deleteHistoryStmt.run(name, name, agent_name);
  
  // Then delete job
  const stmt = database.prepare(`
    DELETE FROM cron_jobs WHERE name = ? AND owner = ?
  `);
  const result = stmt.run(name, agent_name);
  return result.changes > 0;
}

async function enableCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string
): Promise<boolean> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    UPDATE cron_jobs SET enabled = 1 WHERE name = ? AND owner = ?
  `);
  const result = stmt.run(name, agent_name);
  return result.changes > 0;
}

async function disableCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string
): Promise<boolean> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    UPDATE cron_jobs SET enabled = 0 WHERE name = ? AND owner = ?
  `);
  const result = stmt.run(name, agent_name);
  return result.changes > 0;
}

async function updateLastRun(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string,
  timestamp: number
): Promise<void> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    UPDATE cron_jobs SET last_run = ? WHERE name = ? AND owner = ?
  `);
  stmt.run(timestamp, name, agent_name);
}

async function addHistoryEntry(
  client: ReturnType<typeof createOpencodeClient>,
  jobName: string,
  executedAt: number,
  success: boolean,
  errorMessage: string | null = null
): Promise<void> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    INSERT INTO cron_history (job_name, executed_at, success, error_message)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(jobName, executedAt, success ? 1 : 0, errorMessage);
}

async function getCronHistory(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  name: string,
  limit: number = 10
): Promise<CronHistory[]> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    SELECT ch.job_name, ch.executed_at, ch.success, ch.error_message
    FROM cron_history ch
    INNER JOIN cron_jobs cj ON ch.job_name = cj.name
    WHERE ch.job_name = ? AND cj.owner = ?
    ORDER BY ch.executed_at DESC
    LIMIT ?
  `);
  return stmt.all(name, agent_name, limit) as CronHistory[];
}

async function getEnabledJobs(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string
): Promise<CronJob[]> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    SELECT name, owner as agent_name, schedule, timezone, message, enabled, created_at, last_run
    FROM cron_jobs
    WHERE enabled = 1 AND owner = ?
    ORDER BY name ASC
  `);
  return stmt.all(agent_name) as CronJob[];
}

// =============================================================================
// Cron Scheduling (using croner library native scheduling)
// =============================================================================

/**
 * Calculate the next run time for a cron schedule with optional timezone.
 * Returns ISO string or null if schedule is invalid.
 */
function getNextRunTime(schedule: string, timezone?: string | null): string | null {
  try {
    const options: { timezone?: string } = {};
    if (timezone) {
      options.timezone = timezone;
    }
    const job = new Cron(schedule, options);
    const nextRun = job.nextRun();
    return nextRun?.toISOString() || null;
  } catch (error) {
    return null;
  }
}

/**
 * Validate a cron schedule expression.
 */
function isValidSchedule(schedule: string): boolean {
  try {
    new Cron(schedule);
    return true;
  } catch (error) {
    return false;
  }
}

// =============================================================================
// Native Cron Watch System (Croner-based)
// =============================================================================

/**
 * Start the cron scheduler using Croner's native scheduling for a specific agent_name.
 * Creates actual Cron instances that run at the exact scheduled time.
 */
async function startCronWatch(
  client: ReturnType<typeof createOpencodeClient>,
  agent_name: string,
  sessionId: string
): Promise<void> {
  // Don't start multiple watches for the same agent_name
  if (activeCronJobs.has(agent_name)) {
    return;
  }

  const agentJobs = new Map<string, Cron>();
  activeCronJobs.set(agent_name, agentJobs);

  // Get all enabled jobs for this agent_name
  const jobs = await getEnabledJobs(client, agent_name);
  
  for (const job of jobs) {
    try {
      const cronJob = createCronerJob(client, sessionId, job);
      if (cronJob) {
        agentJobs.set(job.name, cronJob);
      }
    } catch (error) {
      console.error(`[Cron] Failed to create job "${job.name}" for agent_name "${agent_name}":`, error);
    }
  }


}

/**
 * Create a Croner job instance for a database job.
 */
function createCronerJob(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  job: CronJob
): Cron | null {
  try {
    const options: {
      timezone?: string;
      protect: boolean;
      start: boolean;
    } = {
      protect: true,  // Prevent overlapping runs
      start: true,    // Start immediately
    };

    if (job.timezone) {
      options.timezone = job.timezone;
    }

    const cronJob = new Cron(
      job.schedule,
      options,
      async () => {
        await executeCronJob(client, sessionId, job);
      }
    );

    return cronJob;
  } catch (error) {
    console.error(`[Cron] Error creating Croner job "${job.name}":`, error);
    return null;
  }
}

/**
 * Stop the cron scheduler for a specific agent_name.
 * Stops all Croner job instances.
 */
function stopCronWatch(agent_name: string): void {
  const agentJobs = activeCronJobs.get(agent_name);
  if (agentJobs) {
    for (const [jobName, cronJob] of agentJobs.entries()) {
      cronJob.stop();
    }
    agentJobs.clear();
    activeCronJobs.delete(agent_name);
  }
}

/**
 * Stop all cron watches.
 */
function stopAllCronWatches(): void {
  for (const [agent_name, agentJobs] of activeCronJobs.entries()) {
    for (const [jobName, cronJob] of agentJobs.entries()) {
      cronJob.stop();
    }
    agentJobs.clear();
  }
  activeCronJobs.clear();
}

/**
 * Check if a cron watch is active for a specific agent_name.
 */
function isCronWatchActive(agent_name: string): boolean {
  return activeCronJobs.has(agent_name);
}

/**
 * Execute a cron job: update last_run, add history, and inject message.
 */
async function executeCronJob(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  job: CronJob
): Promise<void> {
  const executedAt = Date.now();
  
  try {

    
    // Update last run time
    await updateLastRun(client, job.agent_name, job.name, executedAt);
    
    // Add history entry
    await addHistoryEntry(client, job.name, executedAt, true);
    
    // Inject the message into the session
    await injectCronMessage(client, sessionId, job);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await addHistoryEntry(client, job.name, executedAt, false, errorMessage);
    console.error(`[Cron] Failed to execute job "${job.name}":`, error);
  }
}

/**
 * Inject a cron message into a session.
 */
async function injectCronMessage(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  job: CronJob
): Promise<void> {
  const timestamp = new Date().toISOString();
  
  // Format the injected message
  const injectedText = `[CRON JOB: ${job.name} - ${timestamp}]
${job.message}`;

  try {
    // Step 1: Inject the message with noReply: true
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text" as const, text: injectedText }],
      },
    });

    // Step 2: Wake up the session
    try {
      const sessionApi = client.session as any;
      if (sessionApi.resume) {
        await sessionApi.resume({
          path: { id: sessionId },
          body: {},
        });
      } else {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text" as const, text: `Cron job "${job.name}" has triggered. Please review the message above and take appropriate action.` }],
          },
        });
      }
    } catch (wakeError) {
      console.warn(`[Cron] Failed to wake up session ${sessionId}:`, wakeError);
    }
  } catch (error) {
    console.error(`[Cron] Failed to inject cron message:`, error);
    throw error;
  }
}

// =============================================================================
// Plugin Definition
// =============================================================================

const cronPlugin: Plugin = async (ctx) => {
  const client = ctx.client;

  // Get the tool helper and zod schema from the plugin
  const { tool } = await import("@opencode-ai/plugin");
  const z = tool.schema;

  // Create tools with access to client via closure
  const createCronJobTool = tool({
    description: "Create a new scheduled cron job with optional IANA timezone support (e.g., 'America/Los_Angeles'). Uses system timezone if not specified.",
    args: {
      agent_name: z.string().describe("Owner identifier for this job (e.g., user name or session id)"),
      name: z.string().describe("Unique job identifier (unique per agent_name)"),
      schedule: z.string().describe("5-element cron expression (e.g., '*/5 * * * *' for every 5 minutes, '0 9 * * 1-5' for weekdays at 9am)"),
      message: z.string().describe("Message to inject when job fires"),
      timezone: z.string().optional().describe("IANA timezone (e.g., 'America/Los_Angeles', 'America/New_York'). Uses system timezone if not specified."),

    },
    async execute(args) {
      try {
        // Validate schedule format
        if (!isValidSchedule(args.schedule)) {
          return `Error: Invalid cron schedule "${args.schedule}". Please provide a valid 5-element cron expression.`;
        }
        
        // Validate timezone if provided
        if (args.timezone) {
          try {
            // Test if timezone is valid by creating a Cron with it
            new Cron("0 0 * * *", { timezone: args.timezone });
          } catch (tzError) {
            return `Error: Invalid timezone "${args.timezone}". Please provide a valid IANA timezone (e.g., "America/Los_Angeles").`;
          }
        }
        
        await createCronJob(client, args.agent_name, args.name, args.schedule, args.timezone ?? null, args.message);
        
        const tzInfo = args.timezone ? ` (timezone: ${args.timezone})` : "";
        return `Cron job "${args.name}" created successfully with schedule "${args.schedule}"${tzInfo} for agent_name "${args.agent_name}".`;
      } catch (error: any) {
        if (error.message?.includes("UNIQUE constraint failed")) {
          return `Error: A job with name "${args.name}" already exists for agent_name "${args.agent_name}".`;
        }
        return `Error creating cron job: ${error.message || error}`;
      }
    },
  });

  const listCronJobsTool = tool({
    description: "List all cron jobs for a specific agent_name with status, schedule, timezone, last run time, and next scheduled run",
    args: {
      agent_name: z.string().describe("Owner identifier to list jobs for"),
    },
    async execute(args) {
      const jobs = await listCronJobs(client, args.agent_name);
      
      if (jobs.length === 0) {
        return `No cron jobs found for agent_name "${args.agent_name}".`;
      }
      
      const jobList = jobs.map(job => {
        const status = job.enabled ? "✓ enabled" : "✗ disabled";
        const lastRun = job.last_run ? new Date(job.last_run).toISOString() : "never";
        const nextRun = job.enabled ? (getNextRunTime(job.schedule, job.timezone) || "invalid schedule") : "n/a";
        const tz = job.timezone ? ` [${job.timezone}]` : "";
        return `  - ${job.name}: "${job.schedule}"${tz} [${status}]\n    message: ${job.message}\n    last: ${lastRun}\n    next: ${nextRun}`;
      }).join("\n");
      
      return `Cron jobs for agent_name "${args.agent_name}" (${jobs.length}):\n${jobList}`;
    },
  });

  const deleteCronJobTool = tool({
    description: "Remove a cron job by name for a specific agent_name",
    args: {
      agent_name: z.string().describe("Owner identifier of the job"),
      name: z.string().describe("Name of the job to delete"),
    },
    async execute(args) {
      const deleted = await deleteCronJob(client, args.agent_name, args.name);
      if (deleted) {
        return `Cron job "${args.name}" for agent_name "${args.agent_name}" deleted successfully.`;
      } else {
        return `Error: No job found with name "${args.name}" for agent_name "${args.agent_name}".`;
      }
    },
  });

  const enableCronJobTool = tool({
    description: "Enable a previously disabled cron job for a specific agent_name",
    args: {
      agent_name: z.string().describe("Owner identifier of the job"),
      name: z.string().describe("Name of the job to enable"),
    },
    async execute(args) {
      const enabled = await enableCronJob(client, args.agent_name, args.name);
      if (enabled) {
        return `Cron job "${args.name}" for agent_name "${args.agent_name}" enabled successfully.`;
      } else {
        return `Error: No job found with name "${args.name}" for agent_name "${args.agent_name}".`;
      }
    },
  });

  const disableCronJobTool = tool({
    description: "Disable an enabled cron job for a specific agent_name (pauses execution)",
    args: {
      agent_name: z.string().describe("Owner identifier of the job"),
      name: z.string().describe("Name of the job to disable"),
    },
    async execute(args) {
      const disabled = await disableCronJob(client, args.agent_name, args.name);
      if (disabled) {
        return `Cron job "${args.name}" for agent_name "${args.agent_name}" disabled successfully.`;
      } else {
        return `Error: No job found with name "${args.name}" for agent_name "${args.agent_name}".`;
      }
    },
  });

  const startWatchingCronTool = tool({
    description: "IMPORTANT: Creating a cron job does NOT automatically start watching! You must explicitly call this tool to start watching. Start the scheduler to monitor and execute cron jobs for a specific agent_name using native Croner scheduling (exact timing, timezone support, overlapping protection).",
    args: {
      agent_name: z.string().describe("Owner identifier to watch jobs for"),
    },
    async execute(args, toolCtx) {
      const sessionId = toolCtx.sessionID;
      
      // Start the scheduler for this agent_name
      await startCronWatch(client, args.agent_name, sessionId);
      
      const jobs = await getEnabledJobs(client, args.agent_name);
      return `Cron job scheduler started for agent_name "${args.agent_name}" with ${jobs.length} active job(s) using native Croner scheduling. Jobs will execute at exact scheduled times with timezone support and overlapping protection.`;
    },
  });

  const stopWatchingCronTool = tool({
    description: "Stop the cron job scheduler for a specific agent_name",
    args: {
      agent_name: z.string().describe("Owner identifier to stop watching jobs for"),
    },
    async execute(args) {
      stopCronWatch(args.agent_name);
      return `Cron job scheduler stopped for agent_name "${args.agent_name}".`;
    },
  });

  const getCronHistoryTool = tool({
    description: "Get execution history for a cron job for a specific agent_name",
    args: {
      agent_name: z.string().describe("Owner identifier of the job"),
      name: z.string().describe("Name of the job"),
      limit: z.number().optional().describe("Number of recent executions to return (default: 10)"),
    },
    async execute(args) {
      const history = await getCronHistory(client, args.agent_name, args.name, args.limit ?? 10);
      
      if (history.length === 0) {
        return `No execution history found for job "${args.name}" for agent_name "${args.agent_name}".`;
      }
      
      const historyList = history.map((entry, i) => {
        const status = entry.success ? "✓ success" : "✗ failed";
        const time = new Date(entry.executed_at).toISOString();
        const error = entry.error_message ? ` - Error: ${entry.error_message}` : "";
        return `  ${i + 1}. ${time} [${status}]${error}`;
      }).join("\n");
      
      return `Execution history for "${args.name}" for agent_name "${args.agent_name}" (${history.length} entries):\n${historyList}`;
    },
  });

  const checkCronWatchStatusTool = tool({
    description: "Check if a cron job scheduler is actively watching for a specific agent_name",
    args: {
      agent_name: z.string().describe("Owner identifier to check watch status for"),
    },
    async execute(args) {
      const isActive = isCronWatchActive(args.agent_name);
      
      if (isActive) {
        const agentJobs = activeCronJobs.get(args.agent_name);
        const jobCount = agentJobs?.size || 0;
        return `Cron job scheduler is ACTIVE for agent_name "${args.agent_name}" with ${jobCount} job(s) running.`;
      } else {
        return `Cron job scheduler is NOT ACTIVE for agent_name "${args.agent_name}". Use start_watching_cron_jobs to begin monitoring jobs.`;
      }
    },
  });

  return {
    // Register tools
    tool: {
      create_cron_job: createCronJobTool,
      list_cron_jobs: listCronJobsTool,
      delete_cron_job: deleteCronJobTool,
      enable_cron_job: enableCronJobTool,
      disable_cron_job: disableCronJobTool,
      start_watching_cron_jobs: startWatchingCronTool,
      stop_watching_cron_jobs: stopWatchingCronTool,
      get_cron_history: getCronHistoryTool,
      check_cron_jobs_watch_status: checkCronWatchStatusTool,
    },

    // Hook: Add tools to primary_tools config
    config: async (input: { experimental?: { primary_tools?: string[]; [key: string]: unknown }; [key: string]: unknown }) => {
      input.experimental ??= {};
      input.experimental.primary_tools ??= [];
      input.experimental.primary_tools.push(
        "create_cron_job",
        "list_cron_jobs",
        "delete_cron_job",
        "enable_cron_job",
        "disable_cron_job",
        "start_watching_cron_jobs",
        "stop_watching_cron_jobs",
        "get_cron_history",
        "check_cron_jobs_watch_status"
      );
    },

    // Hook: Clean up scheduler when session ends
    hooks: {
      "session.end": async () => {
        stopAllCronWatches();
      },
    },
  };
};

export default cronPlugin;
