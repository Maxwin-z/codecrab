import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CronScheduler } from '../scheduler.js'
import type { CoreEngine } from '../../core/index.js'
import type { CronJob } from '../../types/index.js'

function createMockCore(): CoreEngine {
  const core = {
    submitTurn: vi.fn().mockResolvedValue('query-123'),
    projects: { get: vi.fn(), getPath: vi.fn(), list: vi.fn() },
    sessions: { getMeta: vi.fn() },
    on: vi.fn(),
    emit: vi.fn(),
  }
  return core as any
}

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    name: 'Test Job',
    schedule: '* * * * *',  // every minute
    prompt: 'Run tests',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('CronScheduler', () => {
  let core: CoreEngine
  let scheduler: CronScheduler
  let tmpDir: string

  beforeEach(async () => {
    core = createMockCore()
    scheduler = new CronScheduler(core)

    // Create a temp directory for store/history
    tmpDir = await mkdtemp(join(tmpdir(), 'cron-test-'))

    // Override the internal store and history to use temp dir
    ;(scheduler as any).store = new (await import('../store.js')).CronStore(join(tmpDir, 'jobs'))
    ;(scheduler as any).history = new (await import('../history.js')).CronHistory(join(tmpDir, 'history'))
  })

  afterEach(async () => {
    scheduler.destroy()
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('schedule', () => {
    it('should register a cron job with a valid expression', () => {
      const job = makeCronJob()
      scheduler.schedule(job)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(true)
    })

    it('should reject an invalid cron expression', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const job = makeCronJob({ schedule: 'not-a-cron' })
      scheduler.schedule(job)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(false)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Cron] Invalid schedule'),
      )
      consoleSpy.mockRestore()
    })

    it('should cancel existing schedule when re-scheduling same job', () => {
      const job = makeCronJob()
      scheduler.schedule(job)
      scheduler.schedule(job)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.size).toBe(1)
    })
  })

  describe('cancel', () => {
    it('should stop a scheduled job', () => {
      const job = makeCronJob()
      scheduler.schedule(job)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(true)

      scheduler.cancel(job.id)
      expect(scheduledJobs.has(job.id)).toBe(false)
    })

    it('should be a no-op for non-existent job', () => {
      // Should not throw
      scheduler.cancel('non-existent')
    })
  })

  describe('destroy', () => {
    it('should stop all scheduled jobs', () => {
      const job1 = makeCronJob({ id: 'job-1' })
      const job2 = makeCronJob({ id: 'job-2' })
      scheduler.schedule(job1)
      scheduler.schedule(job2)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.size).toBe(2)

      scheduler.destroy()
      expect(scheduledJobs.size).toBe(0)
    })
  })

  describe('executeJob', () => {
    it('should call core.submitTurn with correct params', async () => {
      const job = makeCronJob({
        projectId: 'proj-test',
        sessionId: 'sess-test',
        prompt: 'Do the thing',
        name: 'My Cron',
      })

      // Access private method via prototype
      await (scheduler as any).executeJob(job)

      expect((core.submitTurn as any)).toHaveBeenCalledWith({
        projectId: 'proj-test',
        sessionId: 'sess-test',
        prompt: 'Do the thing',
        type: 'cron',
        metadata: {
          cronJobId: job.id,
          cronJobName: 'My Cron',
        },
      })
    })

    it('should update lastRunStatus to success on success', async () => {
      const job = makeCronJob()
      ;(core.submitTurn as any).mockResolvedValue('query-ok')

      await (scheduler as any).executeJob(job)

      expect(job.lastRunStatus).toBe('success')
      expect(job.lastRunAt).toBeDefined()
    })

    it('should update lastRunStatus to failure on error', async () => {
      const job = makeCronJob()
      ;(core.submitTurn as any).mockRejectedValue(new Error('boom'))

      await (scheduler as any).executeJob(job)

      expect(job.lastRunStatus).toBe('failure')
      expect(job.lastRunAt).toBeDefined()
    })
  })

  describe('pause', () => {
    it('should disable a job and stop scheduling', async () => {
      const job = makeCronJob()
      // Save the job first so pause can find it
      await (scheduler as any).store.save(job)
      scheduler.schedule(job)

      await scheduler.pause(job.id)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(false)

      const stored = await (scheduler as any).store.get(job.id)
      expect(stored.enabled).toBe(false)
    })
  })

  describe('resume', () => {
    it('should re-enable and re-schedule a paused job', async () => {
      const job = makeCronJob({ enabled: false })
      await (scheduler as any).store.save(job)

      await scheduler.resume(job.id)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(true)

      const stored = await (scheduler as any).store.get(job.id)
      expect(stored.enabled).toBe(true)
    })
  })

  describe('create', () => {
    it('should generate an ID and save to store', async () => {
      const created = await scheduler.create({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        name: 'New Job',
        schedule: '*/5 * * * *',
        prompt: 'Check status',
        enabled: true,
      })

      expect(created.id).toMatch(/^cron-/)
      expect(created.name).toBe('New Job')
      expect(created.createdAt).toBeDefined()

      const stored = await (scheduler as any).store.get(created.id)
      expect(stored).not.toBeNull()
      expect(stored.name).toBe('New Job')
    })

    it('should schedule the job if enabled', async () => {
      const created = await scheduler.create({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        name: 'Enabled Job',
        schedule: '*/10 * * * *',
        prompt: 'Run',
        enabled: true,
      })

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(created.id)).toBe(true)
    })

    it('should not schedule the job if disabled', async () => {
      const created = await scheduler.create({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        name: 'Disabled Job',
        schedule: '*/10 * * * *',
        prompt: 'Run',
        enabled: false,
      })

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(created.id)).toBe(false)
    })
  })

  describe('delete', () => {
    it('should cancel and remove from store', async () => {
      const job = makeCronJob()
      await (scheduler as any).store.save(job)
      scheduler.schedule(job)

      await scheduler.delete(job.id)

      const scheduledJobs = (scheduler as any).scheduledJobs as Map<string, any>
      expect(scheduledJobs.has(job.id)).toBe(false)

      const stored = await (scheduler as any).store.get(job.id)
      expect(stored).toBeNull()
    })
  })

  describe('list', () => {
    it('should return all jobs', async () => {
      const job1 = makeCronJob({ id: 'job-a', projectId: 'proj-1' })
      const job2 = makeCronJob({ id: 'job-b', projectId: 'proj-2' })
      await (scheduler as any).store.save(job1)
      await (scheduler as any).store.save(job2)

      const all = await scheduler.list()
      expect(all).toHaveLength(2)
    })

    it('should filter by projectId', async () => {
      const job1 = makeCronJob({ id: 'job-a', projectId: 'proj-1' })
      const job2 = makeCronJob({ id: 'job-b', projectId: 'proj-2' })
      await (scheduler as any).store.save(job1)
      await (scheduler as any).store.save(job2)

      const filtered = await scheduler.list('proj-1')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projectId).toBe('proj-1')
    })
  })
})
