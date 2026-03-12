// Cron Scheduler — manages scheduling and triggering of cron jobs

import * as cron from 'node-cron'
import * as chrono from 'chrono-node'
import type { CronJob, CronSchedule } from './types.js'
import { loadJobs, saveJob, deleteJob, generateRunId, appendRun } from './store.js'

export type JobExecutor = (job: CronJob, runId: string) => Promise<void>

interface ScheduledTask {
  jobId: string
  task?: cron.ScheduledTask
  timeoutId?: NodeJS.Timeout
}

export class CronScheduler {
  private scheduledTasks = new Map<string, ScheduledTask>()
  private executor: JobExecutor
  private isRunning = false

  constructor(executor: JobExecutor) {
    this.executor = executor
  }

  start(): void {
    if (this.isRunning) return
    this.isRunning = true

    console.log('[CronScheduler] Starting...')
    const jobs = loadJobs()

    for (const job of jobs.values()) {
      if (job.status !== 'disabled') {
        this.scheduleJob(job)
      }
    }

    console.log(`[CronScheduler] Loaded ${this.scheduledTasks.size} jobs`)
  }

  stop(): void {
    console.log('[CronScheduler] Stopping...')
    for (const scheduled of this.scheduledTasks.values()) {
      scheduled.task?.stop()
      if (scheduled.timeoutId) {
        clearTimeout(scheduled.timeoutId)
      }
    }
    this.scheduledTasks.clear()
    this.isRunning = false
  }

  scheduleJob(job: CronJob): boolean {
    console.log(`[Scheduler] Scheduling job: ${job.id} (${job.name})`)

    // Cancel any existing schedule
    this.cancelSchedule(job.id)

    const nextRun = this.calculateNextRun(job.schedule)
    if (!nextRun) {
      console.warn(`[Scheduler] Cannot calculate next run for job ${job.id}`)
      return false
    }

    job.nextRunAt = nextRun.toISOString()
    saveJob(job)

    if (job.schedule.kind === 'at') {
      const delay = nextRun.getTime() - Date.now()

      if (delay <= 0) {
        this.triggerJob(job)
      } else {
        const timeoutId = setTimeout(() => this.triggerJob(job), delay)
        this.scheduledTasks.set(job.id, { jobId: job.id, timeoutId })
      }
    } else if (job.schedule.kind === 'cron') {
      const cronExpr = job.schedule.expr
      if (!cron.validate(cronExpr)) {
        console.error(`[Scheduler] Invalid cron expression: ${cronExpr}`)
        return false
      }

      const task = cron.schedule(cronExpr, () => this.triggerJob(job), {
        timezone: job.schedule.tz,
      })

      this.scheduledTasks.set(job.id, { jobId: job.id, task })
    } else if (job.schedule.kind === 'every') {
      // For "every" schedules, use setInterval-style via repeated setTimeout
      const timeoutId = setTimeout(() => this.triggerJob(job), job.schedule.everyMs)
      this.scheduledTasks.set(job.id, { jobId: job.id, timeoutId })
    }

    return true
  }

  cancelSchedule(jobId: string): void {
    const scheduled = this.scheduledTasks.get(jobId)
    if (scheduled) {
      scheduled.task?.stop()
      if (scheduled.timeoutId) {
        clearTimeout(scheduled.timeoutId)
      }
      this.scheduledTasks.delete(jobId)
    }
  }

  private async triggerJob(job: CronJob): Promise<void> {
    const runId = generateRunId()
    console.log(`[Scheduler] Triggering job: ${job.id} (${job.name}), runId=${runId}`)

    job.status = 'running'
    job.lastRunAt = new Date().toISOString()
    saveJob(job)

    appendRun(job.id, {
      id: runId,
      jobId: job.id,
      startedAt: new Date().toISOString(),
      status: 'running',
    })

    try {
      await this.executor(job, runId)

      job.runCount++
      job.status = 'pending'

      if (job.deleteAfterRun && job.schedule.kind === 'at') {
        console.log(`[Scheduler] One-shot job complete, deleting: ${job.id}`)
        deleteJob(job.id)
        this.cancelSchedule(job.id)
        return
      }

      if (job.maxRuns && job.runCount >= job.maxRuns) {
        job.status = 'disabled'
        this.cancelSchedule(job.id)
      }

      saveJob(job)

      // Reschedule if recurring
      if (
        job.status === 'pending' &&
        (job.schedule.kind === 'cron' || job.schedule.kind === 'every')
      ) {
        this.scheduleJob(job)
      }
    } catch (err) {
      console.error(`[Scheduler] Job ${job.id} execution failed:`, err)
      job.status = 'failed'
      saveJob(job)

      appendRun(job.id, {
        id: runId,
        jobId: job.id,
        startedAt: job.lastRunAt!,
        endedAt: new Date().toISOString(),
        status: 'failed',
        error: String(err),
      })
    }
  }

  private calculateNextRun(schedule: CronSchedule): Date | null {
    const now = new Date()

    switch (schedule.kind) {
      case 'at': {
        const date = new Date(schedule.at)
        return isNaN(date.getTime()) ? null : date
      }
      case 'every': {
        return new Date(now.getTime() + schedule.everyMs)
      }
      case 'cron': {
        return new Date(now.getTime() + 60000)
      }
      default:
        return null
    }
  }

  static parseTime(input: string, referenceDate: Date = new Date()): Date | null {
    // Try ISO format first
    const iso = new Date(input)
    if (!isNaN(iso.getTime())) {
      return iso
    }

    // Try chrono-node for natural language
    const parsed = chrono.parseDate(input, referenceDate)
    return parsed
  }

  static parseSchedule(
    when: string,
    recurring: boolean = false,
  ): { schedule: CronSchedule; isValid: boolean } {
    // Check if it's a cron expression
    if (recurring && cron.validate(when)) {
      return { schedule: { kind: 'cron', expr: when }, isValid: true }
    }

    // Check for "every X minutes/hours/days" pattern
    const everyMatch = when.match(/every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)/i)
    if (everyMatch && recurring) {
      const num = parseInt(everyMatch[1])
      const unit = everyMatch[2].toLowerCase()
      let ms = num * 60 * 1000
      if (unit.startsWith('hour')) ms = num * 60 * 60 * 1000
      if (unit.startsWith('day')) ms = num * 24 * 60 * 60 * 1000
      return { schedule: { kind: 'every', everyMs: ms }, isValid: true }
    }

    // Try parsing as absolute time
    const parsed = this.parseTime(when)
    if (parsed) {
      return {
        schedule: { kind: 'at', at: parsed.toISOString() },
        isValid: true,
      }
    }

    return { schedule: { kind: 'at', at: '' }, isValid: false }
  }
}
