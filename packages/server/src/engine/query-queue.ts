// QueryQueue — per-project FIFO query queue with activity-based idle timeout
//
// Ensures only one query runs per project at a time.
// Both user prompts and cron jobs are enqueued here.
// Timeout resets on every activity signal (text, thinking, tool use, etc.)
// and pauses when waiting for user input (permission request, ask_user_question).

export type QueryType = 'user' | 'cron'
export type QueryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'

export interface QueryResult {
  success: boolean
  output?: string
  error?: string
  queryId: string
}

export interface QueuedQuery {
  id: string
  type: QueryType
  projectId: string
  sessionId: string
  prompt: string
  status: QueryStatus
  priority: number           // 0 = normal (user), 1 = low (cron). Lower = higher priority
  createdAt: number
  startedAt?: number
  completedAt?: number
  error?: string
  abortController: AbortController
  metadata?: {
    cronJobId?: string
    cronJobName?: string
    cronRunId?: string
    retryCount?: number
    maxRetries?: number
  }
  // Internal: execution function and promise callbacks
  _executor: (query: QueuedQuery) => Promise<QueryResult>
  _resolve: (result: QueryResult) => void
  _reject: (error: Error) => void
}

export interface QueryStatusEvent {
  queryId: string
  projectId: string
  sessionId?: string
  status: QueryStatus
  position?: number
  queueLength?: number
  prompt?: string
  queryType?: QueryType
  cronJobName?: string
}

export interface QueryTimerState {
  timerId: NodeJS.Timeout | null
  lastActivityAt: number
  paused: boolean
  lastActivityType: string
  lastToolName?: string
  textSnippet?: string
}

export type StatusChangeCallback = (event: QueryStatusEvent) => void

function getTimeoutMs(): number {
  const envVal = process.env.QUERY_TIMEOUT_MS
  if (envVal) {
    const parsed = parseInt(envVal, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return 600_000 // 10 minutes
}

function generateQueryId(): string {
  return `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class QueryQueue {
  private queues = new Map<string, QueuedQuery[]>()
  private running = new Map<string, QueuedQuery>()
  private timerStates = new Map<string, QueryTimerState>()
  private onStatusChange: StatusChangeCallback

  constructor(onStatusChange: StatusChangeCallback) {
    this.onStatusChange = onStatusChange
  }

  /**
   * Enqueue a query for a project. Returns queryId and a promise that resolves when complete.
   */
  enqueue(params: {
    type: QueryType
    projectId: string
    sessionId: string
    prompt: string
    priority?: number
    metadata?: QueuedQuery['metadata']
    executor: (query: QueuedQuery) => Promise<QueryResult>
  }): { queryId: string; promise: Promise<QueryResult> } {
    const queryId = generateQueryId()
    let resolve!: (r: QueryResult) => void
    let reject!: (e: Error) => void
    const promise = new Promise<QueryResult>((res, rej) => {
      resolve = res
      reject = rej
    })

    const queue = this.queues.get(params.projectId) || []

    const query: QueuedQuery = {
      id: queryId,
      type: params.type,
      projectId: params.projectId,
      sessionId: params.sessionId,
      prompt: params.prompt,
      status: 'queued',
      priority: params.priority ?? (params.type === 'cron' ? 1 : 0),
      createdAt: Date.now(),
      abortController: new AbortController(),
      metadata: params.metadata,
      _executor: params.executor,
      _resolve: resolve,
      _reject: reject,
    }

    queue.push(query)
    // Stable sort: lower priority number first, then FIFO within same priority
    queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    this.queues.set(params.projectId, queue)

    const position = queue.indexOf(query)
    const runningOffset = this.running.has(params.projectId) ? 1 : 0

    this.onStatusChange({
      queryId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      status: 'queued',
      position: position + runningOffset,
      queueLength: queue.length + runningOffset,
      prompt: query.prompt,
      queryType: query.type,
      cronJobName: query.metadata?.cronJobName,
    })

    console.log(`[QueryQueue] Enqueued ${params.type} query ${queryId} for project ${params.projectId}, position=${position + runningOffset}`)

    // Try to process immediately
    this.processNext(params.projectId)

    return { queryId, promise }
  }

  private async processNext(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return

    const queue = this.queues.get(projectId)
    if (!queue || queue.length === 0) return

    const query = queue.shift()!
    this.running.set(projectId, query)
    query.status = 'running'
    query.startedAt = Date.now()

    this.onStatusChange({
      queryId: query.id,
      projectId,
      sessionId: query.sessionId,
      status: 'running',
      position: 0,
      queueLength: queue.length + 1,
      prompt: query.prompt,
      queryType: query.type,
      cronJobName: query.metadata?.cronJobName,
    })

    // Broadcast updated positions for remaining queued items
    queue.forEach((q, idx) => {
      this.onStatusChange({
        queryId: q.id,
        projectId,
        sessionId: q.sessionId,
        status: 'queued',
        position: idx + 1,
        queueLength: queue.length + 1,
        prompt: q.prompt,
        queryType: q.type,
        cronJobName: q.metadata?.cronJobName,
      })
    })

    // Set idle timeout with timer state
    const timeoutMs = getTimeoutMs()
    const now = Date.now()
    const timerId = setTimeout(() => {
      this.handleTimeout(projectId, query)
    }, timeoutMs)
    this.timerStates.set(query.id, {
      timerId,
      lastActivityAt: now,
      paused: false,
      lastActivityType: 'started',
    })

    console.log(`[QueryQueue] Running query ${query.id} for project ${projectId} (idle timeout: ${timeoutMs}ms)`)

    try {
      const result = await query._executor(query)
      this.clearTimerState(query.id)

      // Timeout handler may have changed status asynchronously
      if ((query.status as QueryStatus) === 'timeout') {
        return
      }

      query.status = 'completed'
      query.completedAt = Date.now()
      this.onStatusChange({ queryId: query.id, projectId, sessionId: query.sessionId, status: 'completed', prompt: query.prompt, queryType: query.type, cronJobName: query.metadata?.cronJobName })
      query._resolve(result)

      console.log(`[QueryQueue] Query ${query.id} completed in ${query.completedAt - query.startedAt!}ms`)
    } catch (err: any) {
      this.clearTimerState(query.id)

      if ((query.status as QueryStatus) === 'timeout') {
        return
      }

      query.status = 'failed'
      query.completedAt = Date.now()
      query.error = err.message
      this.onStatusChange({ queryId: query.id, projectId, sessionId: query.sessionId, status: 'failed', prompt: query.prompt, queryType: query.type, cronJobName: query.metadata?.cronJobName })
      query._resolve({ success: false, error: err.message, queryId: query.id })

      console.error(`[QueryQueue] Query ${query.id} failed:`, err.message)
    } finally {
      this.running.delete(projectId)
      this.processNext(projectId)
    }
  }

  private handleTimeout(projectId: string, query: QueuedQuery): void {
    console.warn(`[QueryQueue] Query ${query.id} idle timeout after ${getTimeoutMs()}ms of no activity`)
    query.status = 'timeout'
    query.completedAt = Date.now()

    // Abort the running query
    query.abortController.abort()

    this.timerStates.delete(query.id)

    this.onStatusChange({ queryId: query.id, projectId, sessionId: query.sessionId, status: 'timeout', prompt: query.prompt, queryType: query.type, cronJobName: query.metadata?.cronJobName })
    query._resolve({ success: false, error: 'Query timed out (idle)', queryId: query.id })

    // Remove from running so next can proceed
    this.running.delete(projectId)
    this.processNext(projectId)
  }

  private clearTimerState(queryId: string): void {
    const state = this.timerStates.get(queryId)
    if (state) {
      if (state.timerId) clearTimeout(state.timerId)
      this.timerStates.delete(queryId)
    }
  }

  /**
   * Signal activity on a running query, resetting the idle timer.
   */
  touchActivity(queryId: string, activityType: string, toolName?: string, textSnippet?: string): void {
    const state = this.timerStates.get(queryId)
    if (!state) return

    state.lastActivityAt = Date.now()
    state.lastActivityType = activityType
    state.lastToolName = toolName
    if (textSnippet !== undefined) {
      // Accumulate and keep only the last 50 characters
      state.textSnippet = ((state.textSnippet || '') + textSnippet).slice(-50)
    } else if (activityType === 'tool_use') {
      state.textSnippet = undefined
    }

    // If paused (waiting for user input), only update metadata — timer restarts on resume
    if (state.paused) return

    // Reset idle timer
    if (state.timerId) clearTimeout(state.timerId)
    const timeoutMs = getTimeoutMs()
    const query = this.findQueryById(queryId)
    if (query) {
      state.timerId = setTimeout(() => {
        this.handleTimeout(query.projectId, query)
      }, timeoutMs)
    }
  }

  /**
   * Pause the idle timeout (e.g. when waiting for user permission or question response).
   */
  pauseTimeout(queryId: string): void {
    const state = this.timerStates.get(queryId)
    if (!state || state.paused) return

    if (state.timerId) {
      clearTimeout(state.timerId)
      state.timerId = null
    }
    state.paused = true
    console.log(`[QueryQueue] Paused idle timeout for query ${queryId}`)
  }

  /**
   * Resume the idle timeout after user responds.
   */
  resumeTimeout(queryId: string): void {
    const state = this.timerStates.get(queryId)
    if (!state || !state.paused) return

    state.paused = false
    state.lastActivityAt = Date.now()

    const timeoutMs = getTimeoutMs()
    const query = this.findQueryById(queryId)
    if (query) {
      state.timerId = setTimeout(() => {
        this.handleTimeout(query.projectId, query)
      }, timeoutMs)
    }
    console.log(`[QueryQueue] Resumed idle timeout for query ${queryId}`)
  }

  /**
   * Get the timer state for a query (used by heartbeat broadcaster).
   */
  getTimerState(queryId: string): QueryTimerState | undefined {
    return this.timerStates.get(queryId)
  }

  private findQueryById(queryId: string): QueuedQuery | undefined {
    for (const query of this.running.values()) {
      if (query.id === queryId) return query
    }
    return undefined
  }

  /**
   * Cancel a queued (not yet running) query.
   * Returns true if cancelled, false if not found or already running.
   */
  cancel(queryId: string): boolean {
    for (const [projectId, queue] of this.queues) {
      const idx = queue.findIndex(q => q.id === queryId)
      if (idx !== -1) {
        const removed = queue.splice(idx, 1)[0]
        removed.status = 'cancelled'
        removed.completedAt = Date.now()
        this.onStatusChange({ queryId, projectId, sessionId: removed.sessionId, status: 'cancelled', prompt: removed.prompt, queryType: removed.type, cronJobName: removed.metadata?.cronJobName })
        removed._resolve({ success: false, error: 'Cancelled', queryId })
        console.log(`[QueryQueue] Cancelled queued query ${queryId}`)
        return true
      }
    }
    return false
  }

  /**
   * Abort the currently running query for a project.
   */
  abortRunning(projectId: string): QueuedQuery | undefined {
    const query = this.running.get(projectId)
    if (query) {
      query.abortController.abort()
      this.clearTimerState(query.id)
      console.log(`[QueryQueue] Aborted running query ${query.id} for project ${projectId}`)
    }
    return query
  }

  /**
   * Get the running query for a project.
   */
  getRunningQuery(projectId: string): QueuedQuery | undefined {
    return this.running.get(projectId)
  }

  /**
   * Get queue status for a project.
   */
  getProjectQueue(projectId: string): { running?: QueuedQuery; queued: QueuedQuery[] } {
    return {
      running: this.running.get(projectId),
      queued: [...(this.queues.get(projectId) || [])],
    }
  }

  /**
   * Check if a project has a running query.
   */
  isProjectBusy(projectId: string): boolean {
    return this.running.has(projectId)
  }
}
