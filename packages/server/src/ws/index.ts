// WebSocket module — connection management and message routing with Claude SDK
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
  removeClientState,
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

interface Client {
  ws: WebSocket
  clientId: string
  projectId?: string
  sessionId?: string
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

// Get or create session for a client
function getOrCreateSession(client: Client): Session {
  if (client.sessionId && sessions.has(client.sessionId)) {
    return sessions.get(client.sessionId)!
  }

  const sessionId = generateSessionIdLocal()
  const session: Session = {
    sessionId,
    projectId: client.projectId,
    messages: [],
    status: 'idle',
    lastModified: Date.now(),
  }
  sessions.set(sessionId, session)
  client.sessionId = sessionId
  persistSession(session)
  return session
}

// Resume an existing session
function resumeSession(client: Client, sessionId: string): Session | null {
  const session = sessions.get(sessionId)
  if (!session) return null

  // If session belongs to a different project, only allow if no project mismatch
  if (session.projectId && client.projectId && session.projectId !== client.projectId) {
    return null
  }

  client.sessionId = sessionId
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

    // Check if this session is active (has any connected client)
    const isActive = Array.from(clients.values()).some((c) => c.sessionId === session.sessionId)

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

// Broadcast message to all clients in a project
function broadcastToProject(projectId: string | undefined, message: ServerMessage, excludeClientId?: string) {
  if (!projectId) return
  const data = JSON.stringify(message)
  for (const [clientId, client] of clients) {
    if (excludeClientId && clientId === excludeClientId) continue
    if (client.projectId === projectId && client.ws.readyState === WebSocket.OPEN) {
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
  // Include projects from connected clients AND projects with active queries
  const projectIds = new Set<string>()
  for (const client of clients.values()) {
    if (client.projectId) projectIds.add(client.projectId)
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

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const clientId = url.searchParams.get('clientId') || `anon-${Date.now()}`
    const projectId = url.searchParams.get('projectId') || undefined

    // Check auth token from query param
    const token = url.searchParams.get('token')
    const validToken = await getToken()
    if (validToken && token !== validToken) {
      ws.close(1008, 'Invalid token')
      return
    }

    const client: Client = { ws, clientId, projectId }
    clients.set(clientId, client)

    console.log(`[ws] client connected: ${clientId}${projectId ? ` (project: ${projectId})` : ''}`)

    // Get or create client state for Claude SDK (session is created lazily on first message)
    // If the client reconnected to a different project, create a fresh clientState
    // to avoid inheriting activeQuery from the previous project's running query.
    // The old clientState object is still referenced by the running query's closure,
    // so its finally block will correctly clean up the old project's activeQuery.
    let clientState = getClientState(clientId)
    if (clientState && clientState.projectId !== projectId) {
      removeClientState(clientId)
      clientState = undefined
    }
    if (!clientState) {
      const cwd = process.cwd()
      clientState = createClientState(clientId, projectId, cwd)
      if (projectId) {
        const projectState = getOrCreateProjectState(projectId)
        clientState.cwd = projectState.cwd
        clientState.sessionId = projectState.sessionId
      }
    }

    // Get existing session if client has one
    let session: Session | undefined = client.sessionId ? sessions.get(client.sessionId) : undefined

    // Auto-resume session when connecting to a project
    // - Always resume a processing session (active query running)
    // - Resume the latest session if it was active within 10 minutes
    // - Otherwise start with empty state (new session created on first message)
    if (projectId && !session) {
      const projectState = getProjectState(projectId)
      const hasActiveQuery = !!projectState?.activeQuery
      const SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

      if (hasActiveQuery) {
        // Always resume a processing session
        for (const s of sessions.values()) {
          if (s.projectId === projectId && s.status === 'processing') {
            session = s
            client.sessionId = s.sessionId
            clientState.sessionId = s.sdkSessionId
            console.log(`[ws] Auto-resuming active session ${s.sessionId} for project ${projectId}`)
            break
          }
        }
      }

      // If no active query, only resume if the latest session was active within 10 minutes
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
          client.sessionId = latestSession.sessionId
          clientState.sessionId = latestSession.sdkSessionId
          console.log(`[ws] Resuming recent session ${latestSession.sessionId} for project ${projectId} (${Math.round((Date.now() - latestSession.lastModified) / 1000)}s ago)`)
        }
      }
    }

    // Send init message
    sendToClient(client, {
      type: 'system',
      subtype: 'init',
      sessionId: session?.sessionId,
    })

    // Load models from config if not cached, then send to client
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

    // Send message history if resuming existing session
    if (session && session.messages.length > 0) {
      sendToClient(client, {
        type: 'message_history',
        messages: session.messages,
      })
    }

    // If a query is running on this project, tell the client
    // Only check project-level activeQuery, not clientState (which is fresh after project switch)
    const projectState = projectId ? getProjectState(projectId) : undefined
    if (projectState?.activeQuery) {
      sendToClient(client, { type: 'query_start' })
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

      // Update session status if this was the last client
      // But don't set to idle if the project still has an active query running
      if (client.sessionId) {
        const session = sessions.get(client.sessionId)
        if (session) {
          const hasOtherClients = Array.from(clients.values()).some(
            (c) => c.sessionId === client.sessionId
          )
          const projectState = client.projectId ? getProjectState(client.projectId) : undefined
          const hasActiveQuery = !!projectState?.activeQuery
          if (!hasOtherClients && session.status === 'processing' && !hasActiveQuery) {
            session.status = 'idle'
          }
        }
      }
    })

    ws.on('error', (err) => {
      console.error(`[ws] client error: ${clientId}`, err)
    })
  })

  console.log('[ws] WebSocket server ready')
}

// Helper to get or create session lazily (on first message)
function getOrCreateSessionForClient(client: Client, clientState: import('../engine/claude.js').ClientState): Session {
  // Return existing session if available
  if (client.sessionId && sessions.has(client.sessionId)) {
    const existingSession = sessions.get(client.sessionId)!
    // Only set SDK session ID if we have one (from a prior SDK init)
    clientState.sessionId = existingSession.sdkSessionId
    return existingSession
  }

  // Create new session
  const sessionId = generateSessionIdLocal()
  const session: Session = {
    sessionId,
    projectId: client.projectId,
    messages: [],
    status: 'idle',
    lastModified: Date.now(),
  }
  sessions.set(sessionId, session)
  client.sessionId = sessionId
  // Don't set clientState.sessionId — let the SDK assign it via init callback

  console.log(`[ws] Created new session ${sessionId} for client ${client.clientId}`)

  // Sync with project state if in a project
  if (client.projectId) {
    const projectState = getOrCreateProjectState(client.projectId)
    // Copy existing messages from project state if any
    if (projectState.messages.length > 0) {
      session.messages = [...projectState.messages]
    }
    // Sync cwd
    session.cwd = projectState.cwd
  }

  persistSession(session)

  // Notify client of new session
  sendToClient(client, {
    type: 'system',
    subtype: 'init',
    sessionId: session.sessionId,
  })

  // Send available models when creating new session
  const models = getCachedModels()
  if (models && models.length > 0) {
    sendToClient(client, {
      type: 'available_models',
      models,
    })
  }

  return session
}

async function handleClientMessage(ws: WebSocket, client: Client, msg: ClientMessage) {
  let session = client.sessionId ? sessions.get(client.sessionId) : undefined
  const clientState = getClientState(client.clientId)

  if (!clientState) {
    safeSend(ws, { type: 'error', message: 'Client state not found' })
    return
  }

  switch (msg.type) {
    case 'prompt': {
      // Create session lazily on first user message
      if (!session) {
        session = getOrCreateSessionForClient(client, clientState)
      }

      // Check if already running
      if (clientState.activeQuery) {
        safeSend(ws, { type: 'error', message: 'A query is already running' })
        return
      }

      // Project-level lock: only one session can run at a time per project
      if (client.projectId) {
        const projectState = getOrCreateProjectState(client.projectId)
        if (projectState.activeQuery) {
          safeSend(ws, { type: 'error', message: 'Another session is already running in this project. Please wait for it to finish or abort it first.' })
          return
        }
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

      // Set first prompt if not set
      if (!session.firstPrompt) {
        session.firstPrompt = msg.prompt.slice(0, 100)
      }

      persistSession(session)

      // Add to project state if in project
      if (client.projectId) {
        const projectState = getOrCreateProjectState(client.projectId)
        projectState.messages.push(userMsg)
      }

      // Broadcast to other clients in same project
      broadcastToProject(
        client.projectId,
        { type: 'user_message', message: userMsg },
        client.clientId
      )

      // Start processing
      session.status = 'processing'
      sendToClient(client, { type: 'query_start' })
      broadcastProjectStatuses()

      try {
        // Execute query with Claude SDK
        const stream = executeQuery(clientState, msg.prompt, {
          onTextDelta: (text) => {
            broadcastToProject(client.projectId, {
              type: 'stream_delta',
              deltaType: 'text',
              text,
            })
          },
          onThinkingDelta: (thinking) => {
            broadcastToProject(client.projectId, {
              type: 'stream_delta',
              deltaType: 'thinking',
              text: thinking,
            })
          },
          onToolUse: (toolName, toolId, input) => {
            broadcastToProject(client.projectId, {
              type: 'tool_use',
              toolName,
              toolId,
              input,
            })
          },
          onToolResult: (toolId, content, isError) => {
            broadcastToProject(client.projectId, {
              type: 'tool_result',
              toolId,
              content,
              isError,
            })
          },
          onSessionInit: (sdkSessionId) => {
            if (session) {
              // Store the SDK session ID separately from local session ID
              session.sdkSessionId = sdkSessionId
              persistSession(session)
              if (client.projectId) {
                const projectState = getOrCreateProjectState(client.projectId)
                projectState.sessionId = sdkSessionId
              }
              broadcastToProject(client.projectId, {
                type: 'session_resumed',
                sessionId: session.sessionId,
              })
            }
          },
          onPermissionRequest: (requestId, toolName, input, reason) => {
            broadcastToProject(client.projectId, {
              type: 'permission_request',
              requestId,
              toolName,
              input,
              reason,
            })
          },
          onUsage: (usage) => {
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
              broadcastToProject(client.projectId, {
                type: 'thinking',
                thinking: (event.data as any).thinking,
              })
              break
            case 'tool_use':
              // Already handled in callback
              break
            case 'tool_result':
              // Already handled in callback
              break
            case 'result':
              const resultData = event.data as any
              broadcastToProject(client.projectId, {
                type: 'result',
                subtype: resultData.subtype,
                costUsd: resultData.costUsd,
                durationMs: resultData.durationMs,
                result: resultData.result,
                isError: resultData.isError,
              })
              break
            case 'ask_user_question':
              broadcastToProject(client.projectId, {
                type: 'ask_user_question',
                toolId: (event.data as any).toolId,
                questions: (event.data as any).questions,
              })
              break
          }
        }

        // Store assistant message
        const assistantMsg = storeAssistantMessage(clientState)
        if (assistantMsg) {
          session.messages.push(assistantMsg)
          session.lastModified = Date.now()

          // Update summary from response
          const summaryMatch = assistantMsg.content.match(/\[SUMMARY:\s*(.+?)\]/)
          if (summaryMatch) {
            session.summary = summaryMatch[1].trim()
            broadcastToProject(client.projectId, {
              type: 'query_summary',
              summary: session.summary,
            })
          }

          persistSession(session)

          // Send final assistant message
          broadcastToProject(client.projectId, {
            type: 'assistant_text',
            text: assistantMsg.content,
          })
        }

      } catch (err: any) {
        console.error('[ws] Query error:', err)
        broadcastToProject(client.projectId, {
          type: 'error',
          message: err.message || 'Query failed',
        })
        session.status = 'error'
      } finally {
        session.status = 'idle'
        broadcastToProject(client.projectId, { type: 'query_end' })
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

        // Persist old session state before clearing (keeps history on disk)
        if (session) {
          persistSession(session)
        }

        // Clear project state
        if (client.projectId) {
          const projectState = getOrCreateProjectState(client.projectId)
          projectState.messages = []
          projectState.sessionId = undefined
        }

        // Clear client state
        clientState.sessionId = undefined
        clientState.accumulatingText = ''
        clientState.accumulatingThinking = ''
        clientState.currentToolCalls = []

        // Detach client from old session
        client.sessionId = undefined

        sendToClient(client, { type: 'cleared' })

        // Create new session
        const newSessionId = generateSessionIdLocal()
        const newSession: Session = {
          sessionId: newSessionId,
          projectId: client.projectId,
          cwd: session?.cwd,
          messages: [],
          status: 'idle',
          lastModified: Date.now(),
        }
        sessions.set(newSessionId, newSession)
        client.sessionId = newSessionId
        persistSession(newSession)

        sendToClient(client, {
          type: 'system',
          subtype: 'init',
          sessionId: newSessionId,
        })

        // Send available models when creating new session after clear
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
          safeSend(ws, { type: 'error', message: 'A query is already running' })
          return
        }

        // Forward to prompt handling
        await handleClientMessage(ws, client, {
          type: 'prompt',
          prompt: msg.command,
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
      if (client.projectId) {
        const projectState = getOrCreateProjectState(client.projectId)
        projectState.cwd = newCwd
      }
      broadcastToProject(client.projectId, { type: 'cwd_changed', cwd: newCwd })
      break
    }

    case 'abort': {
      if (abortQuery(clientState)) {
        if (session) {
          session.status = 'idle'
        }
        broadcastToProject(client.projectId, { type: 'aborted' })
        broadcastProjectStatuses()
      }
      break
    }

    case 'resume_session': {
      const resumedSession = resumeSession(client, msg.sessionId)
      if (resumedSession) {
        // Use SDK session ID for resume, not local session ID
        clientState.sessionId = resumedSession.sdkSessionId
        if (client.projectId) {
          const projectState = getOrCreateProjectState(client.projectId)
          projectState.sessionId = resumedSession.sdkSessionId
        }
        sendToClient(client, {
          type: 'session_resumed',
          sessionId: resumedSession.sessionId,
        })
        sendToClient(client, {
          type: 'message_history',
          messages: resumedSession.messages,
        })
        // Send available models when resuming session
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
        })
      }
      break
    }

    case 'respond_question': {
      // Handle question response as a regular prompt
      if (!session) return

      const answerText = Object.entries(msg.answers)
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            return `${key}: ${value.join(', ')}`
          }
          return `${key}: ${value}`
        })
        .join('\n')

      // Forward as a prompt
      await handleClientMessage(ws, client, {
        type: 'prompt',
        prompt: answerText,
      })
      break
    }

    case 'respond_permission': {
      const handled = handlePermissionResponse(clientState, msg.requestId, msg.allow)
      if (!handled) {
        // Try to find in other clients in the same project
        if (client.projectId) {
          for (const [otherClientId, otherClientState] of Array.from(clients.entries())) {
            if (otherClientId !== client.clientId) {
              const otherState = getClientState(otherClientId)
              if (otherState && handlePermissionResponse(otherState, msg.requestId, msg.allow)) {
                break
              }
            }
          }
        }
      }
      break
    }

    case 'set_model': {
      clientState.model = msg.model || undefined
      if (client.projectId) {
        const projectState = getOrCreateProjectState(client.projectId)
        projectState.model = clientState.model
      }
      broadcastToProject(client.projectId, { type: 'model_changed', model: msg.model })
      break
    }

    case 'set_permission_mode': {
      const mode = msg.mode
      clientState.permissionMode = mode
      if (client.projectId) {
        const projectState = getOrCreateProjectState(client.projectId)
        projectState.permissionMode = mode
      }
      broadcastToProject(client.projectId, { type: 'permission_mode_changed', mode })
      break
    }
  }
}
