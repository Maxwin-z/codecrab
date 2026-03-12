import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronScheduler } from '../scheduler.js'
import * as store from '../store.js'
import type { CronJob } from '../types.js'

// Mock store to avoid touching filesystem
vi.mock('../store.js', async () => {
  const actual = await vi.importActual<typeof import('../store.js')>('../store.js')
  return {
    ...actual,
    loadJobs: vi.fn(() => new Map()),
    saveJob: vi.fn(),
    deleteJob: vi.fn(() => true),
    appendRun: vi.fn(),
    generateRunId: actual.generateRunId,
  }
})

function createTestJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Job',
    schedule: { kind: 'at', at: new Date(Date.now() + 60000).toISOString() },
    prompt: 'Test prompt',
    context: {},
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  }
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler
  let executor: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    executor = vi.fn().mockResolvedValue(undefined)
    scheduler = new CronScheduler(executor)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('parseSchedule', () => {
    it('should parse "5 minutes from now" as an absolute time', () => {
      const result = CronScheduler.parseSchedule('5 minutes from now')
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('at')
    })

    it('should parse "tomorrow at 9am" as an absolute time', () => {
      const result = CronScheduler.parseSchedule('tomorrow at 9am')
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('at')
    })

    it('should parse cron expression for recurring', () => {
      const result = CronScheduler.parseSchedule('0 9 * * *', true)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('cron')
      if (result.schedule.kind === 'cron') {
        expect(result.schedule.expr).toBe('0 9 * * *')
      }
    })

    it('should parse "every 5 minutes" for recurring', () => {
      const result = CronScheduler.parseSchedule('every 5 minutes', true)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('every')
      if (result.schedule.kind === 'every') {
        expect(result.schedule.everyMs).toBe(5 * 60 * 1000)
      }
    })

    it('should parse "every 2 hours" for recurring', () => {
      const result = CronScheduler.parseSchedule('every 2 hours', true)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('every')
      if (result.schedule.kind === 'every') {
        expect(result.schedule.everyMs).toBe(2 * 60 * 60 * 1000)
      }
    })

    it('should parse ISO timestamp', () => {
      const future = new Date(Date.now() + 3600000).toISOString()
      const result = CronScheduler.parseSchedule(future)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe('at')
    })

    it('should return invalid for unparseable input', () => {
      const result = CronScheduler.parseSchedule('xyzzy gobbledygook')
      expect(result.isValid).toBe(false)
    })
  })

  describe('parseTime', () => {
    it('should parse ISO string', () => {
      const iso = '2026-06-15T10:00:00Z'
      const result = CronScheduler.parseTime(iso)
      expect(result).toBeInstanceOf(Date)
      expect(result!.getTime()).toBe(new Date(iso).getTime())
    })

    it('should parse natural language', () => {
      const ref = new Date('2026-03-12T12:00:00Z')
      const result = CronScheduler.parseTime('tomorrow at 9am', ref)
      expect(result).toBeInstanceOf(Date)
      expect(result!.getTime()).toBeGreaterThan(ref.getTime())
    })

    it('should return null for invalid input', () => {
      const result = CronScheduler.parseTime('not a date at all xyz')
      expect(result).toBeNull()
    })
  })

  describe('scheduleJob', () => {
    it('should schedule a one-time job', () => {
      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 5000).toISOString() },
      })

      const result = scheduler.scheduleJob(job)
      expect(result).toBe(true)
      expect(store.saveJob).toHaveBeenCalled()
    })

    it('should execute a one-time job when time arrives', async () => {
      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 5000).toISOString() },
      })

      scheduler.scheduleJob(job)

      // Advance time past the scheduled time
      await vi.advanceTimersByTimeAsync(6000)

      expect(executor).toHaveBeenCalledOnce()
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), expect.any(String))
    })

    it('should not execute a job before its scheduled time', async () => {
      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 10000).toISOString() },
      })

      scheduler.scheduleJob(job)

      await vi.advanceTimersByTimeAsync(5000)
      expect(executor).not.toHaveBeenCalled()
    })

    it('should cancel a scheduled job', () => {
      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 5000).toISOString() },
      })

      scheduler.scheduleJob(job)
      scheduler.cancelSchedule(job.id)

      vi.advanceTimersByTime(10000)
      expect(executor).not.toHaveBeenCalled()
    })

    it('should delete one-shot job after execution', async () => {
      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 1000).toISOString() },
        deleteAfterRun: true,
      })

      scheduler.scheduleJob(job)
      await vi.advanceTimersByTimeAsync(2000)

      expect(executor).toHaveBeenCalledOnce()
      expect(store.deleteJob).toHaveBeenCalledWith(job.id)
    })

    it('should handle executor failure gracefully', async () => {
      executor.mockRejectedValueOnce(new Error('Execution failed'))

      const job = createTestJob({
        schedule: { kind: 'at', at: new Date(Date.now() + 1000).toISOString() },
      })

      scheduler.scheduleJob(job)
      await vi.advanceTimersByTimeAsync(2000)

      expect(executor).toHaveBeenCalledOnce()
      // Job should be saved with 'failed' status
      expect(store.saveJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    })
  })

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      scheduler.start()
      scheduler.stop()
    })

    it('should be idempotent on start', () => {
      scheduler.start()
      scheduler.start() // Should not throw
      scheduler.stop()
    })
  })
})
