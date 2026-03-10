// WebSocket module — connection management and message routing
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type {
  ClientMessage,
  ServerMessage,
  ChatMessage,
  SessionInfo,
} from '@codeclaws/shared'
import { getToken } from '../auth/index.js'

interface Client {
  ws: WebSocket
  clientId: string
  projectId?: string
  sessionId?: string
}

interface Session {
  sessionId: string
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

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Get or create session for a client
function getOrCreateSession(client: Client): Session {
  if (client.sessionId && sessions.has(client.sessionId)) {
    return sessions.get(client.sessionId)!
  }

  const sessionId = generateSessionId()
  const session: Session = {
    sessionId,
    projectId: client.projectId,
    messages: [],
    status: 'idle',
    lastModified: Date.now(),
  }
  sessions.set(sessionId, session)
  client.sessionId = sessionId
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
  return session
}

// Get all sessions for a project or globally
export function getSessions(projectId?: string, cwd?: string): SessionInfo[] {
  const result: SessionInfo[] = []

  for (const session of sessions.values()) {
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
  return sessions.delete(sessionId)
}

// Broadcast message to all clients in a project
function broadcastToProject(projectId: string | undefined, message: ServerMessage, excludeClientId?: string) {
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

    // Get or create session
    const session = getOrCreateSession(client)

    // Send init message
    sendToClient(client, {
      type: 'system',
      subtype: 'init',
      sessionId: session.sessionId,
    })

    // Send message history
    if (session.messages.length > 0) {
      sendToClient(client, {
        type: 'message_history',
        messages: session.messages,
      })
    }

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        handleClientMessage(client, msg)
      } catch (err) {
        console.error('[ws] failed to parse message:', err)
        sendToClient(client, { type: 'error', message: 'Invalid message format' })
      }
    })

    ws.on('close', () => {
      console.log(`[ws] client disconnected: ${clientId}`)
      clients.delete(clientId)

      // Update session status if this was the last client
      if (client.sessionId) {
        const session = sessions.get(client.sessionId)
        if (session) {
          const hasOtherClients = Array.from(clients.values()).some(
            (c) => c.sessionId === client.sessionId
          )
          if (!hasOtherClients && session.status === 'processing') {
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

async function handleClientMessage(client: Client, msg: ClientMessage) {
  const session = client.sessionId ? sessions.get(client.sessionId) : undefined

  switch (msg.type) {
    case 'prompt': {
      if (!session) return

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

      // Broadcast to other clients in same project
      broadcastToProject(
        client.projectId,
        { type: 'user_message', message: userMsg },
        client.clientId
      )

      // Start processing
      session.status = 'processing'
      sendToClient(client, { type: 'query_start' })

      // TODO: Integrate with actual AI engine
      // For now, simulate a simple echo response
      setTimeout(() => {
        if (!session) return

        // Simulate streaming response
        const response = `I received your message: "${msg.prompt}"`
        let index = 0

        const streamInterval = setInterval(() => {
          if (index < response.length) {
            sendToClient(client, {
              type: 'stream_delta',
              deltaType: 'text',
              text: response[index],
            })
            index++
          } else {
            clearInterval(streamInterval)

            // Send final message
            const assistantMsg: ChatMessage = {
              id: genId(),
              role: 'assistant',
              content: response,
              timestamp: Date.now(),
            }
            session.messages.push(assistantMsg)
            session.status = 'idle'
            session.lastModified = Date.now()

            sendToClient(client, {
              type: 'assistant_text',
              text: response,
            })
            sendToClient(client, { type: 'query_end' })

            // Generate summary (first 50 chars of response)
            if (!session.summary) {
              session.summary = msg.prompt.slice(0, 50)
            }
          }
        }, 20)
      }, 500)

      break
    }

    case 'command': {
      if (msg.command === '/clear') {
        if (session) {
          session.messages = []
          session.summary = undefined
          session.firstPrompt = undefined
          session.lastModified = Date.now()
        }
        sendToClient(client, { type: 'cleared' })

        // Create new session
        const newSessionId = generateSessionId()
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

        sendToClient(client, {
          type: 'system',
          subtype: 'init',
          sessionId: newSessionId,
        })
      } else {
        // Handle other commands
        sendToClient(client, {
          type: 'error',
          message: `Unknown command: ${msg.command}`,
        })
      }
      break
    }

    case 'set_cwd': {
      if (session) {
        session.cwd = msg.cwd
      }
      sendToClient(client, { type: 'cwd_changed', cwd: msg.cwd })
      break
    }

    case 'abort': {
      if (session) {
        session.status = 'idle'
      }
      sendToClient(client, { type: 'aborted' })
      break
    }

    case 'resume_session': {
      const resumedSession = resumeSession(client, msg.sessionId)
      if (resumedSession) {
        sendToClient(client, {
          type: 'session_resumed',
          sessionId: resumedSession.sessionId,
        })
        sendToClient(client, {
          type: 'message_history',
          messages: resumedSession.messages,
        })
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

      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: answerText,
        timestamp: Date.now(),
      }
      session.messages.push(userMsg)
      session.lastModified = Date.now()

      // Simulate response
      session.status = 'processing'
      sendToClient(client, { type: 'query_start' })

      setTimeout(() => {
        if (!session) return
        const response = `Received your response: ${answerText}`
        const assistantMsg: ChatMessage = {
          id: genId(),
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
        }
        session.messages.push(assistantMsg)
        session.status = 'idle'
        session.lastModified = Date.now()

        sendToClient(client, {
          type: 'assistant_text',
          text: response,
        })
        sendToClient(client, { type: 'query_end' })
      }, 500)

      break
    }

    case 'respond_permission': {
      // Handle permission response
      sendToClient(client, {
        type: 'system',
        subtype: 'permission_response',
      })
      break
    }

    case 'set_model': {
      sendToClient(client, { type: 'model_changed', model: msg.model })
      break
    }

    case 'set_permission_mode': {
      sendToClient(client, { type: 'permission_mode_changed', mode: msg.mode })
      break
    }
  }
}
