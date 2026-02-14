# opencode-cron

A cron job scheduler for OpenCode sessions that triggers messages at scheduled intervals.

## Description

This OpenCode plugin provides a lightweight cron job system that allows sessions to schedule automated actions. Jobs are stored in a SQLite database with execution history tracking.

**NOTE: Cron data is stored in `~/.config/opencode/cron.db`**

## Installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cron"
  ]
  ...
}
```

## Usage

The plugin provides eight tools for managing cron jobs:

### Tools

- **create_cron_job** - Create a new scheduled job
- **list_cron_jobs** - List all jobs with status and next run time
- **delete_cron_job** - Remove a job by name
- **enable_cron_job** - Enable a disabled job
- **disable_cron_job** - Disable an enabled job
- **watch_cron_jobs** - Start the scheduler to auto-trigger jobs
- **stop_watching_cron** - Stop the job scheduler
- **get_cron_history** - Get execution history for a job

## API

### create_cron_job

Create a new scheduled job.

**Parameters:**
- `name` (string, required) - Unique job identifier
- `schedule` (string, required) - 5-element cron expression (e.g., "*/5 * * * *")
- `message` (string, required) - Message to inject when job fires
- `enabled` (boolean, optional) - Whether job is active (default: true)

### list_cron_jobs

List all cron jobs with their status, schedule, last run time, and next scheduled run.

**Parameters:** None

**Returns:** Array of jobs with name, schedule, enabled status, last run, and next run time

### delete_cron_job

Remove a job by name.

**Parameters:**
- `name` (string, required) - Name of the job to delete

### enable_cron_job

Enable a previously disabled job.

**Parameters:**
- `name` (string, required) - Name of the job to enable

### disable_cron_job

Disable an enabled job (pauses execution).

**Parameters:**
- `name` (string, required) - Name of the job to disable

### watch_cron_jobs

Start the scheduler to monitor and execute jobs. When a job's scheduled time arrives, its message is injected into the session.

**Parameters:** None

### stop_watching_cron

Stop the job scheduler.

**Parameters:** None

**Returns:** Confirmation that the scheduler has been stopped

### get_cron_history

Get execution history for a job.

**Parameters:**
- `name` (string, required) - Name of the job
- `limit` (number, optional) - Number of recent executions to return (default: 10)

**Returns:** Array of execution records with timestamp, success status, and any error message

## Cron Expression Format

Uses standard 5-element cron format:
```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-7, where 0 and 7 are Sunday)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

Examples:
- `"*/5 * * * *"` - Every 5 minutes
- `"0 9 * * 1"` - Every Monday at 9:00 AM
- `"0 0 * * *"` - Every day at midnight
- `"0 */6 * * *"` - Every 6 hours

## Storage

Cron data is persisted in a SQLite database at `~/.config/opencode/cron.db`. The database includes:
- Jobs table with schedule, message, and enabled status
- Execution history table tracking success/failure
- WAL (Write-Ahead Logging) mode for better concurrency

## Session Management

When a session ends, the job scheduler is automatically stopped.

## Requirements

- Peer dependency: `@opencode-ai/plugin` ^1.1.25

## License

MIT

## Repository

https://github.com/richardanaya/opencode-cron
