import type { CoreEngine } from './index.js'
import type { SessionManager } from './session.js'
import { QueryQueue } from './queue.js'
import { tsLog, C } from '../logger.js'
import type { AgentInterface, TurnSubmitParams, QueuedQuery, AgentStreamEvent, TurnType } from '../types/index.js'

export class TurnManager {
  private queue: QueryQueue
  private abortControllers = new Map<string, AbortController>() // queryId -> AbortController

  constructor(
    private agent: AgentInterface,
    private sessions: SessionManager,
    private core: CoreEngine,
  ) {
    this.queue = new QueryQueue()
    this.queue.onStatusChange = (query) => {
      this.core.emit('queue:status', {
        projectId: query.projectId,
        sessionId: query.sessionId,
        queryId: query.id,
        status: query.status,
        position: query.position,
        queueLength: this.queue.getQueueLength(query.projectId),
        prompt: query.prompt,
        queryType: query.type,
        cronJobName: query.cronJobName,
      })
    }
  }

  /** Submit a turn to the queue. Returns the queryId. */
  submit(params: TurnSubmitParams): string {
    const queryId = this.queue.enqueue({
      type: params.type,
      projectId: params.projectId,
      sessionId: params.sessionId,
      prompt: params.prompt,
      cronJobName: params.metadata?.cronJobName,
      executor: (queuedQuery) => this.execute(queuedQuery, params),
    })
    return queryId
  }

  /** Execute a turn — called by the queue when it's this query's turn */
  private async execute(queuedQuery: QueuedQuery, params: TurnSubmitParams): Promise<void> {
    const session = this.sessions.getMeta(params.sessionId)
    if (!session) {
      this.core.emit('turn:error', {
        projectId: params.projectId,
        sessionId: params.sessionId,
        turnId: '',
        error: 'Session not found',
      })
      return
    }

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const projectName = this.core.projects.get(params.projectId)?.name || params.projectId
    const tag = `${C.yellow}[turn]${C.reset}`
    tsLog(`${tag} ${C.bold}▶ start${C.reset}  project=${C.bold}${projectName}${C.reset}  session=${params.sessionId.slice(0, 12)}…  model=${C.bold}${session.model}${C.reset}  mode=${session.permissionMode}`)
    const promptPreview = (params.prompt || '').length > 150
      ? params.prompt.slice(0, 150) + '…'
      : params.prompt || ''
    tsLog(`${tag}   ${C.cyan}prompt:${C.reset} ${C.green}${promptPreview}${C.reset}`)

    // Update session status
    this.sessions.setStatus(params.sessionId, 'processing')
    this.core.emit('session:status_changed', {
      projectId: params.projectId,
      sessionId: params.sessionId,
      status: 'processing',
    })

    // Emit turn start
    this.core.emit('turn:start', {
      projectId: params.projectId,
      sessionId: params.sessionId,
      turnId,
      queryId: queuedQuery.id,
      prompt: params.prompt,
      type: params.type,
    })

    // Emit project processing
    this.core.emit('project:status_changed', {
      projectId: params.projectId,
      status: 'processing',
      sessionId: params.sessionId,
    })

    const projectPath = this.core.projects.getPath(params.projectId)
    if (!projectPath) {
      this.core.emit('turn:error', {
        projectId: params.projectId,
        sessionId: params.sessionId,
        turnId,
        error: 'Project path not found',
      })
      return
    }

    // Resolve model config ID (UUID) to actual model identifier and env
    const modelConfig = this.core.projects.resolveModelConfig(session.model)
    let resolvedModel: string | undefined
    if (modelConfig) {
      // Config found by UUID — extract the actual model identifier
      // For Anthropic OAuth (no apiKey, no modelId): leave undefined → SDK default
      // For custom providers without modelId: use config name
      resolvedModel = modelConfig.modelId
        || (modelConfig.provider === 'custom' ? modelConfig.name : undefined)
    } else {
      // Not a config UUID — session.model is already a model ID (e.g. 'claude-opus-4')
      resolvedModel = session.model
    }
    const modelEnv = modelConfig
      ? this.core.projects.buildModelEnv(modelConfig)
      : undefined

    tsLog(`${tag}   ${C.dim}model resolve: ${session.model} → ${resolvedModel ?? '(SDK default)'} (config ${modelConfig ? 'found' : 'NOT found'})${C.reset}`)
    if (modelEnv) {
      tsLog(`${tag}   ${C.dim}env: API_KEY=${modelEnv.ANTHROPIC_API_KEY ? modelEnv.ANTHROPIC_API_KEY.slice(0, 10) + '...' : 'unset'}  BASE_URL=${modelEnv.ANTHROPIC_BASE_URL || 'default'}${C.reset}`)
    }

    const abortController = new AbortController()
    this.abortControllers.set(queuedQuery.id, abortController)

    try {
      const stream = this.agent.query(params.prompt, {
        model: resolvedModel,
        permissionMode: session.permissionMode,
        cwd: projectPath,
        resume: session.sdkSessionId && !session.sdkSessionId.startsWith('pending-') ? session.sdkSessionId : undefined,
        enabledMcps: params.enabledMcps,
        disabledSdkServers: params.disabledSdkServers,
        disabledSkills: params.disabledSkills,
        images: params.images,
        abortController,
        soulEnabled: params.soulEnabled,
        env: modelEnv,
      })

      const startTime = Date.now()

      for await (const event of stream) {
        this.handleStreamEvent(event, {
          projectId: params.projectId,
          sessionId: params.sessionId,
          turnId,
          queryId: queuedQuery.id,
          type: params.type,
          startTime,
        })
      }
    } catch (error: any) {
      tsLog(`${tag} ${C.red}${C.bold}✗ error${C.reset}  project=${C.bold}${projectName}${C.reset}  ${error.message || 'Unknown error'}`)
      this.core.emit('turn:error', {
        projectId: params.projectId,
        sessionId: params.sessionId,
        turnId,
        error: error.message || 'Unknown error',
      })
      this.sessions.setStatus(params.sessionId, 'error')
      this.core.emit('session:status_changed', {
        projectId: params.projectId,
        sessionId: params.sessionId,
        status: 'error',
      })
    } finally {
      this.abortControllers.delete(queuedQuery.id)

      // Session back to idle
      if (session.status === 'processing') {
        this.sessions.setStatus(params.sessionId, 'idle')
        this.core.emit('session:status_changed', {
          projectId: params.projectId,
          sessionId: params.sessionId,
          status: 'idle',
        })
      }

      // Project back to idle
      this.core.emit('project:status_changed', {
        projectId: params.projectId,
        status: 'idle',
      })

      // Persist session meta
      if (session.sdkSessionId) {
        await this.sessions.persist(session.sdkSessionId)
      }
    }
  }

  private handleStreamEvent(
    event: AgentStreamEvent,
    ctx: {
      projectId: string
      sessionId: string
      turnId: string
      queryId: string
      type: TurnType
      startTime: number
    },
  ): void {
    switch (event.type) {
      case 'text_delta':
        this.core.emit('turn:delta', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          deltaType: 'text',
          text: event.text,
        })
        this.queue.touchActivity(ctx.queryId, 'text_delta')
        break

      case 'thinking_delta':
        this.core.emit('turn:delta', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          deltaType: 'thinking',
          text: event.text,
        })
        this.queue.touchActivity(ctx.queryId, 'thinking_delta')
        break

      case 'tool_use':
        this.core.emit('turn:tool_use', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolName: event.toolName,
          toolId: event.toolId,
          input: event.input,
          summary: event.summary,
        })
        this.queue.touchActivity(ctx.queryId, 'tool_use', event.toolName)
        break

      case 'tool_result':
        this.core.emit('turn:tool_result', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolId: event.toolId,
          content: event.content,
          isError: event.isError,
          totalLength: event.totalLength,
        })
        this.queue.touchActivity(ctx.queryId, 'tool_result')
        break

      case 'ask_user_question':
        this.sessions.setPendingQuestion(ctx.sessionId, event.toolId, event.questions)
        this.queue.pauseTimeout(ctx.queryId)
        this.core.emit('interaction:ask_question', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolId: event.toolId,
          questions: event.questions,
        })
        break

      case 'permission_request':
        this.sessions.setPendingPermission(ctx.sessionId, {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          reason: event.reason,
        })
        this.queue.pauseTimeout(ctx.queryId)
        this.core.emit('interaction:permission_request', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          reason: event.reason,
        })
        break

      case 'session_init':
        // Register the session with the SDK session ID
        this.sessions.register(event.sdkSessionId, this.sessions.getMeta(ctx.sessionId)!)
        this.core.emit('session:created', {
          projectId: ctx.projectId,
          sessionId: event.sdkSessionId,
        })
        break

      case 'result': {
        const durationSec = (event.durationMs / 1000).toFixed(1)
        const costStr = event.costUsd != null ? `$${event.costUsd.toFixed(4)}` : '?'
        const pName = this.core.projects.get(ctx.projectId)?.name || ctx.projectId
        const turnTag = `${C.yellow}[turn]${C.reset}`
        tsLog(`${turnTag} ${C.green}${C.bold}✅ done${C.reset}  project=${C.bold}${pName}${C.reset}  cost=${costStr}  duration=${durationSec}s  tokens: in=${event.usage.inputTokens} out=${event.usage.outputTokens} cache_read=${event.usage.cacheReadTokens}`)

        // Update session usage
        this.sessions.addUsage(ctx.sessionId, {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
          cacheCreateTokens: event.usage.cacheCreateTokens,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          contextWindowUsed: event.usage.contextWindowUsed,
          contextWindowMax: event.usage.contextWindowMax,
        })

        this.core.emit('turn:close', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          type: ctx.type,
          result: event.result,
          isError: event.isError,
          usage: event.usage,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          hasBackgroundTasks: event.hasBackgroundTasks,
          backgroundTaskIds: event.backgroundTaskIds,
        })
        break
      }

      case 'sdk_event':
        this.core.emit('turn:sdk_event', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          event: event.raw,
        })
        break

      case 'assistant_text':
        this.core.emit('turn:assistant_text', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          text: event.text,
          parentToolUseId: event.parentToolUseId,
        })
        break

      case 'thinking_complete':
        this.core.emit('turn:thinking_complete', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          thinking: event.thinking,
        })
        break

      case 'query_summary':
        this.core.emit('turn:summary', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          summary: event.summary,
        })
        break

      case 'query_suggestions':
        this.core.emit('turn:suggestions', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          suggestions: event.suggestions,
        })
        break

      case 'background_task_update':
        this.core.emit('turn:background_task', {
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          taskId: event.taskId,
          status: event.status,
          description: event.description,
          summary: event.summary,
          usage: event.usage,
        })
        break
    }

    // Emit activity event for heartbeat
    if (['text_delta', 'thinking_delta', 'tool_use', 'tool_result'].includes(event.type)) {
      this.core.emit('turn:activity', {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
        elapsedMs: Date.now() - ctx.startTime,
        activityType: event.type,
        toolName: event.type === 'tool_use' ? (event as any).toolName : undefined,
        textSnippet: event.type === 'text_delta' ? (event as any).text?.slice(0, 100) : undefined,
      })
    }
  }

  /** Abort the currently running query for a project */
  abort(projectId: string): void {
    const running = this.queue.getRunning(projectId)
    if (running) {
      // Abort via the abort controller
      const ac = this.abortControllers.get(running.id)
      if (ac) {
        ac.abort()
      }
      this.agent.abort(running.sessionId)
      this.queue.cancel(running.id)
    }
  }

  /** Respond to a permission request */
  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void {
    this.sessions.clearPendingPermission(sessionId)
    // Find the running query for this session to resume timeout
    const meta = this.sessions.getMeta(sessionId)
    if (meta) {
      const running = this.queue.getRunning(meta.projectId)
      if (running) {
        this.queue.resumeTimeout(running.id)
      }
    }
    this.agent.resolvePermission(requestId, behavior)
  }

  /** Respond to a question */
  respondQuestion(sessionId: string, answers: Record<string, string | string[]>): void {
    this.sessions.clearPendingQuestion(sessionId)
    const meta = this.sessions.getMeta(sessionId)
    if (meta) {
      const running = this.queue.getRunning(meta.projectId)
      if (running) {
        this.queue.resumeTimeout(running.id)
      }
    }
    this.agent.resolveQuestion(sessionId, answers)
  }

  /** Get queue snapshot for a project */
  getQueueSnapshot(projectId: string) {
    return this.queue.getSnapshot(projectId)
  }

  /** Dequeue a specific query */
  dequeue(queryId: string): boolean {
    return this.queue.dequeue(queryId)
  }

  /** Force execute a queued query (bypass queue) */
  forceExecute(queryId: string): boolean {
    return this.queue.forceExecute(queryId)
  }

  /** Get the queue length for a project */
  getQueueLength(projectId: string): number {
    return this.queue.getQueueLength(projectId)
  }

  destroy(): void {
    this.queue.destroy()
  }
}
