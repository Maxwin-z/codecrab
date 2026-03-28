import { WebSocketServer, type WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { CoreEngine } from '../core/index.js'
import type { Broadcaster } from './broadcaster.js'
import type { Client } from '../types/index.js'
import type { ClientMessage } from '@codecrab/shared'
import { verifyWebSocketToken } from './auth.js'
import { saveAndConvertImages } from '../images.js'
import { tsLog, C } from '../logger.js'

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
    tsLog(`${C.green}[ws]${C.reset} ${C.bold}connected${C.reset}  client=${clientId}  conn=${connectionId}`)

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
      tsLog(`${C.dim}[ws] disconnected${C.reset}  client=${clientId}  conn=${connectionId}`)
      broadcaster.removeClient(connectionId)
    })

    ws.on('error', () => {
      tsLog(`${C.red}[ws] error${C.reset}  client=${clientId}  conn=${connectionId}`)
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
    case 'set_provider':
      handleSetProvider(core, broadcaster, client, message)
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
    case 'new_session':
      handleNewSession(client, message)
      break
    case 'set_cwd':
      // CWD is determined by project path, acknowledge only
      break
    case 'command':
      // TODO: Command handling
      break
  }
}

async function handlePrompt(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): Promise<void> {
  const projectId = message.projectId
  if (!projectId) {
    broadcaster.send(client, { type: 'error', message: 'Missing projectId' })
    return
  }

  // Log the incoming prompt
  const project = core.projects.get(projectId)
  const projectName = project?.name || projectId
  const promptPreview = (message.prompt || '').length > 200
    ? message.prompt.slice(0, 200) + '…'
    : message.prompt || ''
  tsLog(`${C.cyan}[ws]${C.reset} ${C.bold}◆ prompt${C.reset}  project=${C.bold}${projectName}${C.reset}  client=${client.clientId}`)
  tsLog(`${C.cyan}[ws]${C.reset}   ${C.green}${promptPreview}${C.reset}`)

  // Ensure client is subscribed to this project (may have been missed if switch_project was dropped)
  if (!client.subscribedProjects.has(projectId)) {
    client.subscribedProjects.set(projectId, {})
  }

  // Session resolution: only two paths supported.
  //  1. tempSessionId present → new session (client-generated temp ID)
  //  2. sessionId present     → existing session
  // Empty/missing sessionId without tempSessionId is rejected.
  let sessionId = message.sessionId || undefined  // normalize empty string to undefined

  tsLog(`${C.cyan}[ws]${C.reset}   ${C.dim}session resolve: sessionId=${sessionId ?? 'none'}  tempSessionId=${message.tempSessionId ?? 'none'}${C.reset}`)

  if (!sessionId && message.tempSessionId) {
    // New session — create meta and register with temp ID
    if (!project) {
      broadcaster.send(client, { type: 'error', message: 'Project not found' })
      return
    }
    const meta = core.sessions.create(projectId, project, {
      providerId: message.providerId || undefined,
    })
    sessionId = message.tempSessionId
    core.sessions.register(sessionId, meta)
    client.subscribedProjects.set(projectId, { sessionId })
    tsLog(`${C.cyan}[ws]${C.reset}   ${C.dim}new session: ${sessionId}${C.reset}`)
  } else if (sessionId) {
    // Existing session — update subscription
    client.subscribedProjects.set(projectId, { sessionId })
  } else {
    // Neither sessionId nor tempSessionId — reject
    broadcaster.send(client, { type: 'error', message: 'Missing sessionId or tempSessionId' })
    return
  }

  // Save images to disk and convert to URL refs for broadcasting;
  // keep original base64 data for the SDK agent.
  const originalImages = message.images?.length ? message.images : undefined
  const urlImages = originalImages ? await saveAndConvertImages(originalImages) : undefined

  // Send sync ack to the sending client only (message will appear in chat when execution starts)
  broadcaster.send(client, {
    type: 'prompt_received',
    projectId,
    sessionId,
  })

  core.submitTurn({
    projectId,
    sessionId,
    prompt: message.prompt,
    type: 'user',
    images: originalImages,
    urlImages,
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

function handleNewSession(client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) return
  // Clear the session binding so the next prompt creates a fresh session
  const sub = client.subscribedProjects.get(projectId)
  if (sub) {
    sub.sessionId = undefined
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

  core.emit('session:resumed', { projectId, sessionId, providerId: meta?.providerId })
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

function handleSetProvider(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const projectId = message.projectId
  if (!projectId) return

  // Provider change = create new session
  const project = core.projects.get(projectId)
  if (!project) return

  const meta = core.sessions.create(projectId, project, { providerId: message.providerId })
  const sessionId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  core.sessions.register(sessionId, meta)
  client.subscribedProjects.set(projectId, { sessionId })

  broadcaster.broadcastToProject(projectId, {
    type: 'provider_changed',
    projectId,
    sessionId,
    providerId: message.providerId,
  })

  broadcaster.broadcastToProject(projectId, {
    type: 'session_created',
    projectId,
    sessionId,
  })
}

function handleSetPermissionMode(core: CoreEngine, broadcaster: Broadcaster, client: Client, message: any): void {
  const sessionId = message.sessionId
  if (!sessionId) return

  core.sessions.update(sessionId, { permissionMode: message.mode })

  broadcaster.broadcastToProject(message.projectId, {
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
  tsLog(`${C.green}[ws]${C.reset} switch_project  client=${client.clientId}  conn=${client.connectionId}  project=${projectId.slice(0, 8)}  subscribedClients=${broadcaster.getClientsForProject(projectId).length}`)

  // Try to auto-resume latest session
  const latest = core.sessions.findLatest(projectId)
  if (latest?.sdkSessionId) {
    client.subscribedProjects.set(projectId, { sessionId: latest.sdkSessionId })
    core.emit('session:resumed', { projectId, sessionId: latest.sdkSessionId, providerId: latest.providerId })
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

  try {
    const info = await core.probeSdk(projectId)
    broadcaster.send(client, {
      type: 'sdk_probe_result',
      projectId,
      tools: info.tools,
      sdkMcpServers: info.mcpServers,
      sdkSkills: info.skills,
      models: info.models,
    })
  } catch (err: any) {
    broadcaster.send(client, {
      type: 'error',
      projectId,
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
