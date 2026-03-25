import type { QueuedQuery, TurnType } from '../types/index.js'

const QUERY_TIMEOUT_MS = parseInt(process.env.QUERY_TIMEOUT_MS || '600000', 10) // 10 min default
const QUERY_CHECK_INTERVAL_MS = 10_000

type QueryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'

function generateQueryId(): string {
  return `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getPriority(type: TurnType): number {
  return type === 'user' ? 0 : 1
}

export class QueryQueue {
  private queues = new Map<string, QueuedQuery[]>() // projectId -> queue
  private running = new Map<string, QueuedQuery>() // projectId -> current running
  private allQueries = new Map<string, QueuedQuery>() // queryId -> query
  private timeoutTimer: ReturnType<typeof setInterval> | null = null

  onStatusChange?: (query: QueuedQuery) => void

  constructor() {
    this.timeoutTimer = setInterval(() => this.checkTimeouts(), QUERY_CHECK_INTERVAL_MS)
  }

  /**
   * Enqueue a query for a project. Returns the queryId.
   */
  enqueue(params: {
    type: TurnType
    projectId: string
    sessionId: string
    prompt: string
    cronJobName?: string
    executor: (query: QueuedQuery) => Promise<void>
  }): string {
    const queryId = generateQueryId()

    const queue = this.queues.get(params.projectId) || []

    const query: QueuedQuery = {
      id: queryId,
      type: params.type,
      projectId: params.projectId,
      sessionId: params.sessionId,
      prompt: params.prompt,
      cronJobName: params.cronJobName,
      status: 'queued',
      position: 0,
      enqueuedAt: Date.now(),
      paused: false,
      executor: params.executor,
    }

    // Insert in priority order: user (0) before cron/channel (1), then FIFO within same priority
    const priority = getPriority(params.type)
    let insertIdx = queue.length
    for (let i = 0; i < queue.length; i++) {
      if (getPriority(queue[i].type) > priority) {
        insertIdx = i
        break
      }
    }
    queue.splice(insertIdx, 0, query)

    // Update positions
    this.updatePositions(queue)
    this.queues.set(params.projectId, queue)
    this.allQueries.set(queryId, query)

    this.notifyStatusChange(query)

    // Try to process immediately
    this.processNext(params.projectId)

    return queryId
  }

  /**
   * Dequeue (remove) a queued query. Returns true if found and removed.
   */
  dequeue(queryId: string): boolean {
    const query = this.allQueries.get(queryId)
    if (!query || query.status !== 'queued') return false

    const queue = this.queues.get(query.projectId)
    if (!queue) return false

    const idx = queue.findIndex((q) => q.id === queryId)
    if (idx === -1) return false

    queue.splice(idx, 1)
    query.status = 'cancelled'
    this.updatePositions(queue)
    this.notifyStatusChange(query)
    this.allQueries.delete(queryId)

    return true
  }

  /**
   * Force-execute a queued query immediately, bypassing the queue.
   * Returns true if the query was found and force-executed.
   */
  forceExecute(queryId: string): boolean {
    const query = this.allQueries.get(queryId)
    if (!query || query.status !== 'queued') return false

    const queue = this.queues.get(query.projectId)
    if (!queue) return false

    const idx = queue.findIndex((q) => q.id === queryId)
    if (idx === -1) return false

    // Remove from queue
    queue.splice(idx, 1)
    this.updatePositions(queue)

    // Execute directly (bypasses the one-at-a-time constraint)
    this.executeQuery(query)

    return true
  }

  /**
   * Signal activity on a running query, resetting the idle timer.
   */
  touchActivity(queryId: string, activityType: string, toolName?: string): void {
    const query = this.allQueries.get(queryId)
    if (!query || query.status !== 'running') return
    if (query.paused) return

    query.lastActivityAt = Date.now()
    query.lastActivityType = activityType
  }

  /**
   * Pause the idle timeout (e.g. when waiting for user permission or question).
   */
  pauseTimeout(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query || query.status !== 'running') return
    query.paused = true
  }

  /**
   * Resume the idle timeout after user responds.
   */
  resumeTimeout(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query || query.status !== 'running') return
    query.paused = false
    query.lastActivityAt = Date.now()
  }

  /**
   * Get a snapshot of the queue for a project.
   */
  getSnapshot(projectId: string): {
    running: QueuedQuery | null
    queued: QueuedQuery[]
  } {
    return {
      running: this.running.get(projectId) ?? null,
      queued: [...(this.queues.get(projectId) || [])],
    }
  }

  /**
   * Get the currently running query for a project.
   */
  getRunning(projectId: string): QueuedQuery | null {
    return this.running.get(projectId) ?? null
  }

  /**
   * Get the queue length for a project (not including running).
   */
  getQueueLength(projectId: string): number {
    return (this.queues.get(projectId) || []).length
  }

  /**
   * Mark a query as completed.
   */
  complete(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query) return
    query.status = 'completed'
    this.finishQuery(query)
  }

  /**
   * Mark a query as failed.
   */
  fail(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query) return
    query.status = 'failed'
    this.finishQuery(query)
  }

  /**
   * Mark a query as timed out.
   */
  timeout(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query) return
    query.status = 'timeout'
    this.notifyStatusChange(query)
    this.finishQuery(query)
  }

  /**
   * Cancel a running query.
   */
  cancel(queryId: string): void {
    const query = this.allQueries.get(queryId)
    if (!query) return
    query.status = 'cancelled'
    this.notifyStatusChange(query)
    this.finishQuery(query)
  }

  /**
   * Clean up timers and state.
   */
  destroy(): void {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }

  // ---------- Internal methods ----------

  private async processNext(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return

    const queue = this.queues.get(projectId)
    if (!queue || queue.length === 0) return

    const query = queue.shift()!
    this.updatePositions(queue)
    this.executeQuery(query)
  }

  private async executeQuery(query: QueuedQuery): Promise<void> {
    query.status = 'running'
    query.startedAt = Date.now()
    query.lastActivityAt = Date.now()
    this.running.set(query.projectId, query)
    this.notifyStatusChange(query)

    try {
      await query.executor(query)
      // Only mark complete if not already in a terminal state (timeout/cancelled)
      if (query.status === 'running') {
        query.status = 'completed'
        this.notifyStatusChange(query)
      }
    } catch {
      if (query.status === 'running') {
        query.status = 'failed'
        this.notifyStatusChange(query)
      }
    } finally {
      // Remove from running if this query is still the running one
      if (this.running.get(query.projectId)?.id === query.id) {
        this.running.delete(query.projectId)
      }
      // Process next in queue
      this.processNext(query.projectId)
    }
  }

  private checkTimeouts(): void {
    const now = Date.now()
    for (const query of this.running.values()) {
      if (query.paused) continue
      const lastActivity = query.lastActivityAt || query.startedAt || query.enqueuedAt
      if (now - lastActivity > QUERY_TIMEOUT_MS) {
        this.timeout(query.id)
      }
    }
  }

  private finishQuery(query: QueuedQuery): void {
    if (this.running.get(query.projectId)?.id === query.id) {
      this.running.delete(query.projectId)
      this.processNext(query.projectId)
    }
  }

  private updatePositions(queue: QueuedQuery[]): void {
    for (let i = 0; i < queue.length; i++) {
      queue[i].position = i
    }
  }

  private notifyStatusChange(query: QueuedQuery): void {
    if (this.onStatusChange) {
      this.onStatusChange(query)
    }
  }
}
