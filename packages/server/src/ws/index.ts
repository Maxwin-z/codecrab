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
} from '@codeclaws/shared'
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
import type { QueuedQuery, QueryResult, QueryTimerState } from '../engine/query-queue.js'

// Export for API use
export { getSessionStatuses as getSessions }

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
  })
})
export { queryQueue }

// Activity heartbeat — throttle to one broadcast per 30s per query
const HEARTBEAT_THROTTLE_MS = 30_000
const lastHeartbeatSentAt = new Map<string, number>()

function maybeSendActivityHeartbeat(projectId: string, sessionId: string, queryId: string): void {
  const now = Date.now()
  const lastSent = lastHeartbeatSentAt.get(queryId) || 0
  if (now - lastSent < HEARTBEAT_THROTTLE_MS) return

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
    paused: timerState.paused || undefined,
  })
}

function cleanupHeartbeat(queryId: string): void {
  lastHeartbeatSentAt.delete(queryId)
}

// Execute a prompt in a specific session (used by cron jobs)
// Now enqueues through the query queue instead of executing directly
// If sessionId is not provided, a new session will be created for the project
export async function executePromptInSession(
  sessionId: string | undefined,
  projectId: string | undefined,
  prompt: string,
  cronJobName?: string,
  metadata?: { cronJobId?: string; cronRunId?: string },
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Find or create parent session
  let parentSession: Session | undefined

  if (sessionId) {
    parentSession = sessions.get(sessionId)
  }

  // If no session found by sessionId, try to find one by projectId or create new
  if (!parentSession && projectId) {
    // Try to find an existing session for this project
    for (const s of sessions.values()) {
      if (s.projectId === projectId) {
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
      messages: [],
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
    messages: [],
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

  // Add user message to execution session
  const cronLabel = cronJobName ? `[Scheduled Task: ${cronJobName}]` : '[Scheduled Task]'
  const userMsg: ChatMessage = {
    id: genId(),
    role: 'user',
    content: `${cronLabel} ${prompt}`,
    timestamp: Date.now(),
  }
  execSession.messages.push(userMsg)
  execSession.lastModified = Date.now()
  persistSession(execSession)

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

  let finalText = ''
  let isSuccess = true
  let errorMessage = ''
  let durationMs = 0
  const startTime = Date.now()

  try {
    const stream = executeQuery(clientState, prompt, {
      onTextDelta: (text) => {
        finalText += text
        queryQueue.touchActivity(queuedQuery.id, 'text_delta')
      },
      onThinkingDelta: () => {
        // Cron execution doesn't broadcast thinking to parent
        queryQueue.touchActivity(queuedQuery.id, 'thinking_delta')
      },
      onToolUse: (_toolName) => {
        // Cron execution doesn't broadcast tool use to parent
        queryQueue.touchActivity(queuedQuery.id, 'tool_use', _toolName)
      },
      onToolResult: () => {
        // Cron execution doesn't broadcast tool result to parent
        queryQueue.touchActivity(queuedQuery.id, 'tool_result')
      },
      onSessionInit: (sdkSessionId) => {
        execSession.sdkSessionId = sdkSessionId
        persistSession(execSession)
      },
      onPermissionRequest: () => {
        // Cron jobs bypass permissions
      },
      onUsage: () => {
        queryQueue.touchActivity(queuedQuery.id, 'usage')
      },
    })

    for await (const event of stream) {
      if (event.type === 'result') {
        const resultData = event.data as any
        if (resultData.durationMs) {
          durationMs = resultData.durationMs
        }
        if (resultData.isError) {
          isSuccess = false
        }
      }
    }

    // Store assistant message in execution session
    const assistantMsg = storeAssistantMessage(clientState)
    if (assistantMsg) {
      execSession.messages.push(assistantMsg)
      execSession.lastModified = Date.now()
      persistSession(execSession)
      finalText = assistantMsg.content
    }

    execSession.status = 'idle'
    persistSession(execSession)

  } catch (err: any) {
    console.error('[cron] Query error:', err)
    isSuccess = false
    errorMessage = err.message || 'Cron query failed'
    execSession.status = 'error'
    persistSession(execSession)
  } finally {
    durationMs = durationMs || Date.now() - startTime
    removeAllClientStates(cronClientId)
  }

  // Insert result into parent session
  const resultSummary = isSuccess
    ? `Completed successfully in ${durationMs}ms`
    : `Failed: ${errorMessage}`
  const resultMsg: ChatMessage = {
    id: genId(),
    role: 'assistant',
    content: `[Scheduled Task Completed: ${cronJobName || 'Task'}]\nResult: ${resultSummary}\nOutput: ${finalText.slice(0, 1000)}${finalText.length > 1000 ? '...' : ''}`,
    timestamp: Date.now(),
    costUsd: clientState.currentCostUsd,
    durationMs,
  }

  parentSession.messages.push(resultMsg)
  parentSession.lastModified = Date.now()
  persistSession(parentSession)

  // Broadcast result to parent session
  broadcastToProject(projectId, {
    type: 'assistant_text',
    text: resultMsg.content,
    projectId,
    sessionId: parentSession.sessionId,
  })

  // Also broadcast to execution session for visibility
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

  // Send push notification to all devices with parent sessionId
  const summaryMatch = finalText.match(/\[SUMMARY:\s*(.+?)\]/)
  const pushSummary = summaryMatch
    ? summaryMatch[1].trim()
    : `${cronJobName || 'Scheduled Task'}: ${resultSummary}`
  sendQueryCompletionPush(pushSummary, projectId, parentSession.sessionId)

  if (isSuccess) {
    return { success: true, output: finalText.slice(0, 500), queryId: queuedQuery.id }
  } else {
    return { success: false, error: errorMessage, queryId: queuedQuery.id }
  }
}

// Get full session messages for HTTP API
export function getSessionMessages(sessionId: string): ChatMessage[] | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return session.messages
}

// --- Session persistence ---
const SESSIONS_DIR = path.join(os.homedir(), '.codeclaws', 'sessions')

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
      messages: session.messages,
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
          const session: Session = {
            sessionId: data.sessionId,
            sdkSessionId: data.sdkSessionId,
            projectId: data.projectId,
            cwd: data.cwd,
            messages: data.messages || [],
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
  messages: ChatMessage[]
  status: 'idle' | 'processing' | 'error'
  lastModified: number
  summary?: string
  firstPrompt?: string
  pendingQuestion?: { toolId: string; questions: any[] } | null
  pendingPermissionRequest?: { requestId: string; toolName: string; input: any; reason?: string } | null
}

const clients = new Map<string, Client>()
const sessions = new Map<string, Session>()

let messageIdCounter = 0
function genId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

function generateSessionIdLocal(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Resume an existing session
function resumeSessionForProject(client: Client, projectId: string, sessionId: string): Session | null {
  const session = sessions.get(sessionId)
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

// Get all sessions for a project or globally
export function getSessionsList(projectId?: string, cwd?: string): SessionInfo[] {
  const result: SessionInfo[] = []

  for (const session of sessions.values()) {
    // Skip empty sessions (no messages = nothing to resume)
    if (session.messages.length === 0) continue

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

    result.push({
      sessionId: session.sessionId,
      summary: session.summary || '',
      lastModified: session.lastModified,
      firstPrompt: session.firstPrompt,
      cwd: session.cwd,
      status: session.status,
      isActive,
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
function toMessageSummary(message: ChatMessage): import('@codeclaws/shared').ChatMessageSummary {
  const content = (message.content || '').replace(/\n?\[SUGGESTIONS:\s*.+?\]\s*$/, '').replace(/\n?\[SUMMARY:\s*.+?\]\s*$/, '').trimEnd()
  const hasToolCalls = !!(message.toolCalls && message.toolCalls.length > 0)
  const hasImages = !!(message.images && message.images.length > 0)

  // For assistant/user: always send full content
  // For system with tool calls: content is usually empty, tool data is sent separately
  const isTruncated = false // We no longer truncate content text

  // Build lightweight tool call summaries
  let toolCalls: import('@codeclaws/shared').ChatMessageSummary['toolCalls']
  if (message.toolCalls && message.toolCalls.length > 0) {
    toolCalls = message.toolCalls.map((tc) => {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
      return {
        name: tc.name,
        id: tc.id,
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
      if (session.messages.length > 0 && (!latestModified || session.lastModified > latestModified)) {
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
      if (s.projectId !== projectId || s.messages.length === 0) continue
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

    console.log(`[ws] client connected: ${clientId} (${connectionId})`)

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
    messages: [],
    status: 'idle',
    lastModified: Date.now(),
  }
  sessions.set(sessionId, session)
  if (sub) sub.sessionId = sessionId

  console.log(`[ws] Created new session ${sessionId} for client ${clientId} project ${projectId}`)

  // Sync with project state
  const projectState = getOrCreateProjectState(projectId)
  if (projectState.messages.length > 0) {
    session.messages = [...projectState.messages]
  }
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
  images: import('@codeclaws/shared').ImageAttachment[] | undefined,
  enabledMcps: string[] | undefined,
  disabledSdkServers: string[] | undefined,
  disabledSkills: string[] | undefined,
  queuedQuery: QueuedQuery,
): Promise<QueryResult> {
  // Link queue abort to engine abort
  queuedQuery.abortController.signal.addEventListener('abort', () => {
    abortQuery(clientState)
  }, { once: true })

  session.status = 'processing'
  broadcastToProject(projectId, { type: 'query_start', projectId, sessionId: session.sessionId, queryId: queuedQuery.id })
  broadcastProjectStatuses()

  try {
    const stream = executeQuery(clientState, prompt, {
      onTextDelta: (text) => {
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'text',
          text,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'text_delta')
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onThinkingDelta: (thinking) => {
        broadcastToProject(projectId, {
          type: 'stream_delta',
          deltaType: 'thinking',
          text: thinking,
          projectId,
          sessionId: session.sessionId,
        })
        queryQueue.touchActivity(queuedQuery.id, 'thinking_delta')
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
      },
      onToolUse: (toolName, toolId, input) => {
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
      },
      onToolResult: (toolId, content, isError) => {
        broadcastToProject(projectId, {
          type: 'tool_result',
          toolId,
          content,
          isError,
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
      onUsage: (_usage) => {
        queryQueue.touchActivity(queuedQuery.id, 'usage')
        maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
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
        case 'ask_user_question': {
          const questionData = {
            toolId: (event.data as any).toolId,
            questions: (event.data as any).questions,
          }
          const projStateForQ = getOrCreateProjectState(projectId)
          projStateForQ.pendingQuestion = questionData
          session.pendingQuestion = questionData
          persistSession(session)
          broadcastToProject(projectId, {
            type: 'ask_user_question',
            ...questionData,
            projectId,
            sessionId: session.sessionId,
          })
          queryQueue.pauseTimeout(queuedQuery.id)
          maybeSendActivityHeartbeat(projectId, session.sessionId, queuedQuery.id)
          break
        }
      }
    }

    const assistantMsg = storeAssistantMessage(clientState)
    if (assistantMsg) {
      session.messages.push(assistantMsg)
      session.lastModified = Date.now()

      const summaryMatch = assistantMsg.content.match(/\[SUMMARY:\s*(.+?)\]/)
      if (summaryMatch) {
        session.summary = summaryMatch[1].trim()
        console.log(`[Summary] Extracted: ${session.summary}`)
        broadcastToProject(projectId, {
          type: 'query_summary',
          summary: session.summary,
          projectId,
          sessionId: session.sessionId,
        })
        // Send push notification (best-effort, never throws)
        sendQueryCompletionPush(session.summary, projectId, session.sessionId)
      } else {
        console.log(`[Summary] No [SUMMARY: ...] tag found in response (${assistantMsg.content.length} chars)`)
      }

      const suggestionsMatch = assistantMsg.content.match(/\[SUGGESTIONS:\s*(.+?)\]/)
      if (suggestionsMatch) {
        const suggestions = suggestionsMatch[1].split('|').map((s: string) => s.trim()).filter(Boolean)
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

    return { success: true, output: finalText.slice(0, 500), queryId: queuedQuery.id }
  } catch (err: any) {
    console.error('[ws] Query error:', err)
    broadcastToProject(projectId, {
      type: 'error',
      message: err.message || 'Query failed',
      projectId,
      sessionId: session.sessionId,
    })
    session.status = 'error'
    return { success: false, error: err.message || 'Query failed', queryId: queuedQuery.id }
  } finally {
    session.status = 'idle'
    const projStateForEnd = getOrCreateProjectState(projectId)
    projStateForEnd.pendingQuestion = null
    projStateForEnd.pendingPermissionRequest = null
    session.pendingQuestion = null
    session.pendingPermissionRequest = null
    cleanupHeartbeat(queuedQuery.id)
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

    // Send message history if resuming (chunked to avoid exceeding WebSocket limits)
    if (session && session.messages.length > 0) {
      sendMessageHistoryInChunks(client, projectId, session.sessionId, session.messages)
    }

    // If a query is running on this project, tell the client
    const projectState = getProjectState(projectId)
    if (projectState?.activeQuery || queryQueue.isProjectBusy(projectId)) {
      sendToClient(client, {
        type: 'query_start',
        projectId,
        sessionId: session?.sessionId,
      })
    }

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
      console.log(`[ws] Prompt received for project ${projectId} from client ${client.clientId}`)

      // Create session lazily on first user message
      if (!session) {
        session = getOrCreateSessionForProject(client, client.clientId, projectId, clientState)
      }

      // Add user message to session immediately (visible even while queued)
      const projState = getOrCreateProjectState(projectId)
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: msg.prompt,
        images: msg.images?.length ? msg.images : undefined,
        timestamp: Date.now(),
      }
      session.messages.push(userMsg)
      session.lastModified = Date.now()

      if (!session.firstPrompt) {
        session.firstPrompt = msg.prompt.slice(0, 100)
      }

      persistSession(session)

      projState.messages.push(userMsg)

      // Broadcast to other clients subscribed to this project
      broadcastToProject(
        projectId,
        { type: 'user_message', message: userMsg, projectId, sessionId: session.sessionId },
        client.connectionId
      )

      // Capture variables for the closure
      const capturedSession = session
      const capturedClientState = clientState
      const capturedMsg = msg

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
          messages: [],
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
      console.log(`[ws] Abort requested for project ${projectId}`)

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
        console.log(`[ws] Abort completed for project ${projectId}, query ${abortedQuery.id}`)
      } else if (abortQuery(clientState)) {
        // Fallback: abort via client state directly
        if (session) {
          session.status = 'idle'
        }
        broadcastToProject(projectId, { type: 'aborted', projectId, sessionId: session?.sessionId })
        broadcastProjectStatuses()
        console.log(`[ws] Abort completed for project ${projectId} (via clientState)`)
      } else {
        console.log(`[ws] Abort: no active query for project ${projectId}`)
      }
      break
    }

    case 'resume_session': {
      const resumedSession = resumeSessionForProject(client, projectId, msg.sessionId)
      if (resumedSession) {
        clientState.sessionId = resumedSession.sdkSessionId
        const projState = getOrCreateProjectState(projectId)
        projState.sessionId = resumedSession.sdkSessionId
        sendToClient(client, {
          type: 'session_resumed',
          projectId,
          sessionId: resumedSession.sessionId,
        })
        // Send message history in chunks to avoid exceeding WebSocket limits
        sendMessageHistoryInChunks(client, projectId, resumedSession.sessionId, resumedSession.messages)
        const models = getCachedModels()
        if (models && models.length > 0) {
          sendToClient(client, {
            type: 'available_models',
            models,
          })
        }
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

      const answerText = Object.entries(msg.answers)
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            return `${key}: ${value.join(', ')}`
          }
          return `${key}: ${value}`
        })
        .join('\n')

      await handleClientMessage(ws, client, {
        type: 'prompt',
        prompt: answerText,
        projectId,
        sessionId: msg.sessionId,
      })
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
