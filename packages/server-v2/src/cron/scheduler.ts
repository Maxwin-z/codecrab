import cron, { type ScheduledTask } from 'node-cron'
import type { CoreEngine } from '../core/index.js'
import type { CronJob } from '../types/index.js'
import { CronStore } from './store.js'
import { CronHistory } from './history.js'

interface ScheduledJob {
  job: CronJob
  task: ScheduledTask
}

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
      if (job.enabled) {
        this.schedule(job)
      }
    }
  }

  /** Schedule a cron job */
  schedule(job: CronJob): void {
    // Validate cron expression
    if (!cron.validate(job.schedule)) {
      console.error(`[Cron] Invalid schedule for job ${job.id}: ${job.schedule}`)
      return
    }

    // Cancel existing if re-scheduling
    this.cancel(job.id)

    const task = cron.schedule(job.schedule, async () => {
      await this.executeJob(job)
    })

    this.scheduledJobs.set(job.id, { job, task })
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
      scheduled.task.stop()
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
      scheduled.task.stop()
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
