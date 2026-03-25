import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryQueue } from '../queue.js'
import type { QueuedQuery, TurnType } from '../../types/index.js'

describe('QueryQueue', () => {
  let queue: QueryQueue
  let statusChanges: QueuedQuery[]

  beforeEach(() => {
    vi.useFakeTimers()
    queue = new QueryQueue()
    statusChanges = []
    queue.onStatusChange = (query) => {
      statusChanges.push({ ...query })
    }
  })

  afterEach(() => {
    queue.destroy()
    vi.useRealTimers()
  })

  function makeExecutor(resolveImmediately = true): {
    executor: (q: QueuedQuery) => Promise<void>
    resolve: () => void
    reject: (err: Error) => void
    called: { value: boolean }
  } {
    let resolveFn!: () => void
    let rejectFn!: (err: Error) => void
    const called = { value: false }
    const executor = (_q: QueuedQuery) => {
      called.value = true
      if (resolveImmediately) return Promise.resolve()
      return new Promise<void>((res, rej) => {
        resolveFn = res
        rejectFn = rej
      })
    }
    return { executor, resolve: () => resolveFn?.(), reject: (err) => rejectFn?.(err), called }
  }

  describe('enqueue', () => {
    it('should enqueue a single query and run it immediately', async () => {
      const { executor, called } = makeExecutor(true)
      const queryId = queue.enqueue({
        type: 'user',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        prompt: 'hello',
        executor,
      })

      expect(queryId).toMatch(/^query-/)

      // Let the microtask (processNext) run
      await vi.advanceTimersByTimeAsync(0)

      expect(called.value).toBe(true)
    })

    it('should return a unique queryId', () => {
      const { executor } = makeExecutor(false)
      const id1 = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'a', executor })
      const id2 = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'b', executor })
      expect(id1).not.toBe(id2)
    })
  })

  describe('FIFO ordering', () => {
    it('should run queries in FIFO order for the same project', async () => {
      const order: string[] = []

      const { executor: ex1, resolve: res1 } = makeExecutor(false)
      const { executor: ex2 } = makeExecutor(true)

      // Wrap to track order
      const wrappedEx1 = async (q: QueuedQuery) => {
        order.push('start-1')
        await ex1(q)
        order.push('end-1')
      }
      const wrappedEx2 = async (q: QueuedQuery) => {
        order.push('start-2')
        await ex2(q)
        order.push('end-2')
      }

      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'first', executor: wrappedEx1 })
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'second', executor: wrappedEx2 })

      // First query starts executing
      await vi.advanceTimersByTimeAsync(0)
      expect(order).toEqual(['start-1'])

      // Complete first query
      res1()
      await vi.advanceTimersByTimeAsync(0)

      expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
    })
  })

  describe('priority ordering', () => {
    it('should run user queries before cron queries when both are queued', async () => {
      const order: string[] = []

      // Block the first query so others queue up
      const { executor: blocker, resolve: unblock } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'blocker', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      // Now enqueue cron first, then user — user should go first due to priority
      const cronEx = async (_q: QueuedQuery) => { order.push('cron') }
      const userEx = async (_q: QueuedQuery) => { order.push('user') }

      queue.enqueue({ type: 'cron', projectId: 'p', sessionId: 's', prompt: 'cron-task', executor: cronEx })
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'user-task', executor: userEx })

      // Unblock the first query
      unblock()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // User should have run before cron
      expect(order).toEqual(['user', 'cron'])
    })

    it('should treat channel queries as same priority as cron', async () => {
      const order: string[] = []
      const { executor: blocker, resolve: unblock } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'blocker', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      // Enqueue channel then user — user has higher priority
      queue.enqueue({ type: 'channel', projectId: 'p', sessionId: 's', prompt: 'ch', executor: async () => { order.push('channel') } })
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'u', executor: async () => { order.push('user') } })

      unblock()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(order).toEqual(['user', 'channel'])
    })
  })

  describe('timeout detection', () => {
    it('should timeout a running query when no activity', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'slow', executor })
      await vi.advanceTimersByTimeAsync(0)

      // Advance past the timeout check interval + timeout
      vi.advanceTimersByTime(600_001)

      // Check that the interval fired and detected timeout
      vi.advanceTimersByTime(10_000)

      const timeoutEvents = statusChanges.filter((s) => s.id === queryId && s.status === 'timeout')
      expect(timeoutEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('pause/resume timeout', () => {
    it('should not timeout when paused', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'wait', executor })
      await vi.advanceTimersByTimeAsync(0)

      queue.pauseTimeout(queryId)

      // Advance past timeout
      vi.advanceTimersByTime(700_000)

      const timeoutEvents = statusChanges.filter((s) => s.id === queryId && s.status === 'timeout')
      expect(timeoutEvents).toHaveLength(0)
    })

    it('should resume timeout tracking and reset lastActivityAt', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'wait', executor })
      await vi.advanceTimersByTimeAsync(0)

      // Pause, advance some time, resume
      queue.pauseTimeout(queryId)
      vi.advanceTimersByTime(300_000)
      queue.resumeTimeout(queryId)

      // Now advance less than the full timeout — should still be alive
      vi.advanceTimersByTime(500_000)

      const timeoutEvents = statusChanges.filter((s) => s.id === queryId && s.status === 'timeout')
      expect(timeoutEvents).toHaveLength(0)

      // But if we advance past the full timeout from resume point, it should timeout
      vi.advanceTimersByTime(200_000)

      const timeoutEvents2 = statusChanges.filter((s) => s.id === queryId && s.status === 'timeout')
      expect(timeoutEvents2.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('touchActivity', () => {
    it('should reset timeout on activity', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'active', executor })
      await vi.advanceTimersByTimeAsync(0)

      // Advance almost to timeout, then touch
      vi.advanceTimersByTime(500_000)
      queue.touchActivity(queryId, 'text_delta')

      // Advance another 500s — should NOT timeout since we touched at 500s
      vi.advanceTimersByTime(500_000)

      // The check interval should have fired. Since lastActivityAt was reset at ~500s,
      // and now it's ~1000s total, only 500s since last activity — not yet timed out
      const timeoutEvents = statusChanges.filter((s) => s.id === queryId && s.status === 'timeout')
      expect(timeoutEvents).toHaveLength(0)
    })
  })

  describe('dequeue', () => {
    it('should remove a queued query', async () => {
      const { executor: blocker } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'running', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      const { executor } = makeExecutor(true)
      const queuedId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'to-remove', executor })

      expect(queue.getQueueLength('p')).toBe(1)
      const result = queue.dequeue(queuedId)
      expect(result).toBe(true)
      expect(queue.getQueueLength('p')).toBe(0)
    })

    it('should return false for a running query', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'running', executor })
      await vi.advanceTimersByTimeAsync(0)

      expect(queue.dequeue(queryId)).toBe(false)
    })

    it('should return false for non-existent query', () => {
      expect(queue.dequeue('non-existent')).toBe(false)
    })
  })

  describe('forceExecute', () => {
    it('should bypass queue and execute a queued query immediately', async () => {
      const order: string[] = []
      const { executor: blocker, resolve: unblock } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'blocker', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      const { executor } = makeExecutor(true)
      const wrappedEx = async (q: QueuedQuery) => {
        order.push('force-executed')
        await executor(q)
      }
      const queuedId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'force-me', executor: wrappedEx })

      const result = queue.forceExecute(queuedId)
      expect(result).toBe(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(order).toContain('force-executed')

      unblock()
    })

    it('should return false for a non-queued query', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'running', executor })
      await vi.advanceTimersByTimeAsync(0)

      // Already running, not queued
      expect(queue.forceExecute(queryId)).toBe(false)
    })
  })

  describe('cancel', () => {
    it('should cancel a running query', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'to-cancel', executor })
      await vi.advanceTimersByTimeAsync(0)

      queue.cancel(queryId)

      const cancelEvents = statusChanges.filter((s) => s.id === queryId && s.status === 'cancelled')
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('destroy', () => {
    it('should clean up the interval timer', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
      queue.destroy()
      expect(clearIntervalSpy).toHaveBeenCalled()
      clearIntervalSpy.mockRestore()
    })
  })

  describe('getSnapshot', () => {
    it('should return correct running and queued state', async () => {
      const { executor: blocker } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's1', prompt: 'running', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      const { executor: queued1 } = makeExecutor(true)
      const { executor: queued2 } = makeExecutor(true)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's2', prompt: 'queued-1', executor: queued1 })
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's3', prompt: 'queued-2', executor: queued2 })

      const snapshot = queue.getSnapshot('p')
      expect(snapshot.running).not.toBeNull()
      expect(snapshot.running!.prompt).toBe('running')
      expect(snapshot.queued).toHaveLength(2)
      expect(snapshot.queued[0].prompt).toBe('queued-1')
      expect(snapshot.queued[1].prompt).toBe('queued-2')
    })

    it('should return empty state for unknown project', () => {
      const snapshot = queue.getSnapshot('unknown')
      expect(snapshot.running).toBeNull()
      expect(snapshot.queued).toHaveLength(0)
    })
  })

  describe('getRunning', () => {
    it('should return the running query for a project', async () => {
      const { executor } = makeExecutor(false)
      const queryId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'test', executor })
      await vi.advanceTimersByTimeAsync(0)

      const running = queue.getRunning('p')
      expect(running).not.toBeNull()
      expect(running!.id).toBe(queryId)
    })

    it('should return null when no query is running', () => {
      expect(queue.getRunning('p')).toBeNull()
    })
  })

  describe('getQueueLength', () => {
    it('should return 0 for empty queue', () => {
      expect(queue.getQueueLength('p')).toBe(0)
    })

    it('should not count the running query', async () => {
      const { executor: blocker } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'running', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      const { executor } = makeExecutor(true)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'queued', executor })

      expect(queue.getQueueLength('p')).toBe(1)
    })
  })

  describe('status callbacks', () => {
    it('should fire status change on enqueue', () => {
      const { executor } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'test', executor })

      const queuedEvents = statusChanges.filter((s) => s.status === 'queued')
      expect(queuedEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('should fire status change on running', async () => {
      const { executor } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'test', executor })
      await vi.advanceTimersByTimeAsync(0)

      const runningEvents = statusChanges.filter((s) => s.status === 'running')
      expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('should fire status change on completion', async () => {
      const { executor } = makeExecutor(true)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'test', executor })
      await vi.advanceTimersByTimeAsync(0)

      const completedEvents = statusChanges.filter((s) => s.status === 'completed')
      expect(completedEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('should fire status change on failure', async () => {
      const executor = async () => {
        throw new Error('boom')
      }
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'fail', executor })
      await vi.advanceTimersByTimeAsync(0)

      const failedEvents = statusChanges.filter((s) => s.status === 'failed')
      expect(failedEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('should fire status change on dequeue/cancel', async () => {
      const { executor: blocker } = makeExecutor(false)
      queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'running', executor: blocker })
      await vi.advanceTimersByTimeAsync(0)

      const { executor } = makeExecutor(true)
      const queuedId = queue.enqueue({ type: 'user', projectId: 'p', sessionId: 's', prompt: 'queued', executor })

      queue.dequeue(queuedId)

      const cancelledEvents = statusChanges.filter((s) => s.id === queuedId && s.status === 'cancelled')
      expect(cancelledEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('cross-project isolation', () => {
    it('should allow queries from different projects to run concurrently', async () => {
      const running: string[] = []

      const { executor: ex1 } = makeExecutor(false)
      const { executor: ex2 } = makeExecutor(false)

      const wrapped1 = async (q: QueuedQuery) => {
        running.push('p1')
        await ex1(q)
      }
      const wrapped2 = async (q: QueuedQuery) => {
        running.push('p2')
        await ex2(q)
      }

      queue.enqueue({ type: 'user', projectId: 'p1', sessionId: 's1', prompt: 'a', executor: wrapped1 })
      queue.enqueue({ type: 'user', projectId: 'p2', sessionId: 's2', prompt: 'b', executor: wrapped2 })

      await vi.advanceTimersByTimeAsync(0)

      // Both should be running concurrently
      expect(running).toContain('p1')
      expect(running).toContain('p2')
      expect(queue.getRunning('p1')).not.toBeNull()
      expect(queue.getRunning('p2')).not.toBeNull()
    })
  })
})
