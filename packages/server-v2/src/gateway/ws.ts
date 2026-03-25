import { WebSocketServer, type WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { CoreEngine } from '../core/index.js'
import type { Broadcaster } from './broadcaster.js'
import type { Client } from '../types/index.js'
import type { ClientMessage } from '@codecrab/shared'
import { verifyWebSocketToken } from './auth.js'

let connectionCounter = 0

export function setupWebSocket(server: Server, core: CoreEngine, broadcaster: Broadcaster): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  // Handle HTTP upgrade with token verification
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`)

    // Only handle /ws path
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }

    const token = url.searchParams.get('token')
    const valid = await verifyWebSocketToken(token)
    if (!valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws: WebSocket, request: any) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`)
    const clientId = url.searchParams.get('clientId') || `client-${Date.now()}`
    const connectionId = `conn-${++connectionCounter}-${Date.now()}`

    const client: Client = {
      ws,
      connectionId,
      clientId,
      subscribedProjects: new Map(),
    }

    broadcaster.addClient(client)

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage
        handleClientMessage(core, broadcaster, client, message)
      } catch (err: any) {
        broadcaster.send(client, {
          type: 'error',
          message: `Invalid message: ${err.message}`,
        })
      }
    })

    ws.on('close', () => {
      broadcaster.removeClient(connectionId)
    })

    ws.on('error', () => {
      broadcaster.removeClient(connectionId)
    })
  })

  return wss
}

function handleClientMessage(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: ClientMessage): void {
  switch (message.type) {
    case 'prompt':
      handlePrompt(core, broadcaster, client, message)
      break
    case 'abort':
      handleAbort(core, message)
      break
    case 'resume_session':
      handleResumeSession(core, broadcaster, client, message)
      break
    case 'respond_question':
      handleRespondQuestion(core, message)
      break
    case 'respond_permission':
      handleRespondPermission(core, message)
      break
    case 'set_model':
      handleSetModel(core, broadcaster, client, message)
      break
    case 'set_permission_mode':
      handleSetPermissionMode(core, broadcaster, client, message)
      break
    case 'switch_project':
      handleSwitchProject(core, broadcaster, client, message)
      break
    case 'probe_sdk':
      handleProbeSdk(core, broadcaster, client, message)
      break
    case 'dequeue':
      handleDequeue(core, message)
      break
    case 'execute_now':
      handleExecuteNow(core, message)
      break
    case 'request_queue_snapshot':
      handleQueueSnapshot(core, broadcaster, client, message)
      break
    case 'set_cwd':
      // CWD is determined by project path, acknowledge only
      break
    case 'command':
      // TODO: Command handling
      break
  }
}

function handlePrompt(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) {
    broadcaster.send(client, { type: 'error', message: 'Missing projectId' })
    return
  }

  // Get or create session
  let sessionId = message.sessionId
  const sub = client.subscribedProjects.get(projectId)
  if (!sessionId && sub?.sessionId) {
    sessionId = sub.sessionId
  }

  if (!sessionId) {
    // Create new session
    const project = core.projects.get(projectId)
    if (!project) {
      broadcaster.send(client, { type: 'error', message: 'Project not found' })
      return
    }
    const meta = core.sessions.create(projectId, project)
    // Use a temporary ID until SDK provides the real one
    sessionId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    core.sessions.register(sessionId, meta)
    client.subscribedProjects.set(projectId, { sessionId })
  }

  core.submitTurn({
    projectId,
    sessionId,
    prompt: message.prompt,
    type: 'user',
    images: message.images,
    enabledMcps: message.enabledMcps,
    disabledSdkServers: message.disabledSdkServers,
    disabledSkills: message.disabledSkills,
    soulEnabled: message.soulEnabled,
  })
}

function handleAbort(core: CoreEngine, message: any): void {
  const projectId = message.projectId
  if (projectId) {
    core.turns.abort(projectId)
  }
}

function handleResumeSession(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  const sessionId = message.sessionId
  if (!projectId || !sessionId) return

  // Update client subscription
  client.subscribedProjects.set(projectId, { sessionId })

  // Check if session meta exists, create if needed
  let meta = core.sessions.getMeta(sessionId)
  if (!meta) {
    const project = core.projects.get(projectId)
    if (project) {
      meta = core.sessions.create(projectId, project)
      core.sessions.register(sessionId, meta)
    }
  }

  core.emit('session:resumed', { projectId, sessionId })
}

function handleRespondQuestion(core: CoreEngine, message: any): void {
  const sessionId = message.sessionId
  if (!sessionId) return
  core.turns.respondQuestion(sessionId, message.answers)
}

function handleRespondPermission(core: CoreEngine, message: any): void {
  const sessionId = message.sessionId
  if (!sessionId) return
  core.turns.respondPermission(sessionId, message.requestId, message.allow ? 'allow' : 'deny')
}

function handleSetModel(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) return

  // Model change = create new session
  const project = core.projects.get(projectId)
  if (!project) return

  const meta = core.sessions.create(projectId, project, { model: message.model })
  const sessionId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  core.sessions.register(sessionId, meta)
  client.subscribedProjects.set(projectId, { sessionId })

  broadcaster.send(client, {
    type: 'model_changed',
    projectId,
    sessionId,
    model: message.model,
  })

  broadcaster.send(client, {
    type: 'session_created',
    projectId,
    sessionId,
  })
}

function handleSetPermissionMode(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const sessionId = message.sessionId
  if (!sessionId) return

  core.sessions.update(sessionId, { permissionMode: message.mode })

  broadcaster.send(client, {
    type: 'permission_mode_changed',
    projectId: message.projectId,
    sessionId,
    mode: message.mode,
  })
}

function handleSwitchProject(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) return

  // Update subscription
  if (!client.subscribedProjects.has(projectId)) {
    client.subscribedProjects.set(projectId, {})
  }

  // Try to auto-resume latest session
  const latest = core.sessions.findLatest(projectId)
  if (latest?.sdkSessionId) {
    client.subscribedProjects.set(projectId, { sessionId: latest.sdkSessionId })
    core.emit('session:resumed', { projectId, sessionId: latest.sdkSessionId })
  }

  // Send project statuses
  broadcaster.send(client, {
    type: 'project_statuses',
    statuses: core.projects.list().map(p => ({
      projectId: p.id,
      status: core.sessions.findActive(p.id) ? 'processing' as const : 'idle' as const,
    })),
  })
}

async function handleProbeSdk(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): Promise<void> {
  const projectId = message.projectId
  if (!projectId) return

  const projectPath = core.projects.getPath(projectId)
  if (!projectPath) return

  try {
    // Agent is accessible through core's internal reference
    // We'll need to expose a probe method on CoreEngine
    // For now, send an error -- this will be wired up when the entry point connects things
    broadcaster.send(client, {
      type: 'error',
      message: 'Probe not yet implemented in v2',
    })
  } catch (err: any) {
    broadcaster.send(client, {
      type: 'error',
      message: `Probe failed: ${err.message}`,
    })
  }
}

function handleDequeue(core: CoreEngine, message: any): void {
  if (message.queryId) {
    core.turns.dequeue(message.queryId)
  }
}

function handleExecuteNow(core: CoreEngine, message: any): void {
  if (message.queryId) {
    core.turns.forceExecute(message.queryId)
  }
}

function handleQueueSnapshot(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) return

  const snapshot = core.turns.getQueueSnapshot(projectId)
  const items = [
    ...(snapshot.running ? [{
      queryId: snapshot.running.id,
      status: snapshot.running.status,
      position: 0,
      prompt: snapshot.running.prompt,
      queryType: snapshot.running.type,
      sessionId: snapshot.running.sessionId,
      cronJobName: snapshot.running.cronJobName,
    }] : []),
    ...snapshot.queued.map(q => ({
      queryId: q.id,
      status: q.status,
      position: q.position,
      prompt: q.prompt,
      queryType: q.type,
      sessionId: q.sessionId,
      cronJobName: q.cronJobName,
    })),
  ]
  broadcaster.send(client, {
    type: 'query_queue_snapshot',
    projectId,
    items,
  })
}
