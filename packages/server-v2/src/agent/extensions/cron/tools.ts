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

function formatScheduleStr(job: CronJob): string {
  const jobType = job.type || 'cron'
  if (jobType === 'at' && job.runAt) {
    return `one-time at ${new Date(job.runAt).toLocaleString()}`
  }
  return `cron "${job.schedule}"`
}

function formatJob(job: CronJob): string {
  const jobType = job.type || 'cron'
  let status: string
  if (jobType === 'at' && !job.enabled && job.lastRunAt) {
    status = 'completed'
  } else {
    status = job.enabled ? 'active' : 'paused'
  }
  const lastRun = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never'
  return `- ${job.name} (${job.id}): ${formatScheduleStr(job)} | ${status} | last run: ${lastRun}`
}

/**
 * Parse a human-readable delay string (e.g., "5m", "1h", "30s", "2d") into milliseconds.
 */
function parseDelay(delay: string): number {
  const match = delay.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i)
  if (!match) throw new Error(`Invalid delay format: "${delay}". Use e.g. "5m", "1h", "30s", "2d".`)
  const value = parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = {
    s: 1000, sec: 1000,
    m: 60_000, min: 60_000,
    h: 3_600_000, hr: 3_600_000,
    d: 86_400_000, day: 86_400_000,
  }
  return Math.round(value * multipliers[unit])
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const tools = [
  tool(
    'cron_create',
    `Create a scheduled task. Supports three scheduling modes (provide exactly one):
- 'schedule': Recurring cron expression (e.g., "*/5 * * * *" for every 5 min, "0 9 * * *" for daily 9am)
- 'runAt': One-time execution at a specific time (ISO 8601, e.g., "2026-03-27T15:30:00+08:00")
- 'delay': One-time execution after a delay from now (e.g., "30s", "5m", "1h", "2d")

For one-time reminders or delayed tasks, use 'delay' or 'runAt' — do NOT use 'schedule' for one-shot tasks.

CRITICAL - The 'prompt' parameter is the instruction that will be executed when the scheduled time arrives. For reminders, the prompt MUST explicitly instruct the AI to send a push notification using the push_send tool.`,
    {
      name: z.string().describe('A descriptive name for this scheduled task'),
      schedule: z
        .string()
        .optional()
        .describe(
          'Cron expression for recurring tasks (e.g., "*/5 * * * *" for every 5 min, "0 9 * * *" for daily at 9am)',
        ),
      runAt: z
        .string()
        .optional()
        .describe(
          'ISO 8601 timestamp for one-time execution (e.g., "2026-03-27T15:30:00+08:00")',
        ),
      delay: z
        .string()
        .optional()
        .describe(
          'Delay before one-time execution (e.g., "30s", "5m", "1h", "2d")',
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

      // Validate exactly one scheduling mode
      const modes = [input.schedule, input.runAt, input.delay].filter(Boolean)
      if (modes.length !== 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Provide exactly one of: schedule, runAt, or delay.',
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

      // ── Recurring cron ──────────────────────────────────────────────
      if (input.schedule) {
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

        const job = await scheduler.create({
          projectId,
          sessionId,
          name: input.name,
          schedule: input.schedule,
          prompt: input.prompt,
          enabled: true,
          type: 'cron',
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: `Created recurring task "${job.name}" (cron "${job.schedule}").\n\nTask ID: ${job.id}`,
            },
          ],
        }
      }

      // ── One-shot: resolve runAt ─────────────────────────────────────
      let runAtMs: number

      if (input.runAt) {
        const parsed = new Date(input.runAt)
        if (isNaN(parsed.getTime())) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid timestamp: "${input.runAt}". Use ISO 8601 format, e.g. "2026-03-27T15:30:00+08:00".`,
              },
            ],
            isError: true,
          }
        }
        runAtMs = parsed.getTime()
      } else {
        // delay
        try {
          const delayMs = parseDelay(input.delay!)
          runAtMs = Date.now() + delayMs
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: err.message }],
            isError: true,
          }
        }
      }

      if (runAtMs <= Date.now()) {
        return {
          content: [{ type: 'text' as const, text: 'The scheduled time must be in the future.' }],
          isError: true,
        }
      }

      const job = await scheduler.create({
        projectId,
        sessionId,
        name: input.name,
        schedule: '', // empty for one-shot
        prompt: input.prompt,
        enabled: true,
        type: 'at',
        runAt: runAtMs,
      })

      const runAtDate = new Date(runAtMs)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created one-time task "${job.name}" scheduled for ${runAtDate.toLocaleString()}.\n\nTask ID: ${job.id}`,
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

      const jobType = job.type || 'cron'
      let statusStr: string
      if (jobType === 'at' && !job.enabled && job.lastRunAt) {
        statusStr = 'completed'
      } else {
        statusStr = job.enabled ? 'active' : 'paused'
      }

      const details = `Task: ${job.name}
ID: ${job.id}
Type: ${jobType === 'at' ? 'one-time' : 'recurring'}
Status: ${statusStr}
Schedule: ${formatScheduleStr(job)}
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

      try {
        await scheduler.resume(input.jobId)
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: err.message }],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Resumed task "${job.name}" (${job.id}).\nSchedule: ${formatScheduleStr(job)}`,
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
        .describe('New cron expression for recurring tasks (e.g., "0 9 * * *")'),
      runAt: z
        .string()
        .optional()
        .describe('New ISO 8601 timestamp for one-time tasks'),
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
      if (input.schedule !== undefined) changes.push(`schedule → cron "${input.schedule}"`)

      // Handle runAt update for one-shot tasks
      let runAtMs: number | undefined
      if (input.runAt !== undefined) {
        const parsed = new Date(input.runAt)
        if (isNaN(parsed.getTime())) {
          return {
            content: [
              { type: 'text' as const, text: `Invalid timestamp: "${input.runAt}". Use ISO 8601 format.` },
            ],
            isError: true,
          }
        }
        runAtMs = parsed.getTime()
        changes.push(`runAt → ${parsed.toLocaleString()}`)
      }

      if (changes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No changes specified.' }], isError: true }
      }

      await scheduler.update(input.jobId, {
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        runAt: runAtMs,
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
