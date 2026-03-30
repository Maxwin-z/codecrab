import type { CoreEngine } from '../core/index.js'
import type { Client } from '../types/index.js'
import type { ServerMessage } from '@codecrab/shared'
import { tsLog, C } from '../logger.js'

export class Broadcaster {
  private clients = new Map<string, Client>()  // connectionId -> Client

  constructor(private core: CoreEngine) {
    this.subscribe()
  }

  /** Register a client connection */
  addClient(client: Client): void {
    this.clients.set(client.connectionId, client)
    tsLog(`${C.green}[broadcast]${C.reset} +client  conn=${client.connectionId}  clientId=${client.clientId}  total=${this.clients.size}`)
  }

  /** Remove a client connection */
  removeClient(connectionId: string): void {
    this.clients.delete(connectionId)
    tsLog(`${C.dim}[broadcast]${C.reset} -client  conn=${connectionId}  total=${this.clients.size}`)
  }

  /** Get a client by connectionId */
  getClient(connectionId: string): Client | undefined {
    return this.clients.get(connectionId)
  }

  /** Get all clients subscribed to a project */
  getClientsForProject(projectId: string): Client[] {
    const result: Client[] = []
    for (const client of this.clients.values()) {
      if (client.subscribedProjects.has(projectId)) {
        result.push(client)
      }
    }
    return result
  }

  /** Send a message to a specific client */
  send(client: Client, message: ServerMessage): void {
    if (client.ws.readyState === 1) {  // WebSocket.OPEN
      client.ws.send(JSON.stringify(message))
    }
  }

  /** Broadcast to all clients subscribed to a project */
  broadcastToProject(projectId: string, message: ServerMessage): void {
    const clients = this.getClientsForProject(projectId)
    const msgType = (message as any).type
    tsLog(`${C.dim}[broadcast]${C.reset} ${msgType} → ${C.bold}${clients.length}${C.reset} client(s) for project=${projectId.slice(0, 8)}  total_connections=${this.clients.size}`)
    for (const client of clients) {
      this.send(client, message)
    }
  }

  /** Broadcast to all connected clients */
  broadcastGlobal(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      this.send(client, message)
    }
  }

  /** Subscribe to Core events and translate to client messages */
  private subscribe(): void {
    // Turn lifecycle events
    this.core.on('turn:start', (e) => {
      // Broadcast user message to all clients when execution actually starts
      this.broadcastToProject(e.projectId, {
        type: 'user_message',
        projectId: e.projectId,
        sessionId: e.sessionId,
        message: {
          id: `user-${Date.now()}`,
          role: 'user',
          content: e.prompt,
          images: e.images,
          timestamp: Date.now(),
        },
      })
      this.broadcastToProject(e.projectId, {
        type: 'query_start',
        projectId: e.projectId,
        sessionId: e.sessionId,
        queryId: e.queryId,
      })
    })

    this.core.on('turn:delta', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'stream_delta',
        projectId: e.projectId,
        sessionId: e.sessionId,
        deltaType: e.deltaType,
        text: e.text,
      })
    })

    this.core.on('turn:tool_use', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'tool_use',
        projectId: e.projectId,
        sessionId: e.sessionId,
        toolName: e.toolName,
        toolId: e.toolId,
        input: e.input,
      })
    })

    this.core.on('turn:tool_result', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'tool_result',
        projectId: e.projectId,
        sessionId: e.sessionId,
        toolId: e.toolId,
        content: e.content,
        isError: e.isError,
        totalLength: e.totalLength,
      })
    })

    this.core.on('turn:close', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'result',
        projectId: e.projectId,
        sessionId: e.sessionId,
        subtype: e.isError ? 'error' : 'success',
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        result: e.result,
        isError: e.isError,
      })
      // Also send query_end
      this.broadcastToProject(e.projectId, {
        type: 'query_end',
        projectId: e.projectId,
        sessionId: e.sessionId,
        hasBackgroundTasks: e.hasBackgroundTasks,
        backgroundTaskIds: e.backgroundTaskIds,
      })
      // Send session usage
      const session = this.core.sessions.getMeta(e.sessionId)
      if (session) {
        this.broadcastToProject(e.projectId, {
          type: 'session_usage',
          projectId: e.projectId,
          sessionId: e.sessionId,
          totalInputTokens: session.usage.totalInputTokens,
          totalOutputTokens: session.usage.totalOutputTokens,
          totalCacheReadTokens: session.usage.totalCacheReadTokens,
          totalCacheCreateTokens: session.usage.totalCacheCreateTokens,
          totalCostUsd: session.usage.totalCostUsd,
          totalDurationMs: session.usage.totalDurationMs,
          queryCount: session.usage.queryCount,
          contextWindowUsed: session.usage.contextWindowUsed,
          contextWindowMax: session.usage.contextWindowMax,
        })
      }
    })

    this.core.on('turn:error', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'error',
        projectId: e.projectId,
        sessionId: e.sessionId,
        message: e.error,
      })
    })

    this.core.on('turn:assistant_text', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'assistant_text',
        projectId: e.projectId,
        sessionId: e.sessionId,
        text: e.text,
        parentToolUseId: e.parentToolUseId,
      })
    })

    this.core.on('turn:thinking_complete', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'thinking',
        projectId: e.projectId,
        sessionId: e.sessionId,
        thinking: e.thinking,
      })
    })

    this.core.on('turn:summary', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'query_summary',
        projectId: e.projectId,
        sessionId: e.sessionId,
        summary: e.summary,
      })
    })

    this.core.on('turn:suggestions', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'query_suggestions',
        projectId: e.projectId,
        sessionId: e.sessionId,
        suggestions: e.suggestions,
      })
    })

    this.core.on('turn:sdk_event', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'sdk_event',
        projectId: e.projectId,
        sessionId: e.sessionId,
        event: e.event,
      })
    })

    this.core.on('turn:background_task', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'background_task_update',
        projectId: e.projectId,
        sessionId: e.sessionId,
        taskId: e.taskId,
        status: e.status,
        description: e.description,
        summary: e.summary,
        usage: e.usage,
      })
    })

    // Interaction events
    this.core.on('interaction:ask_question', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'ask_user_question',
        projectId: e.projectId,
        sessionId: e.sessionId,
        toolId: e.toolId,
        questions: e.questions,
      })
    })

    this.core.on('interaction:permission_request', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'permission_request',
        projectId: e.projectId,
        sessionId: e.sessionId,
        requestId: e.requestId,
        toolName: e.toolName,
        input: e.input,
        reason: e.reason || '',
      })
    })

    this.core.on('interaction:permission_resolved', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'permission_resolved',
        projectId: e.projectId,
        sessionId: e.sessionId,
        requestId: e.requestId,
      })
    })

    this.core.on('interaction:question_resolved', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'question_resolved',
        projectId: e.projectId,
        sessionId: e.sessionId,
        toolId: e.toolId,
      })
    })

    // Session lifecycle
    this.core.on('session:id_resolved', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'session_id_resolved',
        projectId: e.projectId,
        sessionId: e.sessionId,
        tempSessionId: e.tempSessionId,
      })
    })

    this.core.on('session:created', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'session_created',
        projectId: e.projectId,
        sessionId: e.sessionId,
        parentSessionId: e.parentSessionId,
        cronJobId: e.cronJobId,
        cronJobName: e.cronJobName,
      })
    })

    this.core.on('session:resumed', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'session_resumed',
        projectId: e.projectId,
        sessionId: e.sessionId,
        providerId: e.providerId,
      })
      // Send cached session usage so the client has context window info immediately
      const session = this.core.sessions.getMeta(e.sessionId)
      tsLog(`${C.dim}[broadcast]${C.reset} session:resumed  session=${e.sessionId.slice(0, 8)}  hasMeta=${!!session}  queryCount=${session?.usage.queryCount ?? 0}  ctxUsed=${session?.usage.contextWindowUsed ?? 0}  ctxMax=${session?.usage.contextWindowMax ?? 0}`)
      if (session && session.usage.queryCount > 0) {
        this.broadcastToProject(e.projectId, {
          type: 'session_usage',
          projectId: e.projectId,
          sessionId: e.sessionId,
          totalInputTokens: session.usage.totalInputTokens,
          totalOutputTokens: session.usage.totalOutputTokens,
          totalCacheReadTokens: session.usage.totalCacheReadTokens,
          totalCacheCreateTokens: session.usage.totalCacheCreateTokens,
          totalCostUsd: session.usage.totalCostUsd,
          totalDurationMs: session.usage.totalDurationMs,
          queryCount: session.usage.queryCount,
          contextWindowUsed: session.usage.contextWindowUsed,
          contextWindowMax: session.usage.contextWindowMax,
        })
      }
      // Re-send pending question if one was waiting when client disconnected
      if (session?.pendingQuestion) {
        this.broadcastToProject(e.projectId, {
          type: 'ask_user_question',
          projectId: e.projectId,
          sessionId: e.sessionId,
          toolId: session.pendingQuestion.toolId,
          questions: session.pendingQuestion.questions,
        })
      }
      // Re-send pending permission request if one was waiting
      if (session?.pendingPermissionRequest) {
        this.broadcastToProject(e.projectId, {
          type: 'permission_request',
          projectId: e.projectId,
          sessionId: e.sessionId,
          requestId: session.pendingPermissionRequest.requestId,
          toolName: session.pendingPermissionRequest.toolName,
          input: session.pendingPermissionRequest.input,
          reason: session.pendingPermissionRequest.reason || '',
        })
      }
    })

    this.core.on('session:status_changed', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'session_status_changed',
        projectId: e.projectId,
        sessionId: e.sessionId,
        status: e.status,
      })
    })

    // Project status
    this.core.on('project:status_changed', (e) => {
      this.broadcastGlobal({
        type: 'project_statuses',
        statuses: this.core.projects.list().map(p => ({
          projectId: p.id,
          status: p.id === e.projectId ? e.status : 'idle',
          sessionId: e.sessionId,
        })),
      })
    })

    // Queue status
    this.core.on('queue:status', (e) => {
      this.broadcastToProject(e.projectId, {
        type: 'query_queue_status',
        projectId: e.projectId,
        sessionId: e.sessionId,
        queryId: e.queryId,
        status: e.status,
        position: e.position,
        queueLength: e.queueLength,
        prompt: e.prompt,
        queryType: e.queryType,
        cronJobName: e.cronJobName,
      })
    })

    // ── Thread events (global broadcast) ──────────────────────────────────

    this.core.on('thread:created', (e) => {
      this.broadcastGlobal({
        type: 'thread_created',
        data: {
          id: e.thread.id,
          title: e.thread.title,
          status: e.thread.status,
          parentThreadId: e.thread.parentThreadId,
          participants: e.thread.participants.map(p => ({ agentId: p.agentId, agentName: p.agentName })),
          createdAt: e.thread.createdAt,
        },
      })
    })

    this.core.on('thread:completed', (e) => {
      this.broadcastGlobal({
        type: 'thread_completed',
        data: { id: e.thread.id, title: e.thread.title, status: 'completed' },
      })
    })

    this.core.on('thread:stalled', (e) => {
      this.broadcastGlobal({
        type: 'thread_stalled',
        data: { id: e.thread.id, title: e.thread.title, status: 'stalled', reason: e.reason },
      })
    })

    this.core.on('message:sent', (e) => {
      const fromName = e.message.from.agentName
      const toName = e.message.to === 'broadcast' ? 'broadcast' : e.message.to.agentName
      this.broadcastGlobal({
        type: 'agent_message',
        data: {
          message: {
            id: e.message.id,
            from: fromName,
            to: toName,
            content: e.message.content,
            artifacts: e.message.artifacts,
            timestamp: e.message.createdAt,
          },
          threadId: e.threadId,
        },
      })
    })

    this.core.on('agent:auto_resume', (e) => {
      this.broadcastGlobal({
        type: 'agent_auto_resume',
        data: {
          agentId: e.agentId,
          agentName: e.agentName,
          threadId: e.threadId,
          threadTitle: e.threadTitle,
          triggeredBy: e.triggeredBy,
        },
      })
    })
  }
}
