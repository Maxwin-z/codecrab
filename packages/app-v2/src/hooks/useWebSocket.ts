import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ServerMessage,
  ClientMessage,
  ImageAttachment,
  DebugEvent,
  ProjectStatus,
  Question,
  ChatMessage,
} from '@codecrab/shared'
import { getWebSocketUrl } from '@/lib/auth'
import { authFetch } from '@/lib/auth'
import { stripMetaTags } from '@/lib/utils'

// ============ Types ============

export interface SessionUsage {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreateTokens: number
  totalCostUsd: number
  totalDurationMs: number
  queryCount: number
  contextWindowUsed: number
  contextWindowMax: number
}

export interface ActivityHeartbeat {
  queryId: string
  elapsedMs: number
  lastActivityType: string
  lastToolName?: string
  textSnippet?: string
  paused?: boolean
}

export interface QueueItem {
  queryId: string
  status: string
  position: number
  prompt: string
  queryType: 'user' | 'cron' | 'channel'
  sessionId?: string
  cronJobName?: string
}

export interface PendingPermission {
  requestId: string
  toolName: string
  input: unknown
  reason: string
}

export interface PendingQuestion {
  toolId: string
  questions: Question[]
}

export interface BackgroundTask {
  taskId: string
  status: 'started' | 'progress' | 'completed' | 'failed' | 'stopped'
  description?: string
  summary?: string
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  toolCalls?: { name: string; id: string; input: unknown; result?: string; isError?: boolean }[]
  images?: ImageAttachment[]
  timestamp: number
}

export interface SessionState {
  messages: ChatMsg[]
  sdkEvents: DebugEvent[]
  streamingText: string
  streamingThinking: string
  isStreaming: boolean
  suggestions: string[]
  summary: string
}

export interface ProjectChatState {
  sessionId: string | null
  currentProvider: string | null
  sessionState: SessionState
  isRunning: boolean
  isAborting: boolean
  permissionMode: 'bypassPermissions' | 'default'
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  activityHeartbeat: ActivityHeartbeat | null
  queryQueue: QueueItem[]
  sessionUsage: SessionUsage | null
  backgroundTasks: Map<string, BackgroundTask>
}

function createEmptySessionState(): SessionState {
  return {
    messages: [],
    sdkEvents: [],
    streamingText: '',
    streamingThinking: '',
    isStreaming: false,
    suggestions: [],
    summary: '',
  }
}

function createEmptyProjectState(): ProjectChatState {
  return {
    sessionId: null,
    currentProvider: null,
    sessionState: createEmptySessionState(),
    isRunning: false,
    isAborting: false,
    permissionMode: 'default',
    pendingPermission: null,
    pendingQuestion: null,
    activityHeartbeat: null,
    queryQueue: [],
    sessionUsage: null,
    backgroundTasks: new Map(),
  }
}

// ============ Hook ============

export interface UseWebSocketReturn {
  connected: boolean
  projectStatuses: ProjectStatus[]

  // Current project state
  getProjectState(projectId: string): ProjectChatState

  // Actions
  sendPrompt(projectId: string, prompt: string, options?: {
    sessionId?: string
    images?: ImageAttachment[]
    providerId?: string
    enabledMcps?: string[]
    soulEnabled?: boolean
  }): void
  abort(projectId: string): void
  switchProject(projectId: string): void
  newSession(projectId: string): void
  resumeSession(projectId: string, sessionId: string): void
  setProvider(projectId: string, providerConfigId: string): void
  setPermissionMode(projectId: string, sessionId: string, mode: 'bypassPermissions' | 'default'): void
  respondPermission(sessionId: string, requestId: string, allow: boolean): void
  respondQuestion(sessionId: string, toolId: string, answers: Record<string, string | string[]>): void
  dequeue(queryId: string): void
  executeNow(queryId: string): void
  requestQueueSnapshot(projectId: string): void
  probeSdk(projectId: string): void
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([])
  const projectStatesRef = useRef(new Map<string, ProjectChatState>())
  const [, forceUpdate] = useState(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const clientId = useRef(`client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  const rerender = useCallback(() => forceUpdate(n => n + 1), [])

  const getOrCreateProjectState = useCallback((projectId: string): ProjectChatState => {
    let state = projectStatesRef.current.get(projectId)
    if (!state) {
      state = createEmptyProjectState()
      projectStatesRef.current.set(projectId, state)
    }
    return state
  }, [])

  const getProjectState = useCallback((projectId: string): ProjectChatState => {
    return getOrCreateProjectState(projectId)
  }, [getOrCreateProjectState])

  // Get session state for a project, handling session-scoped messages
  const getSessionState = useCallback((projectId: string, sessionId?: string): SessionState => {
    const ps = getOrCreateProjectState(projectId)
    // If message is for a different session, ignore or handle
    if (sessionId && ps.sessionId && sessionId !== ps.sessionId) {
      // Message for a different session — don't update current view
      return ps.sessionState
    }
    return ps.sessionState
  }, [getOrCreateProjectState])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const handleMessage = useCallback((event: MessageEvent) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }

    const projectId = ('projectId' in msg ? msg.projectId : undefined) as string | undefined
    const sessionId = ('sessionId' in msg ? msg.sessionId : undefined) as string | undefined

    switch (msg.type) {
      case 'query_start': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.isRunning = true
        ps.isAborting = false
        ps.sessionState.isStreaming = true
        ps.sessionState.streamingText = ''
        ps.sessionState.streamingThinking = ''
        ps.pendingPermission = null
        ps.pendingQuestion = null
        if (sessionId && !ps.sessionId) {
          ps.sessionId = sessionId
        }
        rerender()
        break
      }

      case 'stream_delta': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        if (msg.deltaType === 'text') {
          ps.sessionState.streamingText += msg.text
        } else if (msg.deltaType === 'thinking') {
          ps.sessionState.streamingThinking += msg.text
        }
        rerender()
        break
      }

      case 'assistant_text': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        // Full assistant text — finalize streaming into a message
        const cleanText = stripMetaTags(msg.text)
        if (cleanText) {
          // Check if we already have this text as the last assistant message
          const lastMsg = ps.sessionState.messages[ps.sessionState.messages.length - 1]
          if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.content !== cleanText) {
            // If the last message is an assistant message being streamed, update it
            if (lastMsg?.role === 'assistant' && !lastMsg.content && ps.sessionState.isStreaming) {
              lastMsg.content = cleanText
            } else if (!msg.parentToolUseId) {
              ps.sessionState.messages.push({
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: 'assistant',
                content: cleanText,
                timestamp: Date.now(),
              })
            }
          }
        }
        ps.sessionState.streamingText = ''
        rerender()
        break
      }

      case 'thinking': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        ps.sessionState.streamingThinking = ''
        // Attach thinking to last assistant message or current streaming
        const lastMsg = ps.sessionState.messages[ps.sessionState.messages.length - 1]
        if (lastMsg?.role === 'assistant') {
          lastMsg.thinking = msg.thinking
        }
        rerender()
        break
      }

      case 'tool_use': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        // Append tool call to last assistant message or create one
        let lastMsg = ps.sessionState.messages[ps.sessionState.messages.length - 1]
        if (!lastMsg || lastMsg.role !== 'assistant') {
          lastMsg = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            content: '',
            toolCalls: [],
            timestamp: Date.now(),
          }
          ps.sessionState.messages.push(lastMsg)
        }
        if (!lastMsg.toolCalls) lastMsg.toolCalls = []
        lastMsg.toolCalls.push({
          name: msg.toolName,
          id: msg.toolId,
          input: msg.input,
        })
        rerender()
        break
      }

      case 'tool_result': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        // Find tool call and attach result
        for (let i = ps.sessionState.messages.length - 1; i >= 0; i--) {
          const m = ps.sessionState.messages[i]
          if (m.toolCalls) {
            const tc = m.toolCalls.find(t => t.id === msg.toolId)
            if (tc) {
              tc.result = msg.content
              tc.isError = msg.isError
              break
            }
          }
        }
        rerender()
        break
      }

      case 'result': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionState.isStreaming = false
        ps.sessionState.streamingText = ''
        ps.sessionState.streamingThinking = ''
        rerender()
        break
      }

      case 'query_end': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.isRunning = false
        ps.activityHeartbeat = null
        // Track background tasks
        if (msg.hasBackgroundTasks && msg.backgroundTaskIds) {
          for (const taskId of msg.backgroundTaskIds) {
            if (!ps.backgroundTasks.has(taskId)) {
              ps.backgroundTasks.set(taskId, { taskId, status: 'started' })
            }
          }
        }
        rerender()
        break
      }

      case 'query_summary': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionState.summary = msg.summary
        rerender()
        break
      }

      case 'query_suggestions': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionState.suggestions = msg.suggestions
        rerender()
        break
      }

      case 'session_created': {
        if (!projectId || !sessionId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionId = sessionId
        ps.sessionState = createEmptySessionState()
        rerender()
        break
      }

      case 'session_resumed': {
        if (!projectId || !sessionId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionId = sessionId
        ps.currentProvider = msg.providerId || null
        // Don't clear messages — we'll fetch history via REST
        rerender()
        break
      }

      case 'session_status_changed': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (msg.status === 'processing') {
          ps.isRunning = true
        } else {
          ps.isRunning = false
        }
        rerender()
        break
      }

      case 'permission_mode_changed': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.permissionMode = (msg.mode as 'bypassPermissions' | 'default') || 'default'
        rerender()
        break
      }

      case 'provider_changed': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.currentProvider = msg.providerId || null
        if (sessionId) {
          ps.sessionId = sessionId
          ps.sessionState = createEmptySessionState()
        }
        rerender()
        break
      }

      case 'ask_user_question': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.pendingQuestion = {
          toolId: (msg as any).toolId,
          questions: (msg as any).questions,
        }
        rerender()
        break
      }

      case 'permission_request': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.pendingPermission = {
          requestId: msg.requestId,
          toolName: msg.toolName,
          input: msg.input,
          reason: msg.reason,
        }
        rerender()
        break
      }

      case 'activity_heartbeat': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.activityHeartbeat = {
          queryId: msg.queryId,
          elapsedMs: msg.elapsedMs,
          lastActivityType: msg.lastActivityType,
          lastToolName: msg.lastToolName,
          textSnippet: msg.textSnippet,
          paused: msg.paused,
        }
        rerender()
        break
      }

      case 'session_usage': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionUsage = {
          totalInputTokens: msg.totalInputTokens,
          totalOutputTokens: msg.totalOutputTokens,
          totalCacheReadTokens: msg.totalCacheReadTokens,
          totalCacheCreateTokens: msg.totalCacheCreateTokens,
          totalCostUsd: msg.totalCostUsd,
          totalDurationMs: msg.totalDurationMs,
          queryCount: msg.queryCount,
          contextWindowUsed: msg.contextWindowUsed,
          contextWindowMax: msg.contextWindowMax,
        }
        rerender()
        break
      }

      case 'project_statuses': {
        setProjectStatuses(msg.statuses)
        break
      }

      case 'query_queue_status': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        const existing = ps.queryQueue.findIndex(q => q.queryId === msg.queryId)
        const item: QueueItem = {
          queryId: msg.queryId,
          status: msg.status,
          position: msg.position ?? 0,
          prompt: msg.prompt ?? '',
          queryType: msg.queryType ?? 'user',
          sessionId: sessionId ?? undefined,
          cronJobName: msg.cronJobName,
        }
        if (msg.status === 'completed' || msg.status === 'failed' || msg.status === 'timeout' || msg.status === 'cancelled') {
          if (existing >= 0) ps.queryQueue.splice(existing, 1)
        } else if (existing >= 0) {
          ps.queryQueue[existing] = item
        } else {
          ps.queryQueue.push(item)
        }
        rerender()
        break
      }

      case 'query_queue_snapshot': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.queryQueue = (msg as any).items ?? []
        rerender()
        break
      }

      case 'sdk_event': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        if (sessionId && ps.sessionId && sessionId !== ps.sessionId) break
        ps.sessionState.sdkEvents.push(msg.event)
        rerender()
        break
      }

      case 'background_task_update': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        const btMsg = msg as any
        ps.backgroundTasks.set(btMsg.taskId, {
          taskId: btMsg.taskId,
          status: btMsg.status,
          description: btMsg.description,
          summary: btMsg.summary,
          usage: btMsg.usage,
        })
        rerender()
        break
      }

      case 'user_message': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        // Only add if not already present (the sending client adds it optimistically)
        const msgs = ps.sessionState.messages
        const lastUserMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (!lastUserMsg || lastUserMsg.role !== 'user' || lastUserMsg.content !== msg.message.content) {
          msgs.push(msg.message)
          rerender()
        }
        break
      }

      case 'error': {
        if (!projectId) break
        const ps = getOrCreateProjectState(projectId)
        ps.sessionState.messages.push({
          id: `err-${Date.now()}`,
          role: 'system',
          content: msg.message,
          timestamp: Date.now(),
        })
        ps.isRunning = false
        ps.sessionState.isStreaming = false
        rerender()
        break
      }
    }
  }, [getOrCreateProjectState, rerender])

  // Connect WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const url = getWebSocketUrl(`/ws`)
    const urlObj = new URL(url)
    urlObj.searchParams.set('clientId', clientId.current)
    const ws = new WebSocket(urlObj.toString())

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onmessage = handleMessage

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      // Reconnect after delay
      reconnectTimeoutRef.current = setTimeout(connect, 2000)
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [handleMessage])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  // Actions
  const sendPrompt = useCallback((
    projectId: string,
    prompt: string,
    options?: {
      sessionId?: string
      images?: ImageAttachment[]
      providerId?: string
      enabledMcps?: string[]
      soulEnabled?: boolean
    },
  ) => {
    const ps = getOrCreateProjectState(projectId)
    // Add user message immediately
    ps.sessionState.messages.push({
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt,
      images: options?.images,
      timestamp: Date.now(),
    })
    ps.sessionState.suggestions = []
    rerender()

    send({
      type: 'prompt',
      projectId,
      sessionId: options?.sessionId ?? ps.sessionId ?? undefined,
      prompt,
      images: options?.images,
      providerId: options?.providerId,
      enabledMcps: options?.enabledMcps,
      soulEnabled: options?.soulEnabled,
    })
  }, [send, getOrCreateProjectState, rerender])

  const abort = useCallback((projectId: string) => {
    const ps = getOrCreateProjectState(projectId)
    ps.isAborting = true
    rerender()
    send({ type: 'abort', projectId })
  }, [send, getOrCreateProjectState, rerender])

  const switchProject = useCallback((projectId: string) => {
    send({ type: 'switch_project', projectId })
  }, [send])

  const newSession = useCallback((projectId: string) => {
    const ps = getOrCreateProjectState(projectId)
    ps.sessionId = null
    ps.currentProvider = null
    ps.sessionState = createEmptySessionState()
    ps.sessionUsage = null
    ps.activityHeartbeat = null
    ps.pendingPermission = null
    ps.pendingQuestion = null
    ps.queryQueue = []
    rerender()
    send({ type: 'new_session', projectId })
  }, [getOrCreateProjectState, rerender, send])

  const resumeSession = useCallback((projectId: string, sessionId: string) => {
    const ps = getOrCreateProjectState(projectId)
    ps.sessionId = sessionId
    ps.sessionState = createEmptySessionState()
    rerender()
    send({ type: 'resume_session', projectId, sessionId })

    // Fetch history via REST
    authFetch(`/api/sessions/${sessionId}/history`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.messages?.length) return
        const ps = getOrCreateProjectState(projectId)
        // Only apply if still on the same session
        if (ps.sessionId !== sessionId) return
        ps.sessionState.messages = (data.messages as ChatMessage[]).map((m: ChatMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          thinking: m.thinking,
          toolCalls: m.toolCalls,
          images: m.images,
          timestamp: m.timestamp,
        }))
        rerender()
      })
      .catch(() => {})
  }, [send, getOrCreateProjectState, rerender])

  const setProvider = useCallback((projectId: string, providerConfigId: string) => {
    send({ type: 'set_provider', projectId, providerId: providerConfigId })
  }, [send])

  const setPermissionMode = useCallback((projectId: string, sessionId: string, mode: 'bypassPermissions' | 'default') => {
    send({ type: 'set_permission_mode', projectId, sessionId, mode })
  }, [send])

  const respondPermission = useCallback((sessionId: string, requestId: string, allow: boolean) => {
    send({ type: 'respond_permission', sessionId, requestId, allow })
  }, [send])

  const respondQuestion = useCallback((sessionId: string, toolId: string, answers: Record<string, string | string[]>) => {
    send({ type: 'respond_question', sessionId, toolId, answers })
  }, [send])

  const dequeue = useCallback((queryId: string) => {
    send({ type: 'dequeue', queryId })
  }, [send])

  const executeNow = useCallback((queryId: string) => {
    send({ type: 'execute_now', queryId })
  }, [send])

  const requestQueueSnapshot = useCallback((projectId: string) => {
    send({ type: 'request_queue_snapshot', projectId })
  }, [send])

  const probeSdk = useCallback((projectId: string) => {
    send({ type: 'probe_sdk', projectId })
  }, [send])

  return {
    connected,
    projectStatuses,
    getProjectState,
    sendPrompt,
    abort,
    switchProject,
    newSession,
    resumeSession,
    setProvider,
    setPermissionMode,
    respondPermission,
    respondQuestion,
    dequeue,
    executeNow,
    requestQueueSnapshot,
    probeSdk,
  }
}
