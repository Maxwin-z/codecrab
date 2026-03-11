// WebSocket hook — client-side connection and state management
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  ClientMessage,
  ModelInfo,
  PendingPermission,
  PermissionMode,
  ProjectStatus,
  Question,
  ServerMessage,
  SessionInfo,
} from '@codeclaws/shared'
import { getToken, authFetch } from '@/lib/auth'

const STORAGE_KEY_CLIENT_ID = 'codeclaws_client_id'

let msgIdCounter = 0
function genId(): string {
  return `msg-${Date.now()}-${++msgIdCounter}`
}

function getOrCreateClientId(): string {
  let id = localStorage.getItem(STORAGE_KEY_CLIENT_ID)
  if (!id) {
    id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(STORAGE_KEY_CLIENT_ID, id)
  }
  return id
}

// Module-level event emitters for cross-component communication
type QueryStateCallback = (isRunning: boolean) => void
const queryStateListeners = new Set<QueryStateCallback>()

export function onQueryStateChange(callback: QueryStateCallback): () => void {
  queryStateListeners.add(callback)
  return () => queryStateListeners.delete(callback)
}

function emitQueryStateChange(isRunning: boolean) {
  for (const cb of queryStateListeners) cb(isRunning)
}

export interface SessionStatusEvent {
  sessionId: string
  status: 'idle' | 'processing' | 'error'
}

type SessionStatusCallback = (event: SessionStatusEvent) => void
const sessionStatusListeners = new Set<SessionStatusCallback>()

export function onSessionStatusChanged(callback: SessionStatusCallback): () => void {
  sessionStatusListeners.add(callback)
  return () => sessionStatusListeners.delete(callback)
}

function emitSessionStatusChanged(event: SessionStatusEvent) {
  for (const cb of sessionStatusListeners) cb(event)
}

export interface UseWebSocketReturn {
  connected: boolean
  isRunning: boolean
  isAborting: boolean
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  latestSummary: string | null
  pendingQuestion: { toolId: string; questions: Question[] } | null
  pendingPermission: PendingPermission | null
  cwd: string
  availableModels: ModelInfo[]
  currentModel: string
  permissionMode: PermissionMode
  sessionId: string
  projectStatuses: ProjectStatus[]
  sendPrompt: (prompt: string) => void
  sendCommand: (command: string) => void
  abort: () => void
  setWorkingDir: (dir: string) => void
  setProjectId: (projectId: string | null, projectCwd?: string) => void
  clearMessages: () => void
  resumeSession: (sessionId: string) => void
  newChat: () => void
  submitQuestionResponse: (answers: Record<string, string | string[]>) => void
  dismissQuestion: () => void
  setModel: (model: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  respondToPermission: (requestId: string, allow: boolean) => void
  fetchSessions: () => Promise<SessionInfo[]>
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const clientIdRef = useRef(getOrCreateClientId())
  const [connected, setConnected] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cwd, setCwd] = useState<string>('')
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<{ toolId: string; questions: Question[] } | null>(null)
  const [latestSummary, setLatestSummary] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>('default')
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([])

  const projectIdRef = useRef<string | null>(null)
  const pendingCwdRef = useRef<string | null>(null)

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const clientId = clientIdRef.current
    const projectId = projectIdRef.current
    const token = getToken()
    const projectIdParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?clientId=${clientId}${projectIdParam}${tokenParam}`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // Send pending cwd if we reconnected after a project switch
      if (pendingCwdRef.current) {
        ws.send(JSON.stringify({ type: 'set_cwd', cwd: pendingCwdRef.current }))
        pendingCwdRef.current = null
      }
    }

    ws.onclose = () => {
      setConnected(false)
      // Reconnect after 2s
      setTimeout(connect, 2000)
    }

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data)

      switch (msg.type) {
        case 'query_start':
          setIsRunning(true)
          emitQueryStateChange(true)
          setStreamingText('')
          setStreamingThinking('')
          setLatestSummary(null)
          break

        case 'query_end':
          setIsRunning(false)
          setIsAborting(false)
          emitQueryStateChange(false)

          // Flush any remaining streaming text into a message
          setStreamingText((prev) => {
            if (prev) {
              const cleaned = prev.replace(/\n?\[SUMMARY:\s*.+?\]\s*$/, '').trimEnd()
              if (cleaned) {
                setMessages((msgs) => [
                  ...msgs,
                  { id: genId(), role: 'assistant', content: cleaned, timestamp: Date.now() },
                ])
              }
            }
            return ''
          })
          setStreamingThinking('')
          break

        case 'query_summary':
          setLatestSummary(msg.summary)
          break

        case 'stream_delta':
          if (msg.deltaType === 'text') {
            setStreamingText((prev) => prev + msg.text)
          } else if (msg.deltaType === 'thinking') {
            setStreamingThinking((prev) => prev + msg.text)
          }
          break

        case 'assistant_text': {
          setStreamingText('')
          setStreamingThinking('')
          const cleanedText = msg.text.replace(/\n?\[SUMMARY:\s*.+?\]\s*$/, '').trimEnd()
          setMessages((msgs) => [
            ...msgs,
            {
              id: genId(),
              role: 'assistant',
              content: cleanedText,
              parentToolUseId: msg.parentToolUseId ?? undefined,
              timestamp: Date.now(),
            },
          ])
          break
        }

        case 'thinking':
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant') {
              return [...msgs.slice(0, -1), { ...last, thinking: (last.thinking || '') + msg.thinking }]
            }
            return [
              ...msgs,
              { id: genId(), role: 'assistant', content: '', thinking: msg.thinking, timestamp: Date.now() },
            ]
          })
          break

        case 'tool_use':
          setStreamingText((prev) => {
            if (prev) {
              setMessages((msgs) => [
                ...msgs,
                { id: genId(), role: 'assistant', content: prev, timestamp: Date.now() },
              ])
            }
            return ''
          })
          setMessages((msgs) => [
            ...msgs,
            {
              id: genId(),
              role: 'system',
              content: '',
              toolCalls: [{ name: msg.toolName, id: msg.toolId, input: msg.input }],
              timestamp: Date.now(),
            },
          ])
          break

        case 'tool_result':
          setMessages((msgs) => {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i]
              if (m.toolCalls?.some((tc) => tc.id === msg.toolId)) {
                const updated = { ...m }
                updated.toolCalls = m.toolCalls!.map((tc) =>
                  tc.id === msg.toolId ? { ...tc, result: msg.content, isError: msg.isError } : tc
                )
                return [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)]
              }
            }
            return msgs
          })
          break

        case 'result':
          if (msg.isError) {
            setMessages((msgs) => [
              ...msgs,
              {
                id: genId(),
                role: 'system',
                content: `Error: ${msg.result}`,
                timestamp: Date.now(),
              },
            ])
          }
          break

        case 'aborted':
          setIsAborting(false)
          break

        case 'cleared':
          setMessages([])
          setStreamingText('')
          setStreamingThinking('')
          break

        case 'cwd_changed':
          setCwd(msg.cwd)
          break

        case 'error':
          setMessages((msgs) => [
            ...msgs,
            { id: genId(), role: 'system', content: `Error: ${msg.message}`, timestamp: Date.now() },
          ])
          setIsRunning(false)
          break

        case 'session_resumed':
          setSessionId(msg.sessionId)
          setMessages((msgs) => [
            ...msgs,
            {
              id: genId(),
              role: 'system',
              content: `Resumed session: ${msg.sessionId.slice(-6)}`,
              timestamp: Date.now(),
            },
          ])
          break

        case 'message_history':
          setMessages(msg.messages)
          break

        case 'user_message':
          setMessages((msgs) => {
            const isDuplicate = msgs.some(
              (m) =>
                m.role === 'user' && m.content === msg.message.content && Date.now() - m.timestamp < 5000
            )
            if (isDuplicate) return msgs
            return [...msgs, msg.message]
          })
          break

        case 'ask_user_question':
          setPendingQuestion({
            toolId: msg.toolId,
            questions: msg.questions,
          })
          break

        case 'session_status_changed':
          emitSessionStatusChanged({ sessionId: msg.sessionId, status: msg.status })
          break

        case 'model_changed':
          if (msg.model) setCurrentModel(msg.model)
          break

        case 'available_models':
          if (msg.models && msg.models.length > 0) setAvailableModels(msg.models)
          break

        case 'permission_mode_changed':
          setPermissionModeState(msg.mode as PermissionMode)
          break

        case 'permission_request':
          setPendingPermission({
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            reason: msg.reason,
          })
          break

        case 'project_statuses':
          setProjectStatuses(msg.statuses)
          break

        case 'system':
          if (msg.subtype === 'init') {
            if (msg.model) setCurrentModel(msg.model)
            if (msg.sessionId) setSessionId(msg.sessionId)
          }
          break
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
    }
  }, [connect])

  const sendPrompt = useCallback((prompt: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }
    setMessages((msgs) => [...msgs, userMsg])
    const msg: ClientMessage = { type: 'prompt', prompt }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const sendCommand = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    if (!command.match(/^\/(clear|switch\s)/)) {
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: command,
        timestamp: Date.now(),
      }
      setMessages((msgs) => [...msgs, userMsg])
    }
    const msg: ClientMessage = { type: 'command', command }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const abort = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setIsAborting(true)
    const msg: ClientMessage = { type: 'abort' }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const setWorkingDir = useCallback((dir: string) => {
    const msg: ClientMessage = { type: 'set_cwd', cwd: dir }
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  const setProjectId = useCallback((projectId: string | null, projectCwd?: string) => {
    const prevProjectId = projectIdRef.current
    if (projectId === prevProjectId) return

    projectIdRef.current = projectId
    pendingCwdRef.current = projectCwd || null

    // Reset all state when switching projects
    setStreamingText('')
    setStreamingThinking('')
    setPendingQuestion(null)
    setPendingPermission(null)
    setMessages([])
    setIsRunning(false)
    setIsAborting(false)
    setSessionId('')
    setLatestSummary(null)

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
  }, [])

  const clearMessages = useCallback(() => {
    const msg: ClientMessage = { type: 'command', command: '/clear' }
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  const resumeSession = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setMessages([])
    setStreamingText('')
    setStreamingThinking('')
    const msg: ClientMessage = { type: 'resume_session', sessionId }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const newChat = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'command', command: '/clear' }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const submitQuestionResponse = useCallback(
    (answers: Record<string, string | string[]>) => {
      const answerText = Object.entries(answers)
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            return `${key}: ${value.join(', ')}`
          }
          return `${key}: ${value}`
        })
        .join('\n')
      sendPrompt(answerText)
      setPendingQuestion(null)
    },
    [sendPrompt]
  )

  const dismissQuestion = useCallback(() => {
    setPendingQuestion(null)
  }, [])

  const setModel = useCallback((model: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'set_model', model }
    wsRef.current.send(JSON.stringify(msg))
    setCurrentModel(model)
  }, [])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'set_permission_mode', mode }
    wsRef.current.send(JSON.stringify(msg))
    setPermissionModeState(mode)
  }, [])

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'respond_permission', requestId, allow }
    wsRef.current.send(JSON.stringify(msg))
    setPendingPermission(null)
  }, [])

  const fetchSessions = useCallback(async (filterProjectId?: string): Promise<SessionInfo[]> => {
    try {
      const params = new URLSearchParams()
      if (filterProjectId) {
        params.set('projectId', filterProjectId)
      } else if (cwd) {
        params.set('cwd', cwd)
      }
      const query = params.toString()
      const url = query ? `/api/sessions?${query}` : '/api/sessions'
      const res = await authFetch(url)
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }, [cwd])

  return {
    connected,
    isRunning,
    isAborting,
    messages,
    streamingText,
    streamingThinking,
    latestSummary,
    pendingQuestion,
    pendingPermission,
    cwd,
    availableModels,
    currentModel,
    permissionMode,
    sessionId,
    projectStatuses,
    sendPrompt,
    sendCommand,
    abort,
    setWorkingDir,
    setProjectId,
    clearMessages,
    resumeSession,
    newChat,
    submitQuestionResponse,
    dismissQuestion,
    setModel,
    setPermissionMode,
    respondToPermission,
    fetchSessions,
  }
}
