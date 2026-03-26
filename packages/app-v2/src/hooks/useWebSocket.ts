import { useCallback, useEffect, useRef } from 'react'
import type { ClientMessage, ImageAttachment, ServerMessage, ChatMessage } from '@codecrab/shared'
import { getWebSocketUrl, authFetch } from '@/lib/auth'
import { useStore } from '@/store/store'
import { dispatchMessage } from '@/store/handlers'

// Re-export types from store for backwards compatibility
export type {
  ChatMsg,
  SessionUsage,
  ActivityHeartbeat,
  QueueItem,
  PendingPermission,
  PendingQuestion,
  BackgroundTask,
} from '@/store/types'

export interface UseWebSocketReturn {
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
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const clientId = useRef(`client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

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
    dispatchMessage(msg, useStore.getState())
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    const url = getWebSocketUrl('/ws')
    const urlObj = new URL(url)
    urlObj.searchParams.set('clientId', clientId.current)
    const ws = new WebSocket(urlObj.toString())

    ws.onopen = () => useStore.getState().setConnected(true)
    ws.onmessage = handleMessage
    ws.onclose = () => {
      useStore.getState().setConnected(false)
      wsRef.current = null
      reconnectTimeoutRef.current = setTimeout(connect, 2000)
    }
    ws.onerror = () => ws.close()
    wsRef.current = ws
  }, [handleMessage])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  // ============ Actions ============

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
    const store = useStore.getState()
    const project = store.getOrCreateProject(projectId)
    const viewingSessionId = project.viewingSessionId

    store.updateProject(projectId, p => { p.promptPending = true })

    const existingSessionId = options?.sessionId ?? viewingSessionId ?? undefined

    let tempSessionId: string | undefined
    if (!existingSessionId) {
      tempSessionId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      store.setViewingSession(projectId, tempSessionId)
      store.getOrCreateSession(projectId, tempSessionId)
      store.updateSession(projectId, tempSessionId, s => { s.suggestions = [] })
      console.log(`[ws] new session: tempId=${tempSessionId}`)
    } else {
      console.log(`[ws] existing session: sessionId=${existingSessionId}`)
      store.updateSession(projectId, existingSessionId, s => { s.suggestions = [] })
    }

    send({
      type: 'prompt',
      projectId,
      sessionId: existingSessionId,
      tempSessionId,
      prompt,
      images: options?.images,
      providerId: options?.providerId,
      enabledMcps: options?.enabledMcps,
      soulEnabled: options?.soulEnabled,
    })
  }, [send])

  const abort = useCallback((projectId: string) => {
    useStore.getState().updateProject(projectId, p => { p.isAborting = true })
    send({ type: 'abort', projectId })
  }, [send])

  const switchProject = useCallback((projectId: string) => {
    send({ type: 'switch_project', projectId })
  }, [send])

  const newSession = useCallback((projectId: string) => {
    useStore.getState().resetViewingSession(projectId)
    send({ type: 'new_session', projectId })
  }, [send])

  const resumeSession = useCallback((projectId: string, sessionId: string) => {
    const store = useStore.getState()
    store.setViewingSession(projectId, sessionId)
    store.getOrCreateSession(projectId, sessionId)
    store.updateSession(projectId, sessionId, s => {
      s.messages = []
      s.sdkEvents = []
      s.streamingText = ''
      s.streamingThinking = ''
      s.isStreaming = false
      s.suggestions = []
      s.summary = ''
    })
    send({ type: 'resume_session', projectId, sessionId })

    // Fetch history via REST
    authFetch(`/api/sessions/${sessionId}/history`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.messages?.length) return
        const currentState = useStore.getState()
        const project = currentState.projects[projectId]
        if (project?.viewingSessionId !== sessionId) return
        currentState.updateSession(projectId, sessionId, s => {
          s.messages = (data.messages as ChatMessage[]).map((m: ChatMessage) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            toolCalls: m.toolCalls,
            images: m.images,
            timestamp: m.timestamp,
          }))
        })
      })
      .catch(() => {})
  }, [send])

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
