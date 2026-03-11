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
} from '../engine/claude.js'

// Export for API use
export { getSessionStatuses as getSessions }

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
  session.lastModified = Date.now()
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
function broadcastToProject(projectId: string | undefined, message: ServerMessage, excludeClientId?: string) {
  if (!projectId) return
  // Stamp projectId on the message
  const stamped = { ...message, projectId }
  const data = JSON.stringify(stamped)
  for (const [clientId, client] of clients) {
    if (excludeClientId && clientId === excludeClientId) continue
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
    const hasActiveQuery = !!projectState?.activeQuery

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
  const hasActiveQuery = !!projectState?.activeQuery
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

    // Check auth token from query param
    const token = url.searchParams.get('token')
    const validToken = await getToken()
    if (validToken && token !== validToken) {
      ws.close(1008, 'Invalid token')
      return
    }

    const client: Client = { ws, clientId, subscribedProjects: new Map() }
    clients.set(clientId, client)

    console.log(`[ws] client connected: ${clientId}`)

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
      console.log(`[ws] client disconnected: ${clientId}`)
      clients.delete(clientId)

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

      // Clean up client states
      removeAllClientStates(clientId)
    })

    ws.on('error', (err) => {
      console.error(`[ws] client error: ${clientId}`, err)
    })
  })

  console.log('[ws] WebSocket server ready')
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
  sendToClient(client, {
    type: 'system',
    subtype: 'init',
    projectId,
    sessionId: session.sessionId,
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

async function handleClientMessage(ws: WebSocket, client: Client, msg: ClientMessage) {
  // Handle switch_project separately — it's a subscription management message
  if (msg.type === 'switch_project') {
    const { projectId, projectCwd } = msg

    // Subscribe to this project
    if (!client.subscribedProjects.has(projectId)) {
      client.subscribedProjects.set(projectId, {})
    }

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
    sendToClient(client, {
      type: 'system',
      subtype: 'init',
      projectId,
      sessionId: session?.sessionId,
    })

    // Send models
    const models = getCachedModels()
    if (models && models.length > 0) {
      sendToClient(client, {
        type: 'available_models',
        models,
      })
    }

    // Send message history if resuming
    if (session && session.messages.length > 0) {
      sendToClient(client, {
        type: 'message_history',
        projectId,
        sessionId: session.sessionId,
        messages: session.messages,
      })
    }

    // If a query is running on this project, tell the client
    const projectState = getProjectState(projectId)
    if (projectState?.activeQuery) {
      sendToClient(client, {
        type: 'query_start',
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
      // Create session lazily on first user message
      if (!session) {
        session = getOrCreateSessionForProject(client, client.clientId, projectId, clientState)
      }

      // Check if already running
      if (clientState.activeQuery) {
        safeSend(ws, { type: 'error', message: 'A query is already running', projectId })
        return
      }

      // Project-level lock
      const projState = getOrCreateProjectState(projectId)
      if (projState.activeQuery) {
        safeSend(ws, { type: 'error', message: 'Another session is already running in this project. Please wait for it to finish or abort it first.', projectId })
        return
      }

      // Add user message to session
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: msg.prompt,
        timestamp: Date.now(),
      }
      session.messages.push(userMsg)
      session.lastModified = Date.now()

      if (!session.firstPrompt) {
        session.firstPrompt = msg.prompt.slice(0, 100)
      }

      persistSession(session)

      // Add to project state
      projState.messages.push(userMsg)

      // Broadcast to other clients subscribed to this project
      broadcastToProject(
        projectId,
        { type: 'user_message', message: userMsg, projectId, sessionId: session.sessionId },
        client.clientId
      )

      // Start processing
      session.status = 'processing'
      sendToClient(client, { type: 'query_start', projectId, sessionId: session.sessionId })
      broadcastProjectStatuses()

      try {
        const stream = executeQuery(clientState, msg.prompt, {
          onTextDelta: (text) => {
            broadcastToProject(projectId, {
              type: 'stream_delta',
              deltaType: 'text',
              text,
              projectId,
              sessionId: session!.sessionId,
            })
          },
          onThinkingDelta: (thinking) => {
            broadcastToProject(projectId, {
              type: 'stream_delta',
              deltaType: 'thinking',
              text: thinking,
              projectId,
              sessionId: session!.sessionId,
            })
          },
          onToolUse: (toolName, toolId, input) => {
            broadcastToProject(projectId, {
              type: 'tool_use',
              toolName,
              toolId,
              input,
              projectId,
              sessionId: session!.sessionId,
            })
          },
          onToolResult: (toolId, content, isError) => {
            broadcastToProject(projectId, {
              type: 'tool_result',
              toolId,
              content,
              isError,
              projectId,
              sessionId: session!.sessionId,
            })
          },
          onSessionInit: (sdkSessionId) => {
            if (session) {
              session.sdkSessionId = sdkSessionId
              persistSession(session)
              const ps = getOrCreateProjectState(projectId)
              ps.sessionId = sdkSessionId
              broadcastToProject(projectId, {
                type: 'session_resumed',
                projectId,
                sessionId: session.sessionId,
              })
            }
          },
          onPermissionRequest: (requestId, toolName, input, reason) => {
            broadcastToProject(projectId, {
              type: 'permission_request',
              requestId,
              toolName,
              input,
              reason,
              projectId,
              sessionId: session!.sessionId,
            })
          },
          onUsage: (_usage) => {
            // Usage is tracked internally
          },
        })

        // Process stream events
        let finalText = ''
        for await (const event of stream) {
          switch (event.type) {
            case 'text_delta':
              finalText += (event.data as any).text
              break
            case 'thinking_delta':
              broadcastToProject(projectId, {
                type: 'thinking',
                thinking: (event.data as any).thinking,
                projectId,
                sessionId: session.sessionId,
              })
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
            case 'ask_user_question':
              broadcastToProject(projectId, {
                type: 'ask_user_question',
                toolId: (event.data as any).toolId,
                questions: (event.data as any).questions,
                projectId,
                sessionId: session.sessionId,
              })
              break
          }
        }

        // Store assistant message
        const assistantMsg = storeAssistantMessage(clientState)
        if (assistantMsg) {
          session.messages.push(assistantMsg)
          session.lastModified = Date.now()

          const summaryMatch = assistantMsg.content.match(/\[SUMMARY:\s*(.+?)\]/)
          if (summaryMatch) {
            session.summary = summaryMatch[1].trim()
            broadcastToProject(projectId, {
              type: 'query_summary',
              summary: session.summary,
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
        }

      } catch (err: any) {
        console.error('[ws] Query error:', err)
        broadcastToProject(projectId, {
          type: 'error',
          message: err.message || 'Query failed',
          projectId,
          sessionId: session.sessionId,
        })
        session.status = 'error'
      } finally {
        session.status = 'idle'
        broadcastToProject(projectId, {
          type: 'query_end',
          projectId,
          sessionId: session.sessionId,
        })
        broadcastProjectStatuses()
      }

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

        sendToClient(client, {
          type: 'system',
          subtype: 'init',
          projectId,
          sessionId: newSessionId,
        })

        const models = getCachedModels()
        if (models && models.length > 0) {
          sendToClient(client, {
            type: 'available_models',
            models,
          })
        }
      } else {
        // Handle other commands as prompts
        if (clientState.activeQuery) {
          safeSend(ws, { type: 'error', message: 'A query is already running', projectId })
          return
        }

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
      if (abortQuery(clientState)) {
        if (session) {
          session.status = 'idle'
        }
        broadcastToProject(projectId, { type: 'aborted', projectId, sessionId: session?.sessionId })
        broadcastProjectStatuses()
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
        sendToClient(client, {
          type: 'message_history',
          projectId,
          sessionId: resumedSession.sessionId,
          messages: resumedSession.messages,
        })
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
      const handled = handlePermissionResponse(clientState, msg.requestId, msg.allow)
      if (!handled) {
        // Try other client states for this project
        for (const otherClient of clients.values()) {
          if (otherClient.clientId === client.clientId) continue
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
      broadcastToProject(projectId, { type: 'model_changed', model: msg.model, projectId })
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
  }
}
