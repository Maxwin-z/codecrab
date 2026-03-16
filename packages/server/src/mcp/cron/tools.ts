// Cron MCP tool definitions for the Claude Agent SDK.
// Follows the same pattern as Chrome MCP tools.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { CronScheduler } from './scheduler.js'
import { saveJob, deleteJob, getJob, listJobs, generateJobId, generateRunId, getRuns } from './store.js'
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
          parentSessionId: sessionId,
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
        .describe('Filter by status: pending, running, completed, failed, disabled, deprecated. Deprecated tasks are hidden by default.'),
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
    'Delete (deprecate) a scheduled task by its ID. The task is marked as deprecated rather than physically removed, preserving it for debugging.',
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

      if (job.status === 'deprecated') {
        return {
          content: [
            { type: 'text' as const, text: `Task "${job.name}" is already deprecated.` },
          ],
        }
      }

      scheduler.cancelSchedule(input.jobId)
      const deleted = deleteJob(input.jobId)

      if (deleted) {
        return {
          content: [
            { type: 'text' as const, text: `Deprecated scheduled task "${job.name}" (${job.id}). The task is preserved for debugging but will no longer execute.` },
          ],
        }
      } else {
        return {
          content: [{ type: 'text' as const, text: 'Failed to deprecate the task' }],
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

  tool(
    'cron_pause',
    'Pause (disable) a scheduled task. The task will stop executing but can be resumed later.',
    {
      jobId: z.string().describe('The ID of the task to pause'),
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
          content: [{ type: 'text' as const, text: `Task not found: ${input.jobId}` }],
          isError: true,
        }
      }

      if (job.status === 'disabled') {
        return {
          content: [{ type: 'text' as const, text: `Task "${job.name}" is already paused.` }],
        }
      }

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'deprecated') {
        return {
          content: [
            { type: 'text' as const, text: `Cannot pause a task with status "${job.status}". Only pending or running tasks can be paused.` },
          ],
          isError: true,
        }
      }

      scheduler.cancelSchedule(job.id)
      job.status = 'disabled'
      job.updatedAt = new Date().toISOString()
      saveJob(job)

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
      if (!scheduler) {
        return {
          content: [{ type: 'text' as const, text: 'Cron scheduler not initialized' }],
          isError: true,
        }
      }

      const job = getJob(input.jobId)
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: `Task not found: ${input.jobId}` }],
          isError: true,
        }
      }

      if (job.status === 'deprecated') {
        return {
          content: [
            { type: 'text' as const, text: `Task "${job.name}" is deprecated and cannot be resumed.` },
          ],
          isError: true,
        }
      }

      if (job.status !== 'disabled' && job.status !== 'failed') {
        return {
          content: [
            { type: 'text' as const, text: `Task "${job.name}" is not paused or failed (current status: ${job.status}).` },
          ],
          isError: true,
        }
      }

      job.status = 'pending'
      job.updatedAt = new Date().toISOString()
      saveJob(job)

      const scheduled = scheduler.scheduleJob(job)
      if (!scheduled) {
        return {
          content: [
            { type: 'text' as const, text: `Resumed task "${job.name}" but failed to reschedule. The schedule may have expired.` },
          ],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Resumed task "${job.name}" (${job.id}).\nSchedule: ${formatSchedule(job.schedule)}\nNext run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'N/A'}`,
          },
        ],
      }
    },
  ),

  tool(
    'cron_update',
    `Update an existing scheduled task. You can modify the name, prompt, description, schedule, and other properties. Only provide the fields you want to change.`,
    {
      jobId: z.string().describe('The ID of the task to update'),
      name: z.string().optional().describe('New name for the task'),
      prompt: z.string().optional().describe('New prompt/instruction for the task'),
      description: z.string().optional().describe('New description'),
      when: z
        .string()
        .optional()
        .describe('New schedule: natural language like "10 minutes later", "every 2 hours", or cron expression'),
      recurring: z.boolean().optional().describe('Whether this is a recurring task'),
      cronExpression: z.string().optional().describe('New cron expression (e.g., "0 9 * * *")'),
      timezone: z.string().optional().describe('New timezone (e.g., "Asia/Shanghai")'),
      deleteAfterRun: z.boolean().optional().describe('Auto-delete after execution'),
      maxRuns: z.number().optional().describe('Maximum number of runs (0 to remove limit)'),
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
          content: [{ type: 'text' as const, text: `Task not found: ${input.jobId}` }],
          isError: true,
        }
      }

      const changes: string[] = []

      if (input.name !== undefined) {
        job.name = input.name
        changes.push(`name → "${input.name}"`)
      }
      if (input.prompt !== undefined) {
        job.prompt = input.prompt
        changes.push('prompt updated')
      }
      if (input.description !== undefined) {
        job.description = input.description
        changes.push('description updated')
      }
      if (input.deleteAfterRun !== undefined) {
        job.deleteAfterRun = input.deleteAfterRun
        changes.push(`deleteAfterRun → ${input.deleteAfterRun}`)
      }
      if (input.maxRuns !== undefined) {
        job.maxRuns = input.maxRuns === 0 ? undefined : input.maxRuns
        changes.push(`maxRuns → ${input.maxRuns === 0 ? 'unlimited' : input.maxRuns}`)
      }

      // Handle schedule change
      let scheduleChanged = false
      if (input.when || input.cronExpression) {
        const isRecurring = input.recurring ?? (job.schedule.kind === 'cron' || job.schedule.kind === 'every')
        const scheduleInput = input.cronExpression || input.when!
        const parsed = CronScheduler.parseSchedule(scheduleInput, isRecurring)

        if (!parsed.isValid) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Could not parse schedule: "${input.when || input.cronExpression}". Try formats like "10 minutes later", "every 2 hours", or cron expression "0 9 * * *"`,
              },
            ],
            isError: true,
          }
        }

        if (parsed.schedule.kind === 'at') {
          const runTime = new Date(parsed.schedule.at)
          if (runTime.getTime() <= Date.now()) {
            return {
              content: [
                { type: 'text' as const, text: `Scheduled time is in the past. Please specify a future time.` },
              ],
              isError: true,
            }
          }
        }

        if (input.timezone && parsed.schedule.kind === 'cron') {
          parsed.schedule.tz = input.timezone
        }

        job.schedule = parsed.schedule
        scheduleChanged = true
        changes.push(`schedule → ${formatSchedule(job.schedule)}`)
      } else if (input.timezone && job.schedule.kind === 'cron') {
        job.schedule.tz = input.timezone
        scheduleChanged = true
        changes.push(`timezone → ${input.timezone}`)
      }

      if (changes.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No changes specified.' }],
          isError: true,
        }
      }

      job.updatedAt = new Date().toISOString()
      saveJob(job)

      // Reschedule if schedule changed and job is active
      if (scheduleChanged && (job.status === 'pending' || job.status === 'running')) {
        scheduler.cancelSchedule(job.id)
        scheduler.scheduleJob(job)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated task "${job.name}" (${job.id}):\n${changes.map((c) => `  • ${c}`).join('\n')}${
              scheduleChanged && job.nextRunAt
                ? `\nNext run: ${new Date(job.nextRunAt).toLocaleString()}`
                : ''
            }`,
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
      if (!scheduler) {
        return {
          content: [{ type: 'text' as const, text: 'Cron scheduler not initialized' }],
          isError: true,
        }
      }

      const job = getJob(input.jobId)
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: `Task not found: ${input.jobId}` }],
          isError: true,
        }
      }

      if (job.status === 'running') {
        return {
          content: [
            { type: 'text' as const, text: `Task "${job.name}" is already running. Wait for it to complete.` },
          ],
          isError: true,
        }
      }

      scheduler.triggerNow(job)

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
