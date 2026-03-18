// Tests for QueryQueue — idle timeout suspension during tool execution
//
// Verifies that the idle timer is suspended while tools are actively executing
// (between tool_use and tool_result), preventing premature timeout of long-running
// tasks like rendering scripts, builds, or test suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryQueue, type QueryStatusEvent, type QueryResult, type QueuedQuery } from './query-queue.js'

// Use a short timeout for tests (100ms instead of 10 minutes)
const TEST_TIMEOUT_MS = 100

beforeEach(() => {
  vi.useFakeTimers()
  process.env.QUERY_TIMEOUT_MS = String(TEST_TIMEOUT_MS)
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.QUERY_TIMEOUT_MS
})

/** Helper: enqueue a query that hangs until we resolve it externally */
function enqueueHangingQuery(queue: QueryQueue, projectId = 'proj-1') {
  let resolveExecutor!: (r: QueryResult) => void
  const executorDone = new Promise<QueryResult>(res => { resolveExecutor = res })

  const { queryId, promise } = queue.enqueue({
    type: 'user',
    projectId,
    sessionId: 'sess-1',
    prompt: 'test prompt',
    executor: () => executorDone,
  })

  return { queryId, promise, resolveExecutor }
}

// ─────────────────────────────────────────────────────────────
// 1. Baseline: idle timeout fires when no activity
// ─────────────────────────────────────────────────────────────

describe('QueryQueue idle timeout (baseline)', () => {
  it('should timeout after idle period with no activity', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise } = enqueueHangingQuery(queue)

    // Advance past the timeout
    vi.advanceTimersByTime(TEST_TIMEOUT_MS + 10)

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(events.some(e => e.queryId === queryId && e.status === 'timeout')).toBe(true)
  })

  it('should reset timer on text_delta activity', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // Advance to 80% of timeout
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 0.8)

    // Activity resets the timer
    queue.touchActivity(queryId, 'text_delta', undefined, 'hello')

    // Advance another 80% — would have timed out without the activity
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 0.8)

    // Should still be running (timer was reset)
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    // Complete the query
    resolveExecutor({ success: true, queryId })
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise
    expect(result.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// 2. Core: tool execution suspends idle timer
// ─────────────────────────────────────────────────────────────

describe('QueryQueue tool execution suspension', () => {
  it('should NOT timeout while a tool is executing (simulates long-running Bash)', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // Tool starts executing (e.g. Bash running a 30-min render script)
    queue.touchActivity(queryId, 'tool_use', 'Bash')

    // Advance FAR past the timeout — 5x the idle limit
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 5)

    // Should NOT have timed out — tool is still executing
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    const timerState = queue.getTimerState(queryId)
    expect(timerState).toBeDefined()
    expect(timerState!.activeToolCount).toBe(1)
    expect(timerState!.timerId).toBeNull() // timer suspended

    // Tool finishes
    queue.touchActivity(queryId, 'tool_result')

    // Timer should be restarted now
    const stateAfter = queue.getTimerState(queryId)
    expect(stateAfter!.activeToolCount).toBe(0)
    expect(stateAfter!.timerId).not.toBeNull()

    // Complete the query before new timeout fires
    resolveExecutor({ success: true, queryId })
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise
    expect(result.success).toBe(true)
  })

  it('should timeout AFTER tool_result if no further activity', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise } = enqueueHangingQuery(queue)

    // Tool executes
    queue.touchActivity(queryId, 'tool_use', 'Bash')
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 3) // long execution, no timeout

    // Tool finishes — idle timer restarts
    queue.touchActivity(queryId, 'tool_result')

    // Now go idle past the timeout
    vi.advanceTimersByTime(TEST_TIMEOUT_MS + 10)

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
  })

  it('should track activeToolCount correctly across tool lifecycle', () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue)

    const getCount = () => queue.getTimerState(queryId)!.activeToolCount
    const hasTimer = () => queue.getTimerState(queryId)!.timerId !== null

    expect(getCount()).toBe(0)
    expect(hasTimer()).toBe(true) // initial timer is set

    // First tool starts
    queue.touchActivity(queryId, 'tool_use', 'Bash')
    expect(getCount()).toBe(1)
    expect(hasTimer()).toBe(false) // timer suspended

    // Second tool starts (parallel)
    queue.touchActivity(queryId, 'tool_use', 'Read')
    expect(getCount()).toBe(2)
    expect(hasTimer()).toBe(false)

    // First tool finishes — still one running
    queue.touchActivity(queryId, 'tool_result')
    expect(getCount()).toBe(1)
    expect(hasTimer()).toBe(false) // timer still suspended

    // Second tool finishes — all done
    queue.touchActivity(queryId, 'tool_result')
    expect(getCount()).toBe(0)
    expect(hasTimer()).toBe(true) // timer restarted
  })
})

// ─────────────────────────────────────────────────────────────
// 3. Parallel tool calls
// ─────────────────────────────────────────────────────────────

describe('QueryQueue parallel tool execution', () => {
  it('should stay suspended until ALL parallel tools complete', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // 3 tools start in parallel (e.g. Claude calls Bash + Read + Grep)
    queue.touchActivity(queryId, 'tool_use', 'Bash')
    queue.touchActivity(queryId, 'tool_use', 'Read')
    queue.touchActivity(queryId, 'tool_use', 'Grep')

    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(3)

    // Advance way past timeout
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 10)

    // Still no timeout
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    // Read and Grep finish quickly, Bash still running
    queue.touchActivity(queryId, 'tool_result')
    queue.touchActivity(queryId, 'tool_result')

    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(1)
    expect(queue.getTimerState(queryId)!.timerId).toBeNull() // still suspended

    // Advance again — still no timeout (Bash still running)
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 5)
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    // Bash finally finishes
    queue.touchActivity(queryId, 'tool_result')
    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(0)
    expect(queue.getTimerState(queryId)!.timerId).not.toBeNull() // timer restarted

    resolveExecutor({ success: true, queryId })
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise
    expect(result.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// 4. Interaction with pause/resume (user input)
// ─────────────────────────────────────────────────────────────

describe('QueryQueue tool execution + user input pause', () => {
  it('should defer timer on resume if tools are still executing', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // Tool starts
    queue.touchActivity(queryId, 'tool_use', 'Bash')

    // Permission request pauses timeout
    queue.pauseTimeout(queryId)
    expect(queue.getTimerState(queryId)!.paused).toBe(true)

    // User grants permission — resume, but tool is still running
    queue.resumeTimeout(queryId)
    expect(queue.getTimerState(queryId)!.paused).toBe(false)
    expect(queue.getTimerState(queryId)!.timerId).toBeNull() // deferred, tool still running

    // Advance way past timeout
    vi.advanceTimersByTime(TEST_TIMEOUT_MS * 5)
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    // Tool completes — timer starts
    queue.touchActivity(queryId, 'tool_result')
    expect(queue.getTimerState(queryId)!.timerId).not.toBeNull()

    resolveExecutor({ success: true, queryId })
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise
    expect(result.success).toBe(true)
  })

  it('should start timer on resume if no tools are executing', async () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue)

    // Pause (no tools running)
    queue.pauseTimeout(queryId)
    expect(queue.getTimerState(queryId)!.timerId).toBeNull()

    // Resume — timer should start since no tools are running
    queue.resumeTimeout(queryId)
    expect(queue.getTimerState(queryId)!.timerId).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 5. Edge cases
// ─────────────────────────────────────────────────────────────

describe('QueryQueue edge cases', () => {
  it('should not go below 0 on extra tool_result events', () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue)

    // Spurious tool_result without matching tool_use
    queue.touchActivity(queryId, 'tool_result')
    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(0)

    // Another one
    queue.touchActivity(queryId, 'tool_result')
    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(0)
  })

  it('should clear timer state on abort even during tool execution', () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue, 'proj-abort')

    queue.touchActivity(queryId, 'tool_use', 'Bash')
    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(1)

    // User aborts
    queue.abortRunning('proj-abort')
    expect(queue.getTimerState(queryId)).toBeUndefined()
  })

  it('should handle rapid tool_use/tool_result cycles without leaking', () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue)

    // 50 rapid tool call cycles
    for (let i = 0; i < 50; i++) {
      queue.touchActivity(queryId, 'tool_use', `Tool${i}`)
      queue.touchActivity(queryId, 'tool_result')
    }

    const state = queue.getTimerState(queryId)!
    expect(state.activeToolCount).toBe(0)
    expect(state.timerId).not.toBeNull() // timer active
  })

  it('should suspend timer even with interleaved text_delta during tool execution', () => {
    const queue = new QueryQueue(() => {})
    const { queryId } = enqueueHangingQuery(queue)

    queue.touchActivity(queryId, 'tool_use', 'Bash')
    expect(queue.getTimerState(queryId)!.timerId).toBeNull()

    // text_delta during tool execution (shouldn't restart timer)
    queue.touchActivity(queryId, 'text_delta', undefined, 'some output')
    expect(queue.getTimerState(queryId)!.activeToolCount).toBe(1)
    // text_delta doesn't change tool count, but timer stays suspended because activeToolCount > 0
    // Actually let me check: text_delta doesn't enter the tool_use/tool_result branches,
    // so activeToolCount stays 1 and the "if activeToolCount > 0" guard suspends the timer.
    expect(queue.getTimerState(queryId)!.timerId).toBeNull()

    queue.touchActivity(queryId, 'tool_result')
    expect(queue.getTimerState(queryId)!.timerId).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 6. Simulated long-running task scenario
// ─────────────────────────────────────────────────────────────

describe('QueryQueue long-running task simulation', () => {
  it('should survive a simulated 30-minute render script with periodic tool cycles', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // Simulate: Claude calls Bash to run a render script that takes 30 "minutes"
    // (using our test timeout scale: 30 minutes = 300x timeout)
    queue.touchActivity(queryId, 'tool_use', 'Bash')

    // Simulate the tool running for a very long time
    for (let minute = 0; minute < 300; minute++) {
      vi.advanceTimersByTime(TEST_TIMEOUT_MS) // each step = 1 timeout period
      // No timeout should fire
      expect(events.every(e => e.status !== 'timeout')).toBe(true)
    }

    // Tool finally completes
    queue.touchActivity(queryId, 'tool_result')

    // Claude responds with text
    queue.touchActivity(queryId, 'text_delta', undefined, 'Render complete!')

    // Complete the query
    resolveExecutor({ success: true, output: 'done', queryId })
    await vi.advanceTimersByTimeAsync(0)

    const result = await promise
    expect(result.success).toBe(true)
    expect(events.every(e => e.status !== 'timeout')).toBe(true)
  })

  it('should survive multiple sequential long tool calls', async () => {
    const events: QueryStatusEvent[] = []
    const queue = new QueryQueue(e => events.push(e))

    const { queryId, promise, resolveExecutor } = enqueueHangingQuery(queue)

    // Simulate 5 sequential long-running tool calls
    for (let i = 0; i < 5; i++) {
      queue.touchActivity(queryId, 'tool_use', 'Bash')
      vi.advanceTimersByTime(TEST_TIMEOUT_MS * 50) // each runs 50x timeout
      queue.touchActivity(queryId, 'tool_result')

      // Brief pause between tool calls (within timeout)
      vi.advanceTimersByTime(TEST_TIMEOUT_MS * 0.5)
    }

    // No timeouts throughout
    expect(events.every(e => e.status !== 'timeout')).toBe(true)

    resolveExecutor({ success: true, queryId })
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise
    expect(result.success).toBe(true)
  })
})
