import cron, { type ScheduledTask } from 'node-cron'
import type { CoreEngine } from '../core/index.js'
import type { CronJob } from '../types/index.js'
import { CronStore } from './store.js'
import { CronHistory } from './history.js'

// ── setTimeout max delay: ~24.8 days (2^31 - 1 ms) ──────────────────────
const MAX_TIMEOUT_MS = 2_147_483_647

type ScheduledJob =
  | { kind: 'cron'; job: CronJob; task: ScheduledTask }
  | { kind: 'timer'; job: CronJob; timer: NodeJS.Timeout }

export class CronScheduler {
  private scheduledJobs = new Map<string, ScheduledJob>()
  private store: CronStore
  private history: CronHistory

  constructor(private core: CoreEngine) {
    this.store = new CronStore()
    this.history = new CronHistory()
  }

  async init(): Promise<void> {
    const jobs = await this.store.loadAll()
    for (const job of jobs) {
      if (!job.enabled) continue

      const jobType = job.type || 'cron'
      if (jobType === 'at' && job.runAt) {
        // One-shot: check if it needs catch-up
        const alreadyRan = job.lastRunAt && job.lastRunAt >= job.runAt
        if (alreadyRan) {
          // Already executed — auto-disable
          job.enabled = false
          await this.store.save(job)
          continue
        }
        if (job.runAt <= Date.now()) {
          // Missed execution — run immediately, then disable
          console.log(`[Cron] Catch-up: one-shot job "${job.name}" (${job.id}) was due at ${new Date(job.runAt).toISOString()}`)
          this.executeJob(job).then(async () => {
            job.enabled = false
            await this.store.save(job)
            this.scheduledJobs.delete(job.id)
          })
          continue
        }
        // Future one-shot — schedule normally
        this.schedule(job)
      } else {
        // Recurring cron — schedule as before
        this.schedule(job)
      }
    }
  }

  /** Schedule a job (cron or one-shot) */
  schedule(job: CronJob): void {
    const jobType = job.type || 'cron'
    if (jobType === 'at') {
      this.scheduleOneShot(job)
    } else {
      this.scheduleCron(job)
    }
  }

  /** Schedule a recurring cron job */
  private scheduleCron(job: CronJob): void {
    if (!cron.validate(job.schedule)) {
      console.error(`[Cron] Invalid schedule for job ${job.id}: ${job.schedule}`)
      return
    }

    this.cancel(job.id)

    const task = cron.schedule(job.schedule, async () => {
      await this.executeJob(job)
    })

    this.scheduledJobs.set(job.id, { kind: 'cron', job, task })
  }

  /** Schedule a one-shot job using setTimeout */
  private scheduleOneShot(job: CronJob): void {
    if (!job.runAt) {
      console.error(`[Cron] One-shot job ${job.id} missing runAt`)
      return
    }

    this.cancel(job.id)

    const delay = Math.max(0, job.runAt - Date.now())

    // Handle delays exceeding setTimeout max (~24.8 days) by chaining
    if (delay > MAX_TIMEOUT_MS) {
      const timer = setTimeout(() => {
        this.scheduledJobs.delete(job.id)
        this.scheduleOneShot(job) // Re-check remaining delay
      }, MAX_TIMEOUT_MS)
      this.scheduledJobs.set(job.id, { kind: 'timer', job, timer })
      return
    }

    const timer = setTimeout(async () => {
      await this.executeJob(job)
      // Auto-disable after execution
      job.enabled = false
      await this.store.save(job)
      this.scheduledJobs.delete(job.id)
    }, delay)

    this.scheduledJobs.set(job.id, { kind: 'timer', job, timer })
  }

  /** Execute a cron job */
  private async executeJob(job: CronJob): Promise<void> {
    const execution = {
      jobId: job.id,
      jobName: job.name,
      projectId: job.projectId,
      sessionId: job.sessionId,
      execSessionId: '',  // Will be filled by session creation
      startedAt: Date.now(),
    }

    try {
      await this.core.submitTurn({
        projectId: job.projectId,
        sessionId: job.sessionId,
        prompt: job.prompt,
        type: 'cron',
        metadata: {
          cronJobId: job.id,
          cronJobName: job.name,
        },
      })

      // Update last run
      job.lastRunAt = Date.now()
      job.lastRunStatus = 'success'
      await this.store.save(job)

      // Log execution
      await this.history.log({
        ...execution,
        completedAt: Date.now(),
        success: true,
      })
    } catch (err: any) {
      job.lastRunAt = Date.now()
      job.lastRunStatus = 'failure'
      await this.store.save(job)

      await this.history.log({
        ...execution,
        completedAt: Date.now(),
        success: false,
        error: err.message,
      })
    }
  }

  /** Cancel a scheduled job */
  cancel(jobId: string): void {
    const scheduled = this.scheduledJobs.get(jobId)
    if (scheduled) {
      if (scheduled.kind === 'cron') {
        scheduled.task.stop()
      } else {
        clearTimeout(scheduled.timer)
      }
      this.scheduledJobs.delete(jobId)
    }
  }

  /** Pause a job (stop scheduling but keep config) */
  async pause(jobId: string): Promise<void> {
    this.cancel(jobId)
    const job = await this.store.get(jobId)
    if (job) {
      job.enabled = false
      await this.store.save(job)
    }
  }

  /** Resume a paused job */
  async resume(jobId: string): Promise<void> {
    const job = await this.store.get(jobId)
    if (job) {
      const jobType = job.type || 'cron'
      if (jobType === 'at' && job.runAt && job.runAt <= Date.now()) {
        throw new Error('Cannot resume a one-shot task whose scheduled time has already passed.')
      }
      job.enabled = true
      await this.store.save(job)
      this.schedule(job)
    }
  }

  /** Trigger a job immediately (outside of schedule) */
  async trigger(jobId: string): Promise<void> {
    const job = await this.store.get(jobId)
    if (job) {
      await this.executeJob(job)
    }
  }

  /** Create a new cron job */
  async create(params: Omit<CronJob, 'id' | 'createdAt' | 'updatedAt'>): Promise<CronJob> {
    const job: CronJob = {
      ...params,
      id: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.store.save(job)
    if (job.enabled) {
      this.schedule(job)
    }
    return job
  }

  /** Get a single cron job by ID */
  async get(jobId: string): Promise<CronJob | null> {
    return this.store.get(jobId)
  }

  /** Update a cron job (partial fields). Reschedules if schedule/runAt changed. */
  async update(jobId: string, params: { name?: string; prompt?: string; schedule?: string; runAt?: number }): Promise<CronJob | null> {
    const job = await this.store.get(jobId)
    if (!job) return null

    if (params.name !== undefined) job.name = params.name
    if (params.prompt !== undefined) job.prompt = params.prompt

    let needsReschedule = false
    const jobType = job.type || 'cron'

    if (jobType === 'cron' && params.schedule !== undefined && params.schedule !== job.schedule) {
      job.schedule = params.schedule
      needsReschedule = true
    }
    if (jobType === 'at' && params.runAt !== undefined && params.runAt !== job.runAt) {
      job.runAt = params.runAt
      needsReschedule = true
    }

    job.updatedAt = Date.now()
    await this.store.save(job)

    if (needsReschedule && job.enabled) {
      this.cancel(jobId)
      this.schedule(job)
    }

    return job
  }

  /** Delete a cron job */
  async delete(jobId: string): Promise<void> {
    this.cancel(jobId)
    await this.store.delete(jobId)
  }

  /** List all jobs, optionally filtered by projectId */
  async list(projectId?: string): Promise<CronJob[]> {
    const jobs = await this.store.loadAll()
    if (projectId) {
      return jobs.filter(j => j.projectId === projectId)
    }
    return jobs
  }

  /** Get execution history for a job */
  async getHistory(jobId: string, limit = 50): Promise<any[]> {
    return this.history.getForJob(jobId, limit)
  }

  /** Stop all scheduled jobs */
  destroy(): void {
    for (const [, scheduled] of this.scheduledJobs) {
      if (scheduled.kind === 'cron') {
        scheduled.task.stop()
      } else {
        clearTimeout(scheduled.timer)
      }
    }
    this.scheduledJobs.clear()
  }
}

export function initCronScheduler(core: CoreEngine): CronScheduler {
  const scheduler = new CronScheduler(core)
  scheduler.init().catch(err => {
    console.error('[Cron] Failed to initialize:', err.message)
  })
  return scheduler
}
