import type { CoreEngine } from '../core/index.js'
import type { Client } from '../types/index.js'
import type { ServerMessage } from '@codecrab/shared'

export class Broadcaster {
  private clients = new Map<string, Client>()  // connectionId -> Client

  constructor(private core: CoreEngine) {
    this.subscribe()
  }

  /** Register a client connection */
  addClient(client: Client): void {
    this.clients.set(client.connectionId, client)
  }

  /** Remove a client connection */
  removeClient(connectionId: string): void {
    this.clients.delete(connectionId)
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
    for (const client of this.getClientsForProject(projectId)) {
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

    // Session lifecycle
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
  }
}
