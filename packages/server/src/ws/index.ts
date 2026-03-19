// WebSocket module — connection management and message routing with Claude SDK
// Single WS connection per client, project routing via message body
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type {
  ClientMessage,
  ServerMessage,
  ChatMessage,
  SessionInfo,
  ProjectStatus,
} from '@codecrab/shared'
import { getToken } from '../auth/index.js'
import {
  executeQuery,
  createClientState,
  getClientState,
  removeAllClientStates,
  getClientStatesForClient,
  getOrCreateProjectState,
  getProjectState,
  getActiveProjectIds,
  storeAssistantMessage,
  handlePermissionResponse,
  handleQuestionResponse,
  abortQuery,
  getSessionStatuses,
  getCachedModels,
  loadModelsFromConfig,
  generateSessionId,
  getModelDisplayName,
  getDefaultModelConfig,
  probeSdkInit,
} from '../engine/claude.js'
import { QueryQueue } from '../engine/query-queue.js'
import { sendQueryCompletionPush } from '../mcp/push/index.js'
import { triggerSoulEvolution } from '../soul/agent.js'
import type { QueuedQuery, QueryResult, QueryTimerState } from '../engine/query-queue.js'

// Export for API use
export { getSessionStatuses as getSessions }

// Timestamp helper — formats to second-level precision for query execution logs
function tsLog(prefix: string, ...args: unknown[]): void {
  const now = new Date()
  const ts = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  console.log(`[${ts}] ${prefix}`, ...args)
}

// Robust extraction of [SUMMARY: ...] and [SUGGESTIONS: ...] meta tags from response text.
// Handles both well-formed tags (with closing ']') and malformed ones (missing closing ']').
function extractMetaTags(text: string): { summary: string | null; suggestions: string[] } {
  let summary: string | null = null
  let suggestions: string[] = []

  // SUMMARY: try strict format first, then fallback without closing bracket
  const strictSummary = text.match(/\[SUMMARY:\s*(.+)\]\s*$/m)
  if (strictSummary) {
    summary = strictSummary[1].trim()
  } else {
    const looseSummary = text.match(/\[SUMMARY:\s*(.+?)\s*$/m)
    if (looseSummary) {
      summary = looseSummary[1].replace(/\]\s*$/, '').trim() || null
    }
  }

  // SUGGESTIONS: try strict format first, then fallback without closing bracket
  const strictSuggestions = text.match(/\[SUGGESTIONS:\s*(.+)\]\s*$/m)
  if (strictSuggestions) {
    suggestions = strictSuggestions[1].split('|').map((s: string) => s.trim()).filter(Boolean)
  } else {
    const looseSuggestions = text.match(/\[SUGGESTIONS:\s*(.+?)\s*$/m)
    if (looseSuggestions) {
      const raw = looseSuggestions[1].replace(/\]\s*$/, '').trim()
      suggestions = raw.split('|').map((s: string) => s.trim()).filter(Boolean)
    }
  }

  return { summary, suggestions }
}

// Per-project query queue — replaces the old rejection-based concurrency control
const queryQueue = new QueryQueue((event) => {
  broadcastToProject(event.projectId, {
    type: 'query_queue_status',
    queryId: event.queryId,
    status: event.status,
    position: event.position,
    queueLength: event.queueLength,
    projectId: event.projectId,
    sessionId: event.sessionId,
    prompt: event.prompt,
    queryType: event.queryType,
    cronJobName: event.cronJobName,
  })
})
export { queryQueue }

// SOUL evolution — fire-and-forget async trigger after user queries
function triggerSoulEvolutionAsync(userMessage: string, assistantResponse: string): void {
  console.log(`[SOUL] triggerSoulEvolutionAsync called — user: ${userMessage.length} chars, assistant: ${assistantResponse.length} chars`)

  // Skip trivial interactions (threshold=5 chars to accommodate CJK languages)
  const trimmed = userMessage.trim()
  if (!trimmed || !assistantResponse.trim()) {
    console.log('[SOUL] Skipped — empty user or assistant message')
    return
  }
  if (trimmed.length < 5) {
    console.log(`[SOUL] Skipped — user message too short (${trimmed.length} < 5)`)
    return
  }

  // Strip [SUMMARY: ...] and [SUGGESTIONS: ...] tags — these are prompt-forced
  // output markers, not meaningful conversation content for SOUL analysis
  const cleaned = assistantResponse
    .replace(/\n?\[SUMMARY:\s*.+\]\s*$/gm, '')
    .replace(/\n?\[SUGGESTIONS:\s*.+\]\s*$/gm, '')
    .trimEnd()

  // Truncate long responses to keep the evolution prompt manageable
  const maxLen = 2000
  const truncated = cleaned.length > maxLen
    ? cleaned.slice(0, maxLen) + '\n...(truncated)'
    : cleaned

  triggerSoulEvolution([{
    timestamp: new Date().toISOString(),
    userMessage,
    assistantResponse: truncated,
  }]).catch((err) => {
    console.error('[ws] SOUL evolution trigger failed:', err)
  })
}

// Activity heartbeat — throttle to one broadcast per 10s per query
const HEARTBEAT_THROTTLE_MS = 10_000
const lastHeartbeatSentAt = new Map<string, number>()
// Periodic heartbeat timers — ensure updates during long tool executions
const periodicHeartbeatTimers = new Map<string, NodeJS.Timeout>()
const PERIODIC_HEARTBEAT_INTERVAL_MS = 10_000

function sendActivityHeartbeat(projectId: string, sessionId: string, queryId: string): void {
  const now = Date.now()
  const timerState = queryQueue.getTimerState(queryId)
  if (!timerState) return

  const runningQuery = queryQueue.getRunningQuery(projectId)
  if (!runningQuery) return

  const elapsedMs = now - (runningQuery.startedAt || now)

  lastHeartbeatSentAt.set(queryId, now)
  broadcastToProject(projectId, {
    type: 'activity_heartbeat',
    projectId,
    sessionId,
    queryId,
    elapsedMs,
    lastActivityType: timerState.lastActivityType,
    lastToolName: timerState.lastToolName,
    textSnippet: timerState.textSnippet || undefined,
    paused: timerState.paused || undefined,
  })
}

function maybeSendActivityHeartbeat(projectId: string, sessionId: string, queryId: string): void {
  const now = Date.now()
  const lastSent = lastHeartbeatSentAt.get(queryId) || 0
  if (now - lastSent < HEARTBEAT_THROTTLE_MS) return
  sendActivityHeartbeat(projectId, sessionId, queryId)
}

function startPeriodicHeartbeat(projectId: string, sessionId: string, queryId: string): void {
  stopPeriodicHeartbeat(queryId)
  const timerId = setInterval(() => {
    sendActivityHeartbeat(projectId, sessionId, queryId)
  }, PERIODIC_HEARTBEAT_INTERVAL_MS)
  periodicHeartbeatTimers.set(queryId, timerId)
}

function stopPeriodicHeartbeat(queryId: string): void {
  const timerId = periodicHeartbeatTimers.get(queryId)
  if (timerId) {
    clearInterval(timerId)
    periodicHeartbeatTimers.delete(queryId)
  }
}

function cleanupHeartbeat(queryId: string): void {
  lastHeartbeatSentAt.delete(queryId)
  stopPeriodicHeartbeat(queryId)
}

// Project activity — lightweight global broadcast for project list UI
const PROJECT_ACTIVITY_THROTTLE_MS = 2_000
const lastProjectActivitySentAt = new Map<string, number>()

function maybeBroadcastProjectActivity(projectId: string, queryId: string): void {
  const now = Date.now()
  const lastSent = lastProjectActivitySentAt.get(projectId) || 0
  if (now - lastSent < PROJECT_ACTIVITY_THROTTLE_MS) return

  const timerState = queryQueue.getTimerState(queryId)
  if (!timerState) return

  lastProjectActivitySentAt.set(projectId, now)

  let activityType: 'thinking' | 'text' | 'tool_use' | 'idle' = 'idle'
  if (timerState.lastActivityType === 'thinking_delta') activityType = 'thinking'
  else if (timerState.lastActivityType === 'text_delta') activityType = 'text'
  else if (timerState.lastActivityType === 'tool_use') activityType = 'tool_use'
  else return // skip non-interesting activity types (usage, tool_result, started)

  broadcastGlobal({
    type: 'project_activity',
    projectId,
    activityType,
    toolName: timerState.lastToolName,
    textSnippet: timerState.textSnippet,
  })
}

function clearProjectActivity(projectId: string): void {
  lastProjectActivitySentAt.delete(projectId)
  broadcastGlobal({
    type: 'project_activity',
    projectId,
    activityType: 'idle',
  })
}

// Execute a prompt in a specific session (used by cron jobs)
// Now enqueues through the query queue instead of executing directly
// If sessionId is not provided, a new session will be created for the project
export async function executePromptInSession(
  parentSessionId: string | undefined,
  projectId: string | undefined,
  prompt: string,
  cronJobName?: string,
  metadata?: { cronJobId?: string; cronRunId?: string },
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Find or create parent session
  let parentSession: Session | undefined

  if (parentSessionId) {
    parentSession = sessions.get(parentSessionId)
  }

  // If no session found by sessionId, try to find one by projectId or create new
  if (!parentSession && projectId) {
    // Only reuse existing cron parent sessions, not user sessions
    for (const s of sessions.values()) {
      if (s.projectId === projectId && s.sessionId.startsWith('cron-parent-')) {
        parentSession = s
        break
      }
    }
  }

  // If still no session, create a new one for this project
  if (!parentSession) {
    if (!projectId) {
      return { success: false, error: 'No session or project ID provided for cron job' }
    }

    const projState = getOrCreateProjectState(projectId)
    const newSessionId = `cron-parent-${Date.now()}`
    parentSession = {
      sessionId: newSessionId,
      projectId,
      cwd: projState.cwd,
      turns: [],
      status: 'idle',
      lastModified: Date.now(),
      summary: cronJobName ? `Parent Session for: ${cronJobName}` : 'Parent Session for Scheduled Tasks',
    }
    sessions.set(newSessionId, parentSession)
    persistSession(parentSession)
    console.log(`[cron] Created parent session ${newSessionId} for project ${projectId}`)
  }

  const actualProjectId = parentSession.projectId
  if (!actualProjectId) {
    return { success: false, error: 'Parent session has no project' }
  }

  const { queryId, promise } = queryQueue.enqueue({
    type: 'cron',
    projectId: actualProjectId,
    sessionId: parentSession.sessionId,
    prompt,
    priority: 1, // Lower priority than user queries
    metadata: {
      cronJobName: cronJobName,
      cronJobId: metadata?.cronJobId,
      cronRunId: metadata?.cronRunId,
    },
    executor: async (queuedQuery) => {
      return executeCronQuery(parentSession!, actualProjectId, prompt, cronJobName, queuedQuery, metadata)
    },
  })

  console.log(`[cron] Enqueued cron query ${queryId} for session ${parentSession.sessionId}`)
  return await promise
}

// Internal: execute a cron query (called by the queue when it's this query's turn)
// Creates a new session for execution, then inserts result into parent session
// Streams real-time events to both exec session and parent session
async function executeCronQuery(
  parentSession: Session,
  projectId: string,
  prompt: string,
  cronJobName: string | undefined,
  queuedQuery: QueuedQuery,
  metadata?: { cronJobId?: string; cronRunId?: string },
): Promise<QueryResult> {
  const projState = getOrCreateProjectState(projectId)
  const cronJobId = metadata?.cronJobId || 'unknown'

  // Create a new session for this cron execution
  const execSessionId = `cron-${cronJobId}-${Date.now()}`
  const execSession: Session = {
    sessionId: execSessionId,
    projectId,
    cwd: parentSession.cwd || projState.cwd,
    turns: [],
    status: 'processing',
    lastModified: Date.now(),
    summary: cronJobName ? `Scheduled Task: ${cronJobName}` : 'Scheduled Task',
    firstPrompt: prompt,
  }
  sessions.set(execSessionId, execSession)

  // Create a virtual client state for this execution
  const cronClientId = `cron-${Date.now()}`
  const clientState = createClientState(cronClientId, projectId, execSession.cwd || process.cwd())
  clientState.permissionMode = 'bypassPermissions' // Cron jobs run unattended

  // Create cron turn in execution session
  const cronLabel = cronJobName ? `[Scheduled Task: ${cronJobName}]` : '[Scheduled Task]'
  execSession.turns.push({
    prompt: {
      type: 'cron',
      text: `${cronLabel} ${prompt}`,
      cronJobId: metadata?.cronJobId,
      cronJobName,
    },
    agent: { messages: [], debugEvents: [] },
    timestamp: Date.now(),
  })
  execSession.lastModified = Date.now()
  persistSession(execSession)

  // Debug event logger — stores events in exec session turn and broadcasts to both sessions
  const currentTurn = execSession.turns[execSession.turns.length - 1]
  const logEvent = (type: import('@codecrab/shared').DebugEvent['type'], detail?: string, data?: Record<string, unknown>, parentToolUseId?: string | null, taskId?: string) => {
    const event: import('@codecrab/shared').DebugEvent = { ts: Date.now(), type, detail, data, ...(parentToolUseId != null ? { parentToolUseId } : {}), ...(taskId ? { taskId } : {}) }
    if (currentTurn) {
      currentTurn.agent.debugEvents.push(event)
      if (HIGH_VALUE_EVENT_TYPES.has(type)) {
        currentTurn.agent.messages.push(event)
      }
    }
    // For tool_result events, broadcast a truncated copy to clients
    const broadcastEvent = (type === 'tool_result' && data?.content) ? truncateToolResultEvent(event) : event
    // Broadcast sdk_event to both sessions
    broadcastToProject(projectId, {
      type: 'sdk_event',
      event: broadcastEvent,
      projectId,
      sessionId: execSessionId,
    })
    broadcastToProject(projectId, {
      type: 'sdk_event',
      event: broadcastEvent,
      projectId,
      sessionId: parentSession.sessionId,
    })
  }
  let thinkingStarted = false
  let textStarted = false

  // Broadcast new session created
  broadcastToProject(projectId, {
    type: 'session_created',
    sessionId: execSessionId,
    parentSessionId: parentSession.sessionId,
    cronJobId,
    cronJobName,
    projectId,
  })
  broadcastProjectStatuses()

  // Link queue abort to engine abort
  queuedQuery.abortController.signal.addEventListener('abort', () => {
    abortQuery(clientState)
  }, { once: true })

  // Broadcast query_start to both sessions
  broadcastToProject(projectId, { type: 'query_start', projectId, sessionId: execSessionId, queryId: queuedQuery.id })
  broadcastToProject(projectId, { type: 'query_start', projectId, sessionId: parentSession.sessionId, queryId: queuedQuery.id })
  startPeriodicHeartbeat(projectId, execSessionId, queuedQuery.id)

  logEvent('query_start', prompt.slice(0, 200))

  let finalText = ''
  let isSuccess = true
  let errorMessage = ''
  let durationMs = 0
  const startTime = Date.now()

  try {
    const stream = executeQuery(clientState, prompt, {
      onTextDelta: (text) => {
        if (!textStarted) {
          textStarted = true
        }
        finalText += text
        // Broadcast stream_delta to both sessions
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'text',
          text,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'text',
          text,
          projectId,
          sessionId: parentSession.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'text_delta', undefined, text)
        maybeSendActivityHeartbeat(projectId, execSessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onThinkingDelta: (thinking) => {
        if (!thinkingStarted) {
          thinkingStarted = true
        }
        // Broadcast thinking to both sessions
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'thinking',
          text: thinking,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'thinking',
          text: thinking,
          projectId,
          sessionId: parentSession.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'thinking_delta', undefined, thinking)
        maybeSendActivityHeartbeat(projectId, execSessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onToolUse: (toolName, toolId, input) => {
        // Reset text/thinking flags for next turn
        thinkingStarted = false
        textStarted = false
        // Broadcast tool_use to both sessions
        broadcastToProject(projectId, {
          type: 'tool_use',
          toolName,
          toolId,
          input,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'tool_use',
          toolName,
          toolId,
          input,
          projectId,
          sessionId: parentSession.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'tool_use', toolName)
        maybeSendActivityHeartbeat(projectId, execSessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onToolResult: (toolId, content, isError) => {
        // Broadcast tool_result to both sessions (truncated for client)
        const truncated = truncateToolResultForClient(content)
        broadcastToProject(projectId, {
          type: 'tool_result',
          toolId,
          content: truncated.content,
          isError,
          totalLength: truncated.totalLength,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'tool_result',
          toolId,
          content: truncated.content,
          isError,
          totalLength: truncated.totalLength,
          projectId,
          sessionId: parentSession.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'tool_result')
        maybeSendActivityHeartbeat(projectId, execSessionId, queuedQuery.id)
      },
      onSessionInit: (sdkSessionId) => {
        execSession.sdkSessionId = sdkSessionId
        persistSession(execSession)
        broadcastToProject(projectId, {
          type: 'session_resumed',
          projectId,
          sessionId: execSessionId,
        })
      },
      onPermissionRequest: () => {
        // Cron jobs bypass permissions
      },
      onAskUserQuestion: () => {
        // Cron jobs cannot ask user questions
      },
      onUsage: (usage) => {
        logEvent('usage', `in:${usage.inputTokens} out:${usage.outputTokens} cache_read:${usage.cacheReadTokens} cache_create:${usage.cacheCreationTokens}`, usage as any)
        queryQueue.touchActivity(queuedQuery.id, 'usage')
        maybeSendActivityHeartbeat(projectId, execSessionId, queuedQuery.id)
      },
      onSdkLog: (type, detail, data, parentToolUseId, taskId) => {
        logEvent(type as any, detail, data, parentToolUseId, taskId)
      },
    })

    for await (const event of stream) {
      switch (event.type) {
        case 'system_init': {
          const initData = event.data as any
          if (initData.sdkMcpServers || initData.sdkSkills) {
            broadcastToProject(projectId, {
              type: 'system',
              subtype: 'init',
              projectId,
              sessionId: execSessionId,
              tools: initData.tools,
              sdkMcpServers: initData.sdkMcpServers,
              sdkSkills: initData.sdkSkills,
            })
          }
          break
        }
        case 'text_delta':
          break
        case 'thinking_delta':
          break
        case 'tool_use':
          break
        case 'tool_result':
          break
        case 'result': {
          const resultData = event.data as any
          if (resultData.durationMs) {
            durationMs = resultData.durationMs
          }
          if (resultData.isError) {
            isSuccess = false
          }
          logEvent('result', `${resultData.subtype || 'end_turn'} | $${resultData.costUsd?.toFixed(4) || '?'} | ${((resultData.durationMs || 0) / 1000).toFixed(1)}s`, {
            subtype: resultData.subtype,
            costUsd: resultData.costUsd,
            durationMs: resultData.durationMs,
            isError: resultData.isError,
          })
          // Broadcast result to both sessions
          broadcastToProject(projectId, {
            type: 'result',
            subtype: resultData.subtype,
            costUsd: resultData.costUsd,
            durationMs: resultData.durationMs,
            result: resultData.result,
            isError: resultData.isError,
            projectId,
            sessionId: execSessionId,
          })
          broadcastToProject(projectId, {
            type: 'result',
            subtype: resultData.subtype,
            costUsd: resultData.costUsd,
            durationMs: resultData.durationMs,
            result: resultData.result,
            isError: resultData.isError,
            projectId,
            sessionId: parentSession.sessionId,
          })
          break
        }
      }
    }

    // Reset engine accumulation state (we use turns now, not ChatMessage)
    const assistantMsg = storeAssistantMessage(clientState)
    if (assistantMsg) {
      finalText = assistantMsg.content
      execSession.lastModified = Date.now()

      // Extract per-turn summary and suggestions (tolerant of missing closing brackets)
      const { summary: cronSummary, suggestions: cronSuggestions } = extractMetaTags(assistantMsg.content)
      if (cronSummary && currentTurn) {
        currentTurn.summary = cronSummary
        execSession.summary = `${cronJobName || 'Scheduled Task'}: ${cronSummary}`
        console.log(`[cron] Summary: ${cronSummary}`)
        broadcastToProject(projectId, {
          type: 'query_summary',
          summary: cronSummary,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'query_summary',
          summary: cronSummary,
          projectId,
          sessionId: parentSession.sessionId,
        })
      }
      if (cronSuggestions.length > 0) {
        broadcastToProject(projectId, {
          type: 'query_suggestions',
          suggestions: cronSuggestions,
          projectId,
          sessionId: execSessionId,
        })
        broadcastToProject(projectId, {
          type: 'query_suggestions',
          suggestions: cronSuggestions,
          projectId,
          sessionId: parentSession.sessionId,
        })
      }

      // Broadcast final assistant_text to both sessions
      broadcastToProject(projectId, {
        type: 'assistant_text',
        text: assistantMsg.content,
        projectId,
        sessionId: execSessionId,
      })
    }

    execSession.lastModified = Date.now()
    execSession.status = 'idle'
    persistSession(execSession)

  } catch (err: any) {
    logEvent('error', err.message || 'Cron query failed')
    console.error('[cron] Query error:', err)
    isSuccess = false
    errorMessage = err.message || 'Cron query failed'
    execSession.status = 'error'
    persistSession(execSession)
  } finally {
    durationMs = durationMs || Date.now() - startTime
    removeAllClientStates(cronClientId)
    cleanupHeartbeat(queuedQuery.id)
    clearProjectActivity(projectId)

    // Broadcast query_end to both sessions
    broadcastToProject(projectId, {
      type: 'query_end',
      projectId,
      sessionId: execSessionId,
      queryId: queuedQuery.id,
    })
    broadcastToProject(projectId, {
      type: 'query_end',
      projectId,
      sessionId: parentSession.sessionId,
      queryId: queuedQuery.id,
    })
  }

  // Insert cron result turn into parent session with full debug events from exec session
  const resultSummary = isSuccess
    ? `Completed successfully in ${durationMs}ms`
    : `Failed: ${errorMessage}`
  const now = Date.now()

  // Copy debug events from exec session turn so clients can render full content
  const execTurnEvents = currentTurn?.agent.debugEvents || []
  const execTurnMessages = currentTurn?.agent.messages || []

  // Append a final result event with execSessionId reference
  const resultEvent: import('@codecrab/shared').DebugEvent = {
    ts: now, type: 'result', detail: resultSummary,
    data: { costUsd: clientState.currentCostUsd, durationMs, execSessionId },
  }

  parentSession.turns.push({
    prompt: { type: 'cron', text: prompt, cronJobId: metadata?.cronJobId, cronJobName },
    agent: {
      messages: [...execTurnMessages],
      debugEvents: [...execTurnEvents, resultEvent],
    },
    timestamp: now,
  })
  parentSession.lastModified = Date.now()
  persistSession(parentSession)

  // Broadcast result summary to parent session
  const resultText = `[Scheduled Task Completed: ${cronJobName || 'Task'}]\nResult: ${resultSummary}`
  broadcastToProject(projectId, {
    type: 'assistant_text',
    text: resultText,
    projectId,
    sessionId: parentSession.sessionId,
  })

  // Broadcast cron_task_completed for session list UI
  broadcastToProject(projectId, {
    type: 'cron_task_completed',
    cronJobId,
    cronJobName,
    parentSessionId: parentSession.sessionId,
    execSessionId,
    success: isSuccess,
    projectId,
  })
  broadcastProjectStatuses()

  // Send push notification (use extracted summary or fallback)
  const { summary: cronPushSummary } = extractMetaTags(finalText)
  const pushSummary = cronPushSummary || `${cronJobName || 'Scheduled Task'}: ${resultSummary}`
  sendQueryCompletionPush(pushSummary, projectId, parentSession.sessionId)

  if (isSuccess) {
    return { success: true, output: finalText.slice(0, 500), queryId: queuedQuery.id }
  } else {
    return { success: false, error: errorMessage, queryId: queuedQuery.id }
  }
}

// Get full session messages for HTTP API (derived from turns)
export function getSessionMessages(sessionId: string): ChatMessage[] | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return turnsToMessages(session.turns)
}

// Get debug events for a session (derived from turns)
export function getSessionDebugEvents(sessionId: string): import('@codecrab/shared').DebugEvent[] | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return turnsToDebugEvents(session.turns)
}

// Get session history optimized for client consumption (HTTP endpoint).
// Returns user messages + high-value SDK events (much smaller than full debugEvents).
// If the session is processing, excludes the last (in-progress) turn.
// Supports incremental fetch: if afterTurn is provided, only returns turns newer than that timestamp.
export async function getSessionHistory(sessionId: string, afterTurn?: number): Promise<{
  messages: import('@codecrab/shared').ChatMessageSummary[]
  sdkEvents: import('@codecrab/shared').DebugEvent[]
  status: string
  summary?: string
  suggestions?: string[]
  processingTurnTimestamp?: number
} | null> {
  // Try memory first, then disk
  let session = sessions.get(sessionId)
  if (!session) {
    try {
      const filePath = path.join(SESSIONS_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content)
      if (data.sessionId) {
        session = {
          sessionId: data.sessionId,
          sdkSessionId: data.sdkSessionId,
          projectId: data.projectId,
          cwd: data.cwd,
          turns: data.turns || [],
          status: 'idle',
          lastModified: data.lastModified || Date.now(),
          summary: data.summary,
          firstPrompt: data.firstPrompt,
          pendingQuestion: data.pendingQuestion || null,
          pendingPermissionRequest: data.pendingPermissionRequest || null,
        }
        sessions.set(session.sessionId, session)
      }
    } catch {
      // not found
    }
  }
  if (!session) return null

  // Include all turns, even the in-progress one when processing.
  // The client needs the current turn's accumulated data (completed thinking,
  // text, tool_use, tool_result events) to display a complete picture.
  const isProcessing = session.status === 'processing'
  const inProgressTurn = isProcessing && session.turns.length > 0
    ? session.turns[session.turns.length - 1]
    : null
  let turns = session.turns

  // Incremental fetch: only return turns after the given timestamp.
  // Always include the in-progress turn even if previously fetched,
  // because its content keeps growing as the agent works.
  if (afterTurn) {
    turns = turns.filter(t => t.timestamp > afterTurn || t === inProgressTurn)
  }

  // User messages as summaries
  const messages = turnsToMessages(turns).map(toMessageSummary)

  // SDK events for client display.
  // Completed turns: high-value events only (from turn.agent.messages) to keep payload small.
  // In-progress turn: ALL debug events (from turn.agent.debugEvents) so the client's
  // debug timeline matches what was visible via WebSocket before re-entering.
  const sdkEvents: import('@codecrab/shared').DebugEvent[] = []
  for (const turn of turns) {
    const events = turn === inProgressTurn ? turn.agent.debugEvents : turn.agent.messages
    for (const event of events) {
      sdkEvents.push(event.type === 'tool_result' ? truncateToolResultEvent(event) : event)
    }
  }

  // Extract suggestions from last text event (always from full session, not just delta)
  let suggestions: string[] | undefined
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const msgs = session.turns[i].agent.messages
    const textEvt = [...msgs].reverse().find(e => e.type === 'text' && e.data?.content)
    if (textEvt) {
      const textContent = textEvt.data?.content as string
      const sugMatch = textContent.match(/\[SUGGESTIONS:\s*(.+)\]\s*$/m)
      if (sugMatch) {
        suggestions = sugMatch[1].split('|').map((s: string) => s.trim()).filter(Boolean)
      }
      break
    }
  }

  return {
    messages,
    sdkEvents,
    status: session.status,
    summary: session.summary,
    suggestions,
    processingTurnTimestamp: inProgressTurn?.timestamp,
  }
}

/** Derive flat ChatMessage[] from turns (for API/web compat) */
function turnsToMessages(turns: import('@codecrab/shared').SessionTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const turn of turns) {
    // User/cron prompt as a ChatMessage
    messages.push({
      id: `turn-${turn.timestamp}`,
      role: 'user',
      content: turn.prompt.text,
      images: turn.prompt.images,
      timestamp: turn.timestamp,
    })
  }
  return messages
}

/** Derive flat DebugEvent[] from turns (for API/web compat) */
function turnsToDebugEvents(turns: import('@codecrab/shared').SessionTurn[]): import('@codecrab/shared').DebugEvent[] {
  const events: import('@codecrab/shared').DebugEvent[] = []
  for (const turn of turns) {
    events.push(...turn.agent.debugEvents)
  }
  return events
}

// --- Session persistence ---
const SESSIONS_DIR = path.join(os.homedir(), '.codecrab', 'sessions')

async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
}

function sessionFilePath(sessionId: string): string {
  // Sanitize sessionId to prevent path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(SESSIONS_DIR, `${safe}.json`)
}

async function persistSession(session: Session) {
  try {
    await ensureSessionsDir()
    const data = {
      sessionId: session.sessionId,
      sdkSessionId: session.sdkSessionId,
      projectId: session.projectId,
      cwd: session.cwd,
      turns: session.turns,
      status: session.status,
      lastModified: session.lastModified,
      summary: session.summary,
      firstPrompt: session.firstPrompt,
      pendingQuestion: session.pendingQuestion || null,
      pendingPermissionRequest: session.pendingPermissionRequest || null,
    }
    await fs.writeFile(sessionFilePath(session.sessionId), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[sessions] Failed to persist session ${session.sessionId}:`, err)
  }
}

async function deletePersistedSession(sessionId: string) {
  try {
    await fs.unlink(sessionFilePath(sessionId))
  } catch {
    // File may not exist, ignore
  }
}

async function loadPersistedSessions() {
  try {
    await ensureSessionsDir()
    const files = await fs.readdir(SESSIONS_DIR)
    let loaded = 0
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const content = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8')
        const data = JSON.parse(content)
        if (data.sessionId && !sessions.has(data.sessionId)) {
          const turns: import('@codecrab/shared').SessionTurn[] = data.turns || []

          const session: Session = {
            sessionId: data.sessionId,
            sdkSessionId: data.sdkSessionId,
            projectId: data.projectId,
            cwd: data.cwd,
            turns,
            status: 'idle', // Always start as idle on reload
            lastModified: data.lastModified || Date.now(),
            summary: data.summary,
            firstPrompt: data.firstPrompt,
            pendingQuestion: data.pendingQuestion || null,
            pendingPermissionRequest: data.pendingPermissionRequest || null,
          }
          sessions.set(session.sessionId, session)
          loaded++
        }
      } catch (err) {
        console.error(`[sessions] Failed to load session file ${file}:`, err)
      }
    }
    if (loaded > 0) {
      console.log(`[sessions] Loaded ${loaded} persisted sessions from disk`)
    }
  } catch (err) {
    console.error('[sessions] Failed to load persisted sessions:', err)
  }
}

// Load persisted sessions on module init
loadPersistedSessions()

// Per-project subscription state for a client
interface ProjectSubscription {
  sessionId?: string  // Local session ID for this project
}

interface Client {
  ws: WebSocket
  connectionId: string
  clientId: string
  // Projects this client is subscribed to (receives broadcasts for)
  subscribedProjects: Map<string, ProjectSubscription>
}

interface Session {
  sessionId: string
  sdkSessionId?: string  // Claude SDK session ID (for resume)
  projectId?: string
  cwd?: string
  turns: import('@codecrab/shared').SessionTurn[]
  status: 'idle' | 'processing' | 'error'
  lastModified: number
  summary?: string
  firstPrompt?: string
  pendingQuestion?: { toolId: string; questions: any[] } | null
  pendingPermissionRequest?: { requestId: string; toolName: string; input: any; reason?: string } | null
}

/** Event types that are kept in turn.agent.messages (high-value) */
const HIGH_VALUE_EVENT_TYPES = new Set(['thinking', 'text', 'tool_use', 'tool_result', 'task_started', 'task_progress', 'task_notification'])

/** Maximum length for tool_result content sent to clients (full content is kept in session) */
const MAX_TOOL_RESULT_CLIENT_LENGTH = 300

/** Truncate tool result content for client delivery, preserving full content in session storage */
function truncateToolResultForClient(content: string): { content: string; totalLength?: number } {
  if (content.length <= MAX_TOOL_RESULT_CLIENT_LENGTH) {
    return { content }
  }
  return {
    content: content.slice(0, MAX_TOOL_RESULT_CLIENT_LENGTH) + `\n... (total: ${content.length} chars)`,
    totalLength: content.length,
  }
}

/** Create a truncated copy of a tool_result DebugEvent for client broadcast */
function truncateToolResultEvent(event: import('@codecrab/shared').DebugEvent): import('@codecrab/shared').DebugEvent {
  const content = event.data?.content
  if (typeof content !== 'string' || content.length <= MAX_TOOL_RESULT_CLIENT_LENGTH) {
    return event
  }
  const truncated = truncateToolResultForClient(content)
  return { ...event, data: { ...event.data, content: truncated.content, totalLength: truncated.totalLength } }
}

const clients = new Map<string, Client>()
const sessions = new Map<string, Session>()

let messageIdCounter = 0
function genId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  switch (toolName) {
    case 'Read': case 'ReadFile': case 'Write': case 'WriteFile': case 'Edit': case 'EditFile':
      return String(obj.file_path || obj.path || '').slice(0, 120)
    case 'Bash': case 'bash':
      return String(obj.command || '').slice(0, 120)
    case 'Glob': case 'Grep':
      return String(obj.pattern || '').slice(0, 120)
    case 'ToolSearch':
      return String(obj.query || '').slice(0, 120)
    default: {
      const firstStr = Object.values(obj).find((v) => typeof v === 'string')
      return firstStr ? String(firstStr).slice(0, 80) : ''
    }
  }
}

function generateSessionIdLocal(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Resume an existing session
async function resumeSessionForProject(client: Client, projectId: string, sessionId: string): Promise<Session | null> {
  let session = sessions.get(sessionId)

  // If not in memory, try loading from disk (multi-process scenario)
  if (!session) {
    try {
      const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`)
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content)
      if (data.sessionId) {
        const turns: import('@codecrab/shared').SessionTurn[] = data.turns || []
        session = {
          sessionId: data.sessionId,
          sdkSessionId: data.sdkSessionId,
          projectId: data.projectId,
          cwd: data.cwd,
          turns,
          status: 'idle',
          lastModified: data.lastModified || Date.now(),
          summary: data.summary,
          firstPrompt: data.firstPrompt,
          pendingQuestion: data.pendingQuestion || null,
          pendingPermissionRequest: data.pendingPermissionRequest || null,
        }
        sessions.set(session.sessionId, session)
      }
    } catch {
      // File doesn't exist or is unreadable
    }
  }

  if (!session) return null

  // Session must belong to the same project
  if (session.projectId && projectId && session.projectId !== projectId) {
    return null
  }

  // Update client subscription
  const sub = client.subscribedProjects.get(projectId)
  if (sub) {
    sub.sessionId = sessionId
  }

  session.status = 'idle'
  persistSession(session)
  return session
}

// Sync any new/updated sessions from disk into the in-memory cache.
// This handles multi-process scenarios where another server instance
// may have created sessions that this process doesn't know about.
async function syncSessionsFromDisk() {
  try {
    await ensureSessionsDir()
    const files = await fs.readdir(SESSIONS_DIR)
    let synced = 0
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = path.join(SESSIONS_DIR, file)
        const stat = await fs.stat(filePath)
        const sessionId = file.replace('.json', '')
        const existing = sessions.get(sessionId)

        // Skip if already in memory and disk file is not newer
        if (existing && existing.lastModified >= stat.mtimeMs) continue

        const content = await fs.readFile(filePath, 'utf-8')
        const data = JSON.parse(content)
        if (!data.sessionId) continue

        // Skip if already in memory and memory version is newer or equal
        if (existing && existing.lastModified >= (data.lastModified || 0)) continue

        const turns: import('@codecrab/shared').SessionTurn[] = data.turns || []
        const session: Session = {
          sessionId: data.sessionId,
          sdkSessionId: data.sdkSessionId,
          projectId: data.projectId,
          cwd: data.cwd,
          turns,
          status: 'idle',
          lastModified: data.lastModified || Date.now(),
          summary: data.summary,
          firstPrompt: data.firstPrompt,
          pendingQuestion: data.pendingQuestion || null,
          pendingPermissionRequest: data.pendingPermissionRequest || null,
        }
        sessions.set(session.sessionId, session)
        synced++
      } catch {
        // Skip unreadable files
      }
    }
    if (synced > 0) {
      console.log(`[sessions] Synced ${synced} sessions from disk`)
    }
  } catch {
    // Non-fatal
  }
}

// Get all sessions for a project or globally
export async function getSessionsList(projectId?: string, cwd?: string): Promise<SessionInfo[]> {
  // Re-sync from disk to pick up sessions created by other processes
  await syncSessionsFromDisk()

  const result: SessionInfo[] = []

  for (const session of sessions.values()) {
    // Skip empty sessions (no turns = nothing to resume)
    if (session.turns.length === 0) continue

    // Filter by project if specified
    if (projectId && session.projectId !== projectId) continue

    // Filter by cwd if specified
    if (cwd && session.cwd !== cwd) continue

    // Check if this session is active (has any connected client subscribed)
    const isActive = Array.from(clients.values()).some((c) => {
      for (const sub of c.subscribedProjects.values()) {
        if (sub.sessionId === session.sessionId) return true
      }
      return false
    })

    // Detect cron session: check if any turn has a cron prompt
    const cronTurn = session.turns.find((t) => t.prompt.type === 'cron')
    const cronJobName = cronTurn?.prompt.cronJobName

    result.push({
      sessionId: session.sessionId,
      summary: session.summary || '',
      lastModified: session.lastModified,
      firstPrompt: session.firstPrompt,
      cwd: session.cwd,
      status: session.status,
      isActive,
      projectId: session.projectId,
      cronJobName,
    })
  }

  // Sort by last modified desc
  result.sort((a, b) => b.lastModified - a.lastModified)
  return result
}

// Delete a session
export function deleteSession(sessionId: string): boolean {
  const deleted = sessions.delete(sessionId)
  if (deleted) {
    deletePersistedSession(sessionId)
  }
  return deleted
}

// Broadcast message to all clients subscribed to a project
function broadcastToProject(projectId: string | undefined, message: ServerMessage, excludeConnectionId?: string) {
  if (!projectId) return
  // Stamp projectId on the message
  const stamped = { ...message, projectId }
  const data = JSON.stringify(stamped)
  for (const [connectionId, client] of clients) {
    if (excludeConnectionId && connectionId === excludeConnectionId) continue
    if (client.subscribedProjects.has(projectId) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data)
    }
  }
}

// Send message to a specific client
function sendToClient(client: Client, message: ServerMessage) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message))
  }
}

// Maximum preview length for tool call results
const MAX_TOOL_RESULT_PREVIEW_LENGTH = 100

// Convert ChatMessage to summary for initial history load
// Assistant and user messages are sent in full; only tool call results are truncated
function toMessageSummary(message: ChatMessage): import('@codecrab/shared').ChatMessageSummary {
  const content = (message.content || '').replace(/\n?\[SUGGESTIONS:\s*.+\]\s*$/m, '').replace(/\n?\[SUMMARY:\s*.+\]\s*$/m, '').trimEnd()
  const hasToolCalls = !!(message.toolCalls && message.toolCalls.length > 0)
  const hasImages = !!(message.images && message.images.length > 0)

  // For assistant/user: always send full content
  // For system with tool calls: content is usually empty, tool data is sent separately
  const isTruncated = false // We no longer truncate content text

  // Build tool call summaries - preserve input object for structured display
  let toolCalls: import('@codecrab/shared').ChatMessageSummary['toolCalls']
  if (message.toolCalls && message.toolCalls.length > 0) {
    toolCalls = message.toolCalls.map((tc) => {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
      return {
        name: tc.name,
        id: tc.id,
        input: tc.input, // Send original structured input for iOS to parse
        inputSummary: inputStr.slice(0, MAX_TOOL_RESULT_PREVIEW_LENGTH),
        resultPreview: tc.result ? tc.result.slice(0, MAX_TOOL_RESULT_PREVIEW_LENGTH) : undefined,
        isError: tc.isError,
      }
    })
  }

  return {
    id: message.id,
    role: message.role,
    content,
    contentPreview: content.slice(0, 100),
    isTruncated,
    hasToolCalls,
    hasImages,
    timestamp: message.timestamp,
    toolCalls,
    costUsd: message.costUsd,
    durationMs: message.durationMs,
  }
}

// Send message history summary (truncated, for initial load)
function sendMessageHistoryInChunks(
  client: Client,
  projectId: string,
  sessionId: string,
  messages: ChatMessage[]
) {
  if (messages.length === 0) return

  // Convert to summaries
  const summaries = messages.map(toMessageSummary)

  // Send all summaries as single message (they're small now)
  sendToClient(client, {
    type: 'message_history',
    projectId,
    sessionId,
    messages: summaries,
  })
}

// Send to specific WebSocket
function safeSend(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

// Broadcast message to ALL connected clients (regardless of project)
function broadcastGlobal(message: ServerMessage) {
  const data = JSON.stringify(message)
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data)
    }
  }
}

// Collect current status of all projects that have connected clients or active queries
function getProjectStatuses(): ProjectStatus[] {
  // Include projects from subscribed clients AND projects with active queries
  const projectIds = new Set<string>()
  for (const client of clients.values()) {
    for (const pid of client.subscribedProjects.keys()) {
      projectIds.add(pid)
    }
  }
  for (const id of getActiveProjectIds()) {
    projectIds.add(id)
  }

  const statuses: ProjectStatus[] = []
  for (const projectId of projectIds) {
    const projectState = getProjectState(projectId)
    const hasActiveQuery = !!projectState?.activeQuery || queryQueue.isProjectBusy(projectId)

    // Find the active/processing session and latest session for this project
    let activeSessionId: string | undefined
    let firstPrompt: string | undefined
    let sessionProcessing = false
    let latestModified: number | undefined
    for (const session of sessions.values()) {
      if (session.projectId !== projectId) continue
      if (session.status === 'processing') {
        activeSessionId = session.sessionId
        firstPrompt = session.firstPrompt
        sessionProcessing = true
      }
      if (session.turns.length > 0 && (!latestModified || session.lastModified > latestModified)) {
        latestModified = session.lastModified
        if (!activeSessionId) {
          firstPrompt = session.firstPrompt
        }
      }
    }

    // Consider processing if either engine has active query OR session is marked processing
    const isProcessing = hasActiveQuery || sessionProcessing

    statuses.push({
      projectId,
      status: isProcessing ? 'processing' : 'idle',
      sessionId: activeSessionId,
      firstPrompt,
      lastModified: latestModified,
    })
  }
  return statuses
}

// Broadcast current project statuses to all clients
function broadcastProjectStatuses() {
  broadcastGlobal({
    type: 'project_statuses',
    statuses: getProjectStatuses(),
  })
}

// Auto-resume logic for a project: find the best session to resume
function autoResumeSessionForProject(client: Client, clientId: string, projectId: string): Session | undefined {
  const projectState = getProjectState(projectId)
  const hasActiveQuery = !!projectState?.activeQuery || queryQueue.isProjectBusy(projectId)
  const SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
  let session: Session | undefined

  if (hasActiveQuery) {
    // Always resume a processing session
    for (const s of sessions.values()) {
      if (s.projectId === projectId && s.status === 'processing') {
        session = s
        const sub = client.subscribedProjects.get(projectId)
        if (sub) sub.sessionId = s.sessionId
        const clientState = getClientState(clientId, projectId)
        if (clientState) clientState.sessionId = s.sdkSessionId
        console.log(`[ws] Auto-resuming active session ${s.sessionId} for project ${projectId}`)
        break
      }
    }
  }

  // If no active query, only resume if the latest session was active within threshold
  if (!session) {
    let latestSession: Session | undefined
    for (const s of sessions.values()) {
      if (s.projectId !== projectId || s.turns.length === 0) continue
      if (!latestSession || s.lastModified > latestSession.lastModified) {
        latestSession = s
      }
    }
    if (latestSession && (Date.now() - latestSession.lastModified) < SESSION_ACTIVE_THRESHOLD_MS) {
      session = latestSession
      const sub = client.subscribedProjects.get(projectId)
      if (sub) sub.sessionId = latestSession.sessionId
      const clientState = getClientState(clientId, projectId)
      if (clientState) clientState.sessionId = latestSession.sdkSessionId
      console.log(`[ws] Resuming recent session ${latestSession.sessionId} for project ${projectId} (${Math.round((Date.now() - latestSession.lastModified) / 1000)}s ago)`)
    }
  }

  return session
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const clientId = url.searchParams.get('clientId') || `anon-${Date.now()}`
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Check auth token from query param
    const token = url.searchParams.get('token')
    const validToken = await getToken()
    if (validToken && token !== validToken) {
      ws.close(1008, 'Invalid token')
      return
    }

    const client: Client = { ws, connectionId, clientId, subscribedProjects: new Map() }
    clients.set(connectionId, client)

    // Attach client info to WebSocket for cron executor lookup
    ;(ws as any).clientInfo = { clientId }

    tsLog('[ws]', `Client connected — clientId=${clientId}, connectionId=${connectionId}`)

    // Send global state on connect
    let models = getCachedModels()
    if (!models) {
      models = loadModelsFromConfig()
    }
    if (models && models.length > 0) {
      sendToClient(client, {
        type: 'available_models',
        models,
      })
    }

    // Send current project statuses
    sendToClient(client, {
      type: 'project_statuses',
      statuses: getProjectStatuses(),
    })

    ws.on('message', async (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        await handleClientMessage(ws, client, msg)
      } catch (err) {
        console.error('[ws] failed to parse message:', err)
        safeSend(ws, { type: 'error', message: 'Invalid message format' })
      }
    })

    ws.on('close', () => {
      console.log(`[ws] client disconnected: ${clientId} (${connectionId})`)
      clients.delete(connectionId)

      // Update session statuses for all subscribed projects
      for (const [projectId, sub] of client.subscribedProjects) {
        if (sub.sessionId) {
          const session = sessions.get(sub.sessionId)
          if (session) {
            const hasOtherClients = Array.from(clients.values()).some((c) => {
              const otherSub = c.subscribedProjects.get(projectId)
              return otherSub?.sessionId === sub.sessionId
            })
            const projectState = getProjectState(projectId)
            const hasActiveQuery = !!projectState?.activeQuery
            if (!hasOtherClients && session.status === 'processing' && !hasActiveQuery) {
              session.status = 'idle'
            }
          }
        }
      }

      // Clean up client states ONLY if this was the last connection for this clientId
      const hasOtherConnectionsForClientId = Array.from(clients.values()).some((c) => c.clientId === clientId)
      if (!hasOtherConnectionsForClientId) {
        removeAllClientStates(clientId)
      }
    })

    ws.on('error', (err) => {
      console.error(`[ws] client error: ${clientId} (${connectionId})`, err)
    })
  })

  console.log('[ws] WebSocket server ready')

  return wss
}

// Helper to get or create session lazily (on first message for a project)
function getOrCreateSessionForProject(
  client: Client,
  clientId: string,
  projectId: string,
  clientState: import('../engine/claude.js').ClientState
): Session {
  // Check if client already has a session for this project
  const sub = client.subscribedProjects.get(projectId)
  const existingSessionId = sub?.sessionId
  if (existingSessionId && sessions.has(existingSessionId)) {
    const existingSession = sessions.get(existingSessionId)!
    clientState.sessionId = existingSession.sdkSessionId
    return existingSession
  }

  // Create new session
  const sessionId = generateSessionIdLocal()
  const session: Session = {
    sessionId,
    projectId,
    turns: [],
    status: 'idle',
    lastModified: Date.now(),
  }
  sessions.set(sessionId, session)
  if (sub) sub.sessionId = sessionId

  console.log(`[ws] Created new session ${sessionId} for client ${clientId} project ${projectId}`)

  // Sync CWD with project state
  const projectState = getOrCreateProjectState(projectId)
  session.cwd = projectState.cwd

  persistSession(session)

  // Notify client of new session
  const modelDisplay = projectState.model
    ? getModelDisplayName(projectState.model)
    : getDefaultModelConfig()?.name || 'Default'
  sendToClient(client, {
    type: 'system',
    subtype: 'init',
    projectId,
    sessionId: session.sessionId,
    model: modelDisplay,
  })

  // Send available models
  const models = getCachedModels()
  if (models && models.length > 0) {
    sendToClient(client, {
      type: 'available_models',
      models,
    })
  }

  return session
}

// Get or create client state for a specific project
function getOrCreateClientStateForProject(
  clientId: string,
  projectId: string
): import('../engine/claude.js').ClientState {
  let clientState = getClientState(clientId, projectId)
  if (!clientState) {
    const cwd = process.cwd()
    clientState = createClientState(clientId, projectId, cwd)
    const projectState = getOrCreateProjectState(projectId)
    clientState.cwd = projectState.cwd
    clientState.sessionId = projectState.sessionId
  }
  return clientState
}

// Internal: execute a user query (called by the queue when it's this query's turn)
async function executeUserQuery(
  client: Client,
  session: Session,
  clientState: import('../engine/claude.js').ClientState,
  projectId: string,
  prompt: string,
  images: import('@codecrab/shared').ImageAttachment[] | undefined,
  enabledMcps: string[] | undefined,
  disabledSdkServers: string[] | undefined,
  disabledSkills: string[] | undefined,
  queuedQuery: QueuedQuery,
  userMsg: ChatMessage,
  turn: import('@codecrab/shared').SessionTurn,
): Promise<QueryResult> {
  // Link queue abort to engine abort
  queuedQuery.abortController.signal.addEventListener('abort', () => {
    abortQuery(clientState)
  }, { once: true })

  // Broadcast user message to all clients (including sender) when query starts executing
  // Update timestamp to execution time so turnGroups correctly orders events after this message
  const execTimestamp = Date.now()
  userMsg.id = `turn-${execTimestamp}`
  userMsg.timestamp = execTimestamp
  turn.timestamp = execTimestamp
  const projState = getOrCreateProjectState(projectId)
  projState.messages.push(userMsg)
  broadcastToProject(
    projectId,
    { type: 'user_message', message: userMsg, projectId, sessionId: session.sessionId },
  )

  session.status = 'processing'
  tsLog('[ws]', `Query started — project=${projectId}, session=${session.sessionId}, query=${queuedQuery.id}, prompt=${prompt.slice(0, 80)}`)
  broadcastToProject(projectId, { type: 'query_start', projectId, sessionId: session.sessionId, queryId: queuedQuery.id })
  broadcastProjectStatuses()
  startPeriodicHeartbeat(projectId, session.sessionId, queuedQuery.id)

  // Debug event logger for this query — uses the captured turn reference
  const currentTurn = turn
  const logEvent = (type: import('@codecrab/shared').DebugEvent['type'], detail?: string, data?: Record<string, unknown>, parentToolUseId?: string | null, taskId?: string) => {
    const event: import('@codecrab/shared').DebugEvent = { ts: Date.now(), type, detail, data, ...(parentToolUseId != null ? { parentToolUseId } : {}), ...(taskId ? { taskId } : {}) }
    if (currentTurn) {
      currentTurn.agent.debugEvents.push(event)
      if (HIGH_VALUE_EVENT_TYPES.has(type)) {
        currentTurn.agent.messages.push(event)
      }
    }
    // For tool_result events, broadcast a truncated copy to clients
    const broadcastEvent = (type === 'tool_result' && data?.content) ? truncateToolResultEvent(event) : event
    broadcastToProject(projectId, {
      type: 'sdk_event',
      event: broadcastEvent,
      projectId,
      sessionId: session.sessionId,
    })
  }
  let thinkingStarted = false
  let textStarted = false

  logEvent('query_start', prompt.slice(0, 200))

  try {
    const stream = executeQuery(clientState, prompt, {
      onTextDelta: (text) => {
        if (!textStarted) {
          textStarted = true
        }
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'text',
          text,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'text_delta', undefined, text)
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onThinkingDelta: (thinking) => {
        if (!thinkingStarted) {
          thinkingStarted = true
        }
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'thinking',
          text: thinking,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'thinking_delta', undefined, thinking)
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onToolUse: (toolName, toolId, input) => {
        // Reset text/thinking flags for next turn
        thinkingStarted = false
        textStarted = false
        tsLog('[ws]', `Tool use — project=${projectId}, query=${queuedQuery.id}, tool=${toolName}`)
        broadcastToProject(projectId, {
          type: 'tool_use',
          toolName,
          toolId,
          input,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'tool_use', toolName)
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
        maybeBroadcastProjectActivity(projectId, queuedQuery.id)
      },
      onToolResult: (toolId, content, isError) => {
        const truncated = truncateToolResultForClient(content)
        tsLog('[ws]', `Tool result — project=${projectId}, query=${queuedQuery.id}, toolId=${toolId}, error=${isError}`)
        broadcastToProject(projectId, {
          type: 'tool_result',
          toolId,
          content: truncated.content,
          isError,
          totalLength: truncated.totalLength,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'tool_result')
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onSessionInit: (sdkSessionId) => {
        session.sdkSessionId = sdkSessionId
        persistSession(session)
        const ps = getOrCreateProjectState(projectId)
        ps.sessionId = sdkSessionId
        broadcastToProject(projectId, {
          type: 'session_resumed',
          projectId,
          sessionId: session.sessionId,
        })
      },
      onPermissionRequest: (requestId, toolName, input, reason) => {
        logEvent('permission_request', `${toolName}: ${reason || ''}`, { toolName, requestId })
        const projStateForP = getOrCreateProjectState(projectId)
        const permData = { requestId, toolName, input, reason }
        projStateForP.pendingPermissionRequest = permData
        session.pendingPermissionRequest = permData
        persistSession(session)
        broadcastToProject(projectId, {
          type: 'permission_request',
          requestId,
          toolName,
          input,
          reason,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.pauseTimeout(queuedQuery.id)
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onAskUserQuestion: (toolId, questions) => {
        logEvent('tool_use', `AskUserQuestion toolId=${toolId}`, { toolId } as any)
        const questionData = { toolId, questions: questions as any }
        const projStateForQ = getOrCreateProjectState(projectId)
        projStateForQ.pendingQuestion = questionData
        session.pendingQuestion = questionData
        persistSession(session)
        broadcastToProject(projectId, {
          type: 'ask_user_question',
          ...questionData,
          projectId,
          sessionId: session.sessionId,
        } as any)
        queryQueue.pauseTimeout(queuedQuery.id)
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onUsage: (usage) => {
        logEvent('usage', `in:${usage.inputTokens} out:${usage.outputTokens} cache_read:${usage.cacheReadTokens} cache_create:${usage.cacheCreationTokens}`, usage as any)
        queryQueue.touchActivity(queuedQuery.id, 'usage')
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onSdkLog: (type, detail, data, parentToolUseId, taskId) => {
        logEvent(type as any, detail, data, parentToolUseId, taskId)
      },
    }, images, enabledMcps, disabledSdkServers, disabledSkills)

    let finalText = ''
    for await (const event of stream) {
      switch (event.type) {
        case 'system_init': {
          // Forward SDK MCP servers and skills to clients
          const initData = event.data as any
          if (initData.sdkMcpServers || initData.sdkSkills) {
            broadcastToProject(projectId, {
              type: 'system',
              subtype: 'init',
              projectId,
              sessionId: session.sessionId,
              tools: initData.tools,
              sdkMcpServers: initData.sdkMcpServers,
              sdkSkills: initData.sdkSkills,
            })
          }
          break
        }
        case 'text_delta':
          finalText += (event.data as any).text
          break
        case 'thinking_delta':
          break
        case 'tool_use':
          break
        case 'tool_result':
          break
        case 'result': {
          const resultData = event.data as any
          logEvent('result', `${resultData.subtype || 'end_turn'} | $${resultData.costUsd?.toFixed(4) || '?'} | ${((resultData.durationMs || 0) / 1000).toFixed(1)}s`, {
            subtype: resultData.subtype,
            costUsd: resultData.costUsd,
            durationMs: resultData.durationMs,
            isError: resultData.isError,
          })
          broadcastToProject(projectId, {
            type: 'result',
            subtype: resultData.subtype,
            costUsd: resultData.costUsd,
            durationMs: resultData.durationMs,
            result: resultData.result,
            isError: resultData.isError,
            projectId,
            sessionId: session.sessionId,
          })
          break
        }
        // ask_user_question is now handled via the onAskUserQuestion callback
        // in canUseTool, which broadcasts to clients and waits for answers.
      }
    }

    // Reset engine accumulation state; extract summary/suggestions from final content
    const assistantMsg = storeAssistantMessage(clientState)
    if (assistantMsg) {
      session.lastModified = Date.now()

      // Extract summary and suggestions (tolerant of missing closing brackets)
      const { summary: extractedSummary, suggestions } = extractMetaTags(assistantMsg.content)
      if (extractedSummary) {
        session.summary = extractedSummary
        if (currentTurn) {
          currentTurn.summary = extractedSummary
        }
        console.log(`[Summary] Extracted: ${extractedSummary}`)
        broadcastToProject(projectId, {
          type: 'query_summary',
          summary: extractedSummary,
          projectId,
          sessionId: session.sessionId,
        })
        sendQueryCompletionPush(extractedSummary, projectId, session.sessionId)
      } else {
        // No summary tag found — send fallback push with truncated user prompt
        console.log(`[Summary] No [SUMMARY: ...] tag found in response (${assistantMsg.content.length} chars)`)
        const truncatedPrompt = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt
        const fallbackSummary = `已完成: ${truncatedPrompt}`
        sendQueryCompletionPush(fallbackSummary, projectId, session.sessionId)
        broadcastToProject(projectId, {
          type: 'query_summary',
          summary: fallbackSummary,
          projectId,
          sessionId: session.sessionId,
        })
      }
      if (suggestions.length > 0) {
        console.log(`[Suggestions] Extracted ${suggestions.length}: ${suggestions.join(', ')}`)
        broadcastToProject(projectId, {
          type: 'query_suggestions',
          suggestions,
          projectId,
          sessionId: session.sessionId,
        })
      }

      persistSession(session)

      broadcastToProject(projectId, {
        type: 'assistant_text',
        text: assistantMsg.content,
        projectId,
        sessionId: session.sessionId,
      })

      finalText = assistantMsg.content
    }

    // Trigger SOUL evolution asynchronously (fire-and-forget)
    // Skip for internal projects (e.g. __soul__ itself) to avoid infinite loops
    console.log(`[SOUL] Query complete — projectId=${projectId}, finalText=${finalText.length} chars, prompt=${prompt.length} chars`)
    if (projectId && !projectId.startsWith('__')) {
      triggerSoulEvolutionAsync(prompt, finalText)
    } else {
      console.log(`[SOUL] Skipped — internal project: ${projectId}`)
    }

    return { success: true, output: finalText.slice(0, 500), queryId: queuedQuery.id }
  } catch (err: any) {
    logEvent('error', err.message || 'Query failed')
    tsLog('[ws]', `Query error — project=${projectId}, query=${queuedQuery.id}, error=${err.message}`)
    broadcastToProject(projectId, {
      type: 'error',
      message: err.message || 'Query failed',
      projectId,
      sessionId: session.sessionId,
    })
    session.status = 'error'
    persistSession(session)
    return { success: false, error: err.message || 'Query failed', queryId: queuedQuery.id }
  } finally {
    tsLog('[ws]', `Query ended — project=${projectId}, session=${session.sessionId}, query=${queuedQuery.id}`)
    session.status = 'idle'
    const projStateForEnd = getOrCreateProjectState(projectId)
    projStateForEnd.pendingQuestion = null
    projStateForEnd.pendingPermissionRequest = null
    session.pendingQuestion = null
    session.pendingPermissionRequest = null
    cleanupHeartbeat(queuedQuery.id)
    clearProjectActivity(projectId)
    broadcastToProject(projectId, {
      type: 'query_end',
      projectId,
      sessionId: session.sessionId,
      queryId: queuedQuery.id,
    })
    broadcastProjectStatuses()
  }
}

async function handleClientMessage(ws: WebSocket, client: Client, msg: ClientMessage) {
  // Handle switch_project separately — it's a subscription management message
  if (msg.type === 'switch_project') {
    const { projectId, projectCwd } = msg

    // Subscribe to this project
    if (!client.subscribedProjects.has(projectId)) {
      client.subscribedProjects.set(projectId, {})
    }

    // Update clientInfo for cron executor lookup
    ;(ws as any).clientInfo = { clientId: client.clientId, projectId }

    // Get or create client state for this project
    const clientState = getOrCreateClientStateForProject(client.clientId, projectId)
    if (projectCwd) {
      clientState.cwd = projectCwd
      const projectState = getOrCreateProjectState(projectId)
      projectState.cwd = projectCwd
    }

    // Auto-resume session
    const session = autoResumeSessionForProject(client, client.clientId, projectId)

    // Send init message
    const projState = getOrCreateProjectState(projectId)
    const modelDisplay = projState.model
      ? getModelDisplayName(projState.model)
      : getDefaultModelConfig()?.name || 'Default'
    sendToClient(client, {
      type: 'system',
      subtype: 'init',
      projectId,
      sessionId: session?.sessionId,
      model: modelDisplay,
    })

    // Send models
    const models = getCachedModels()
    if (models && models.length > 0) {
      sendToClient(client, {
        type: 'available_models',
        models,
      })
    }

    // History is now loaded via HTTP GET /api/sessions/:id/history
    // to avoid large WebSocket frames that crash mobile clients.

    // If a query is running on this project, tell the client
    const projectState = getProjectState(projectId)
    if (projectState?.activeQuery || queryQueue.isProjectBusy(projectId)) {
      sendToClient(client, {
        type: 'query_start',
        projectId,
        sessionId: session?.sessionId,
      })
    }

    // Send queue snapshot so client knows current queue state
    const queueState = queryQueue.getProjectQueue(projectId)
    const snapshotItems: { queryId: string; status: 'queued' | 'running'; position: number; prompt: string; queryType: 'user' | 'cron'; sessionId?: string; cronJobName?: string }[] = []
    if (queueState.running) {
      snapshotItems.push({
        queryId: queueState.running.id,
        status: 'running',
        position: 0,
        prompt: queueState.running.prompt,
        queryType: queueState.running.type,
        sessionId: queueState.running.sessionId,
        cronJobName: queueState.running.metadata?.cronJobName,
      })
    }
    for (let i = 0; i < queueState.queued.length; i++) {
      const q = queueState.queued[i]
      snapshotItems.push({
        queryId: q.id,
        status: 'queued',
        position: i + 1,
        prompt: q.prompt,
        queryType: q.type,
        sessionId: q.sessionId,
        cronJobName: q.metadata?.cronJobName,
      })
    }
    sendToClient(client, {
      type: 'query_queue_snapshot',
      projectId,
      items: snapshotItems,
    })

    // Resend pending interactive state (ask_user_question / permission_request)
    // Check both in-memory ProjectState (server still running) and persisted Session (server restarted)
    const pendingQ = projectState?.pendingQuestion || session?.pendingQuestion
    const pendingP = projectState?.pendingPermissionRequest || session?.pendingPermissionRequest
    if (pendingQ) {
      sendToClient(client, {
        type: 'ask_user_question',
        toolId: pendingQ.toolId,
        questions: pendingQ.questions,
        projectId,
        sessionId: session?.sessionId,
      })
    }
    if (pendingP) {
      sendToClient(client, {
        type: 'permission_request',
        ...pendingP,
        projectId,
        sessionId: session?.sessionId,
      })
    }

    // Send updated project statuses
    sendToClient(client, {
      type: 'project_statuses',
      statuses: getProjectStatuses(),
    })

    console.log(`[ws] client ${client.clientId} switched to project ${projectId}`)
    return
  }

  // For all other messages, extract projectId from the message body
  const projectId = (msg as any).projectId as string | undefined
  if (!projectId) {
    safeSend(ws, { type: 'error', message: 'projectId is required' })
    return
  }

  // Ensure client is subscribed to this project
  if (!client.subscribedProjects.has(projectId)) {
    client.subscribedProjects.set(projectId, {})
  }

  // Get session and client state for this project
  const sub = client.subscribedProjects.get(projectId)!
  let session = sub.sessionId ? sessions.get(sub.sessionId) : undefined
  const clientState = getOrCreateClientStateForProject(client.clientId, projectId)

  switch (msg.type) {
    case 'prompt': {
      tsLog('[ws]', `Prompt received — project=${projectId}, client=${client.clientId}`)

      // Create session lazily on first user message
      if (!session) {
        session = getOrCreateSessionForProject(client, client.clientId, projectId, clientState)
      }

      // Create a new turn for this prompt
      const turnTimestamp = Date.now()
      session.turns.push({
        prompt: {
          type: 'user',
          text: msg.prompt,
          images: msg.images?.length ? msg.images : undefined,
        },
        agent: { messages: [], debugEvents: [] },
        timestamp: turnTimestamp,
      })
      session.lastModified = turnTimestamp

      if (!session.firstPrompt) {
        session.firstPrompt = msg.prompt.slice(0, 100)
      }

      persistSession(session)

      // Build user message (will be broadcast when query starts executing)
      const userMsg: ChatMessage = {
        id: `turn-${turnTimestamp}`,
        role: 'user',
        content: msg.prompt,
        images: msg.images?.length ? msg.images : undefined,
        timestamp: turnTimestamp,
      }

      // Capture variables for the closure
      const capturedSession = session
      const capturedClientState = clientState
      const capturedMsg = msg
      const capturedTurn = session.turns[session.turns.length - 1]

      // Enqueue the query
      const { queryId } = queryQueue.enqueue({
        type: 'user',
        projectId,
        sessionId: capturedSession.sessionId,
        prompt: msg.prompt,
        executor: async (queuedQuery) => {
          return executeUserQuery(
            client,
            capturedSession,
            capturedClientState,
            projectId,
            capturedMsg.prompt,
            capturedMsg.images,
            capturedMsg.enabledMcps,
            capturedMsg.disabledSdkServers,
            capturedMsg.disabledSkills,
            queuedQuery,
            userMsg,
            capturedTurn,
          )
        },
      })

      // Notify client that query was queued with its ID
      sendToClient(client, {
        type: 'query_queued',
        queryId,
        position: 0,
        queueLength: 0,
        projectId,
        sessionId: capturedSession.sessionId,
      })

      break
    }

    case 'command': {
      if (msg.command === '/clear') {
        // Abort any active query
        if (clientState.activeQuery) {
          abortQuery(clientState)
        }

        // Persist old session state
        if (session) {
          persistSession(session)
        }

        // Clear project state
        const projState = getOrCreateProjectState(projectId)
        projState.messages = []
        projState.sessionId = undefined

        // Clear client state
        clientState.sessionId = undefined
        clientState.accumulatingText = ''
        clientState.accumulatingThinking = ''
        clientState.currentToolCalls = []

        sendToClient(client, { type: 'cleared', projectId })

        // Create new session
        const newSessionId = generateSessionIdLocal()
        const newSession: Session = {
          sessionId: newSessionId,
          projectId,
          cwd: session?.cwd,
          turns: [],
          status: 'idle',
          lastModified: Date.now(),
        }
        sessions.set(newSessionId, newSession)
        sub.sessionId = newSessionId
        persistSession(newSession)

        const modelDisplay = projState.model
          ? getModelDisplayName(projState.model)
          : getDefaultModelConfig()?.name || 'Default'
        sendToClient(client, {
          type: 'system',
          subtype: 'init',
          projectId,
          sessionId: newSessionId,
          model: modelDisplay,
        })

        const models = getCachedModels()
        if (models && models.length > 0) {
          sendToClient(client, {
            type: 'available_models',
            models,
          })
        }
      } else {
        // Handle other commands as prompts (will be queued if project is busy)
        await handleClientMessage(ws, client, {
          type: 'prompt',
          prompt: msg.command,
          projectId,
          sessionId: msg.sessionId,
        })
      }
      break
    }

    case 'set_cwd': {
      const newCwd = msg.cwd
      clientState.cwd = newCwd
      if (session) {
        session.cwd = newCwd
      }
      const projState = getOrCreateProjectState(projectId)
      projState.cwd = newCwd
      broadcastToProject(projectId, { type: 'cwd_changed', cwd: newCwd, projectId })
      break
    }

    case 'abort': {
      tsLog('[ws]', `Abort requested — project=${projectId}, session=${session?.sessionId ?? 'none'}, client=${client.clientId}`)

      // Abort the running query via the queue (which triggers the abortController)
      const abortedQuery = queryQueue.abortRunning(projectId)
      if (abortedQuery) {
        // Also abort through the engine's abort mechanism
        abortQuery(clientState)
        if (session) {
          session.status = 'idle'
        }
        broadcastToProject(projectId, { type: 'aborted', projectId, sessionId: session?.sessionId })
        broadcastProjectStatuses()
        tsLog('[ws]', `Abort completed — project=${projectId}, query=${abortedQuery.id}`)
      } else if (abortQuery(clientState)) {
        // Fallback: abort via client state directly
        if (session) {
          session.status = 'idle'
        }
        broadcastToProject(projectId, { type: 'aborted', projectId, sessionId: session?.sessionId })
        broadcastProjectStatuses()
        tsLog('[ws]', `Abort completed (via clientState) — project=${projectId}`)
      } else {
        tsLog('[ws]', `Abort: no active query found — project=${projectId}, session=${session?.sessionId ?? 'none'}`)
      }
      break
    }

    case 'dequeue': {
      const cancelled = queryQueue.cancel(msg.queryId)
      if (cancelled) {
        console.log(`[ws] Dequeued query ${msg.queryId} for project ${projectId}`)
      } else {
        console.log(`[ws] Dequeue failed: query ${msg.queryId} not found or already running`)
      }
      break
    }

    case 'request_queue_snapshot': {
      const queueState = queryQueue.getProjectQueue(projectId)
      const items: { queryId: string; status: 'queued' | 'running'; position: number; prompt: string; queryType: 'user' | 'cron'; sessionId?: string; cronJobName?: string }[] = []
      if (queueState.running) {
        items.push({
          queryId: queueState.running.id,
          status: 'running',
          position: 0,
          prompt: queueState.running.prompt,
          queryType: queueState.running.type,
          sessionId: queueState.running.sessionId,
          cronJobName: queueState.running.metadata?.cronJobName,
        })
      }
      for (let i = 0; i < queueState.queued.length; i++) {
        const q = queueState.queued[i]
        items.push({
          queryId: q.id,
          status: 'queued',
          position: i + 1,
          prompt: q.prompt,
          queryType: q.type,
          sessionId: q.sessionId,
          cronJobName: q.metadata?.cronJobName,
        })
      }
      sendToClient(client, {
        type: 'query_queue_snapshot',
        projectId,
        items,
      })

      // Also send project_statuses so the client knows which sessions are processing
      sendToClient(client, {
        type: 'project_statuses',
        statuses: getProjectStatuses(),
      })

      // Send an immediate activity_heartbeat for the running query (if any)
      // so the client can display activity state without waiting for the next 30s heartbeat
      const runningQuery = queryQueue.getRunningQuery(projectId)
      if (runningQuery) {
        const timerState = queryQueue.getTimerState(runningQuery.id)
        if (timerState) {
          const now = Date.now()
          sendToClient(client, {
            type: 'activity_heartbeat',
            projectId,
            sessionId: runningQuery.sessionId,
            queryId: runningQuery.id,
            elapsedMs: now - (runningQuery.startedAt || now),
            lastActivityType: timerState.lastActivityType,
            lastToolName: timerState.lastToolName,
            paused: timerState.paused || undefined,
          })
        }
      }
      break
    }

    case 'resume_session': {
      const resumedSession = await resumeSessionForProject(client, projectId, msg.sessionId)
      if (resumedSession) {
        clientState.sessionId = resumedSession.sdkSessionId
        const projState = getOrCreateProjectState(projectId)
        projState.sessionId = resumedSession.sdkSessionId
        sendToClient(client, {
          type: 'session_resumed',
          projectId,
          sessionId: resumedSession.sessionId,
        })
        // History is now loaded via HTTP GET /api/sessions/:id/history
        // to avoid large WebSocket frames that crash mobile clients.
        const models = getCachedModels()
        if (models && models.length > 0) {
          sendToClient(client, {
            type: 'available_models',
            models,
          })
        }

        // Send active query status (if a query is running on this project)
        const projectState = getProjectState(projectId)
        if (projectState?.activeQuery || queryQueue.isProjectBusy(projectId)) {
          sendToClient(client, {
            type: 'query_start',
            projectId,
            sessionId: resumedSession.sessionId,
          })
        }

        // Resend pending interactive state (ask_user_question / permission_request)
        const pendingQ = projectState?.pendingQuestion || resumedSession.pendingQuestion
        const pendingP = projectState?.pendingPermissionRequest || resumedSession.pendingPermissionRequest
        if (pendingQ) {
          sendToClient(client, {
            type: 'ask_user_question',
            toolId: pendingQ.toolId,
            questions: pendingQ.questions,
            projectId,
            sessionId: resumedSession.sessionId,
          })
        }
        if (pendingP) {
          sendToClient(client, {
            type: 'permission_request',
            ...pendingP,
            projectId,
            sessionId: resumedSession.sessionId,
          })
        }

        // Summary and suggestions are now included in HTTP history response

        // Send updated project statuses
        sendToClient(client, {
          type: 'project_statuses',
          statuses: getProjectStatuses(),
        })
      } else {
        sendToClient(client, {
          type: 'error',
          message: `Session not found: ${msg.sessionId}`,
          projectId,
        })
      }
      break
    }

    case 'respond_question': {
      if (!session) return

      // Clear pending question from project state and session
      const projStateForQR = getOrCreateProjectState(projectId)
      projStateForQR.pendingQuestion = null
      session.pendingQuestion = null
      persistSession(session)

      // Resume idle timeout for the running query
      const runningQueryForQ = queryQueue.getRunningQuery(projectId)
      if (runningQueryForQ) {
        queryQueue.resumeTimeout(runningQueryForQ.id)
      }

      // Resolve the pending canUseTool promise with the user's answers
      const handled = handleQuestionResponse(clientState, msg.answers)
      if (!handled) {
        // Try other client states for this project
        for (const otherClient of clients.values()) {
          if (otherClient.connectionId === client.connectionId) continue
          const otherState = getClientState(otherClient.clientId, projectId)
          if (otherState && handleQuestionResponse(otherState, msg.answers)) {
            break
          }
        }
      }
      break
    }

    case 'respond_permission': {
      // Clear pending permission from project state and session
      const projStateForPR = getOrCreateProjectState(projectId)
      projStateForPR.pendingPermissionRequest = null
      if (session) {
        session.pendingPermissionRequest = null
        persistSession(session)
      }

      // Resume idle timeout for the running query
      const runningQueryForP = queryQueue.getRunningQuery(projectId)
      if (runningQueryForP) {
        queryQueue.resumeTimeout(runningQueryForP.id)
      }

      const handled = handlePermissionResponse(clientState, msg.requestId, msg.allow)
      if (!handled) {
        // Try other client states for this project
        for (const otherClient of clients.values()) {
          if (otherClient.connectionId === client.connectionId) continue
          const otherState = getClientState(otherClient.clientId, projectId)
          if (otherState && handlePermissionResponse(otherState, msg.requestId, msg.allow)) {
            break
          }
        }
      }
      break
    }

    case 'set_model': {
      clientState.model = msg.model || undefined
      const projState = getOrCreateProjectState(projectId)
      projState.model = clientState.model
      const displayName = clientState.model ? getModelDisplayName(clientState.model) : 'Default'
      broadcastToProject(projectId, { type: 'model_changed', model: displayName, projectId })
      break
    }

    case 'set_permission_mode': {
      const mode = msg.mode
      clientState.permissionMode = mode
      const projState = getOrCreateProjectState(projectId)
      projState.permissionMode = mode
      broadcastToProject(projectId, { type: 'permission_mode_changed', mode, projectId })
      break
    }

    case 'probe_sdk': {
      // Lightweight probe: start SDK subprocess to capture init info, then abort
      probeSdkInit(clientState).then((info) => {
        if (info) {
          sendToClient(client, {
            type: 'system',
            subtype: 'init',
            projectId,
            tools: info.tools,
            sdkMcpServers: info.sdkMcpServers,
            sdkSkills: info.sdkSkills,
          })
        }
      }).catch((err) => {
        console.error('[ws] probe_sdk error:', err)
      })
      break
    }
  }
}
