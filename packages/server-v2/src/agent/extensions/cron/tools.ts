// Cron MCP tool definitions for the Claude Agent SDK (server-v2)
//
// Provides 8 tools: create, list, get, delete, pause, resume, update, trigger.
// The scheduler and per-query context are injected via setters at startup / per-query.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import cron from 'node-cron'
import type { CronScheduler } from '../../../cron/scheduler.js'
import type { CronJob } from '../../../types/index.js'

// ── Injected state ─────────────────────────────────────────────────────────

let scheduler: CronScheduler | null = null
let queryContext: { projectId?: string; sessionId?: string } = {}

export function setCronScheduler(s: CronScheduler): void {
  scheduler = s
}

export function setCronQueryContext(ctx: { projectId?: string; sessionId?: string }): void {
  queryContext = ctx
}

export function getCronQueryContext(): { projectId?: string; sessionId?: string } {
  return queryContext
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function notReady() {
  return { content: [{ type: 'text' as const, text: 'Cron scheduler not initialized' }], isError: true }
}

function notFound(jobId: string) {
  return { content: [{ type: 'text' as const, text: `Task not found: ${jobId}` }], isError: true }
}

function formatSchedule(schedule: string): string {
  return `cron "${schedule}"`
}

function formatJob(job: CronJob): string {
  const status = job.enabled ? 'active' : 'paused'
  const lastRun = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never'
  return `- ${job.name} (${job.id}): ${formatSchedule(job.schedule)} | ${status} | last run: ${lastRun}`
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const tools = [
  tool(
    'cron_create',
    `Create a scheduled task that will execute automatically on a recurring schedule using a cron expression.

Use this tool when the user asks to:
- Schedule a recurring task (e.g., "check email every hour")
- Set up periodic monitoring (e.g., "every 5 minutes check the logs")
- Create a timed job (e.g., "every day at 9am run the report")

The 'schedule' parameter must be a valid cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am).

CRITICAL - The 'prompt' parameter is the instruction that will be executed when the scheduled time arrives. For reminders, the prompt MUST explicitly instruct the AI to send a push notification using the push_send tool.`,
    {
      name: z.string().describe('A descriptive name for this scheduled task'),
      schedule: z
        .string()
        .describe(
          'Cron expression (e.g., "*/5 * * * *" for every 5 min, "0 9 * * *" for daily at 9am, "0 */2 * * *" for every 2 hours)',
        ),
      prompt: z
        .string()
        .describe('The instruction to execute at the scheduled time'),
      // Context fields — auto-injected via setCronQueryContext fallback
      projectId: z.string().optional().describe('Project ID (auto-injected)'),
      sessionId: z.string().optional().describe('Session ID (auto-injected)'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      if (!cron.validate(input.schedule)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron expression: "${input.schedule}". Use standard cron format, e.g. "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am), "0 0 * * 1" (Monday midnight).`,
            },
          ],
          isError: true,
        }
      }

      const projectId = input.projectId || queryContext.projectId
      const sessionId = input.sessionId || queryContext.sessionId

      if (!projectId || !sessionId) {
        return {
          content: [{ type: 'text' as const, text: 'Missing project or session context. Cannot create scheduled task.' }],
          isError: true,
        }
      }

      const job = await scheduler.create({
        projectId,
        sessionId,
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        enabled: true,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created scheduled task "${job.name}" (${formatSchedule(job.schedule)}).\n\nTask ID: ${job.id}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_list',
    'List all scheduled tasks, optionally filtered by project.',
    {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of tasks to return (default: 20)'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const projectId = queryContext.projectId
      const jobs = await scheduler.list(projectId)
      const limited = jobs.slice(0, input.limit || 20)

      if (limited.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] }
      }

      const formatted = limited.map(formatJob)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${limited.length} scheduled task(s):\n\n${formatted.join('\n')}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_get',
    'Get detailed information about a specific scheduled task.',
    {
      jobId: z.string().describe('The ID of the task'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      const history = await scheduler.getHistory(input.jobId, 5)

      const details = `Task: ${job.name}
ID: ${job.id}
Status: ${job.enabled ? 'active' : 'paused'}
Schedule: ${formatSchedule(job.schedule)}
Prompt: ${job.prompt}
Last run: ${job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never'}
Last run status: ${job.lastRunStatus || 'N/A'}
Created: ${new Date(job.createdAt).toLocaleString()}

Recent executions (${history.length}):
${
  history
    .map(
      (h) =>
        `- ${h.success ? 'success' : 'failed'} at ${new Date(h.startedAt).toLocaleString()}${h.error ? ` (${h.error})` : ''}`,
    )
    .join('\n') || 'None'
}`

      return { content: [{ type: 'text' as const, text: details }] }
    },
  ),

  tool(
    'cron_delete',
    'Delete a scheduled task by its ID. The task will be permanently removed.',
    {
      jobId: z.string().describe('The ID of the task to delete'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      await scheduler.delete(input.jobId)

      return {
        content: [
          { type: 'text' as const, text: `Deleted scheduled task "${job.name}" (${job.id}).` },
        ],
      }
    },
  ),

  tool(
    'cron_pause',
    'Pause (disable) a scheduled task. The task will stop executing but can be resumed later.',
    {
      jobId: z.string().describe('The ID of the task to pause'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      if (!job.enabled) {
        return {
          content: [{ type: 'text' as const, text: `Task "${job.name}" is already paused.` }],
        }
      }

      await scheduler.pause(input.jobId)

      return {
        content: [
          { type: 'text' as const, text: `Paused task "${job.name}" (${job.id}). Use cron_resume to re-enable it.` },
        ],
      }
    },
  ),

  tool(
    'cron_resume',
    'Resume a paused (disabled) scheduled task. The task will be rescheduled according to its original schedule.',
    {
      jobId: z.string().describe('The ID of the task to resume'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      if (job.enabled) {
        return {
          content: [
            { type: 'text' as const, text: `Task "${job.name}" is already active (not paused).` },
          ],
        }
      }

      await scheduler.resume(input.jobId)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Resumed task "${job.name}" (${job.id}).\nSchedule: ${formatSchedule(job.schedule)}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_update',
    'Update an existing scheduled task. Only provide the fields you want to change.',
    {
      jobId: z.string().describe('The ID of the task to update'),
      name: z.string().optional().describe('New name for the task'),
      prompt: z.string().optional().describe('New prompt/instruction for the task'),
      schedule: z
        .string()
        .optional()
        .describe('New cron expression (e.g., "0 9 * * *")'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      if (input.schedule && !cron.validate(input.schedule)) {
        return {
          content: [
            { type: 'text' as const, text: `Invalid cron expression: "${input.schedule}".` },
          ],
          isError: true,
        }
      }

      const changes: string[] = []
      if (input.name !== undefined) changes.push(`name → "${input.name}"`)
      if (input.prompt !== undefined) changes.push('prompt updated')
      if (input.schedule !== undefined) changes.push(`schedule → ${formatSchedule(input.schedule)}`)

      if (changes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No changes specified.' }], isError: true }
      }

      await scheduler.update(input.jobId, {
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated task "${job.name}" (${job.id}):\n${changes.map((c) => `  • ${c}`).join('\n')}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_trigger',
    'Manually trigger a scheduled task to run immediately, regardless of its schedule. The task remains scheduled as before.',
    {
      jobId: z.string().describe('The ID of the task to trigger'),
    },
    async (input) => {
      if (!scheduler) return notReady()

      const job = await scheduler.get(input.jobId)
      if (!job) return notFound(input.jobId)

      await scheduler.trigger(input.jobId)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Triggered task "${job.name}" (${job.id}) for immediate execution.`,
          },
        ],
      }
    },
  ),
]
