// Cron MCP tool definitions for the Claude Agent SDK.
// Follows the same pattern as Chrome MCP tools.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { CronScheduler } from './scheduler.js'
import { saveJob, deleteJob, getJob, listJobs, generateJobId, getRuns } from './store.js'
import type { CronJob } from './types.js'

// Reference to the scheduler instance (set by initializeCronTools)
let scheduler: CronScheduler | null = null

// Per-query context — set before each SDK query so cron_create can reliably
// access projectId/clientId/sessionId even if updateToolInput is unavailable.
let currentQueryContext: { projectId?: string; clientId?: string; sessionId?: string } = {}

export function setCurrentQueryContext(ctx: { projectId?: string; clientId?: string; sessionId?: string }): void {
  currentQueryContext = ctx
}

export function initializeCronTools(cronScheduler: CronScheduler): void {
  scheduler = cronScheduler
}

function formatSchedule(schedule: CronJob['schedule']): string {
  switch (schedule.kind) {
    case 'at':
      return `at ${new Date(schedule.at).toLocaleString()}`
    case 'every': {
      const mins = Math.round(schedule.everyMs / 60000)
      if (mins < 60) return `every ${mins} minute${mins > 1 ? 's' : ''}`
      const hours = Math.round(mins / 60)
      if (hours < 24) return `every ${hours} hour${hours > 1 ? 's' : ''}`
      const days = Math.round(hours / 24)
      return `every ${days} day${days > 1 ? 's' : ''}`
    }
    case 'cron':
      return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ''}`
    default:
      return 'unknown schedule'
  }
}

export const cronTools = [
  tool(
    'cron_create',
    `Create a scheduled task that will execute automatically at a specific time or on a recurring schedule.

Use this tool when the user asks to:
- Set a reminder (e.g., "remind me in 5 minutes")
- Schedule a task (e.g., "check email every hour")
- Perform an action later (e.g., "tomorrow morning check the logs")

The 'when' parameter accepts natural language like "1 minute later", "5 minutes from now", "tomorrow at 9am", "every hour", or cron expression "0 9 * * *".

CRITICAL - The 'prompt' parameter is the instruction that will be executed when the scheduled time arrives. For reminders, the prompt MUST explicitly instruct the AI to send a push notification using the push_send tool.`,
    {
      name: z.string().describe('A descriptive name for this scheduled task'),
      when: z
        .string()
        .describe(
          'When to execute: natural language like "10 minutes later", "tomorrow at 9am", or cron expression',
        ),
      prompt: z
        .string()
        .describe('The instruction to execute at the scheduled time'),
      recurring: z
        .boolean()
        .optional()
        .describe('Whether this is a recurring task (default: false)'),
      cronExpression: z
        .string()
        .optional()
        .describe('Optional cron expression for recurring tasks (e.g., "0 9 * * *")'),
      timezone: z
        .string()
        .optional()
        .describe('Optional timezone (e.g., "Asia/Shanghai")'),
      description: z
        .string()
        .optional()
        .describe('Optional description or notes about this task'),
      deleteAfterRun: z
        .boolean()
        .optional()
        .describe('For one-time tasks, auto-delete after execution (default: true)'),
      // Context fields — auto-injected by canUseTool
      projectId: z.string().optional().describe('Project ID (auto-injected)'),
      clientId: z.string().optional().describe('Client ID (auto-injected)'),
      sessionId: z.string().optional().describe('Session ID (auto-injected)'),
    },
    async (input) => {
      if (!scheduler) {
        return {
          content: [{ type: 'text' as const, text: 'Cron scheduler not initialized' }],
          isError: true,
        }
      }

      const isRecurring = input.recurring || !!input.cronExpression
      const scheduleInput = input.cronExpression || input.when
      const parsed = CronScheduler.parseSchedule(scheduleInput, isRecurring)

      if (!parsed.isValid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not parse schedule: "${input.when}". Try formats like "10 minutes later", "tomorrow at 9am", or cron expression "0 9 * * *"`,
            },
          ],
          isError: true,
        }
      }

      // For "at" schedules, ensure it's in the future
      if (parsed.schedule.kind === 'at') {
        const runTime = new Date(parsed.schedule.at)
        if (runTime.getTime() <= Date.now()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Scheduled time "${input.when}" is in the past. Please specify a future time.`,
              },
            ],
            isError: true,
          }
        }
      }

      // Merge tool input with module-level query context as fallback
      // (updateToolInput in canUseTool may silently fail for MCP tools)
      const projectId = input.projectId || currentQueryContext.projectId
      const clientId = input.clientId || currentQueryContext.clientId
      const sessionId = input.sessionId || currentQueryContext.sessionId

      const jobId = generateJobId()
      const job: CronJob = {
        id: jobId,
        name: input.name,
        description: input.description,
        schedule: parsed.schedule,
        prompt: input.prompt,
        context: {
          projectId,
          clientId,
          sessionId,
        },
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        deleteAfterRun: input.deleteAfterRun ?? parsed.schedule.kind === 'at',
        delivery: {
          mode: 'websocket',
          target: sessionId,
        },
      }

      saveJob(job)

      const scheduled = scheduler.scheduleJob(job)
      if (!scheduled) {
        deleteJob(job.id)
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Failed to schedule the job. Please check your schedule format.',
            },
          ],
          isError: true,
        }
      }

      const scheduleDesc = formatSchedule(job.schedule)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created scheduled task "${job.name}" (${scheduleDesc}).\n\nTask ID: ${job.id}\nNext run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'N/A'}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_list',
    'List all scheduled tasks, optionally filtered by status',
    {
      status: z
        .string()
        .optional()
        .describe('Filter by status: pending, running, completed, failed, disabled'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of tasks to return (default: 20)'),
    },
    async (input) => {
      const jobs = listJobs({
        status: input.status,
        limit: input.limit || 20,
      })

      if (jobs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }],
        }
      }

      const formatted = jobs.map(
        (job) =>
          `- ${job.name} (${job.id}): ${formatSchedule(job.schedule)} | status: ${job.status} | runs: ${job.runCount}`,
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${jobs.length} scheduled task(s):\n\n${formatted.join('\n')}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_delete',
    'Delete a scheduled task by its ID',
    {
      jobId: z.string().describe('The ID of the task to delete'),
    },
    async (input) => {
      if (!scheduler) {
        return {
          content: [{ type: 'text' as const, text: 'Cron scheduler not initialized' }],
          isError: true,
        }
      }

      const job = getJob(input.jobId)
      if (!job) {
        return {
          content: [
            { type: 'text' as const, text: `Task not found: ${input.jobId}` },
          ],
          isError: true,
        }
      }

      scheduler.cancelSchedule(input.jobId)
      const deleted = deleteJob(input.jobId)

      if (deleted) {
        return {
          content: [
            { type: 'text' as const, text: `Deleted scheduled task "${job.name}"` },
          ],
        }
      } else {
        return {
          content: [{ type: 'text' as const, text: 'Failed to delete the task' }],
          isError: true,
        }
      }
    },
  ),

  tool(
    'cron_get',
    'Get detailed information about a specific scheduled task',
    {
      jobId: z.string().describe('The ID of the task'),
    },
    async (input) => {
      const job = getJob(input.jobId)
      if (!job) {
        return {
          content: [
            { type: 'text' as const, text: `Task not found: ${input.jobId}` },
          ],
          isError: true,
        }
      }

      const runs = getRuns(job.id, 5)

      const details = `Task: ${job.name}
ID: ${job.id}
Status: ${job.status}
Schedule: ${formatSchedule(job.schedule)}
Prompt: ${job.prompt}
Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'N/A'}
Last run: ${job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'N/A'}
Run count: ${job.runCount}
Created: ${new Date(job.createdAt).toLocaleString()}

Recent runs (${runs.length}):
${
  runs
    .map(
      (r) =>
        `- ${r.status} at ${new Date(r.startedAt).toLocaleString()}${r.durationMs ? ` (${r.durationMs}ms)` : ''}`,
    )
    .join('\n') || 'None'
}`

      return {
        content: [{ type: 'text' as const, text: details }],
      }
    },
  ),
]
