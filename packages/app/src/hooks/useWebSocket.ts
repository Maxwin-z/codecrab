// WebSocket hook — client-side connection and state management
// Single WS connection, per-project state cache, project switching is pure frontend state change
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  ClientMessage,
  DebugEvent,
  ImageAttachment,
  McpInfo,
  ModelInfo,
  PendingPermission,
  PermissionMode,
  ProjectStatus,
  Question,
  QueryQueueSnapshotItem,
  SdkMcpServer,
  SdkSkill,
  ServerMessage,
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

// Strip trailing [SUMMARY: ...] / [SUGGESTIONS: ...] tags (or their partial prefixes)
// from streaming text so they never flash on screen during streaming.
const HIDDEN_TAG_PREFIXES = ['\n[SUMMARY:', '\n[SUGGESTIONS:']

function getDisplayStreamingText(text: string): string {
  if (!text) return text

  // Complete tag start found — hide from there onwards
  for (const prefix of HIDDEN_TAG_PREFIXES) {
    const idx = text.lastIndexOf(prefix)
    if (idx >= 0) return text.slice(0, idx)
  }

  // Partial prefix at the very end (e.g. "\n[S" arriving char-by-char) — buffer it
  for (const pattern of HIDDEN_TAG_PREFIXES) {
    for (let len = pattern.length - 1; len >= 2; len--) {
      if (text.endsWith(pattern.slice(0, len))) {
        return text.slice(0, text.length - len)
      }
    }
  }

  return text
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

// Queue item for display in the UI
export interface QueueItem {
  queryId: string
  status: 'queued' | 'running'
  position: number
  prompt: string
  queryType: 'user' | 'cron'
  sessionId?: string
  cronJobName?: string
}

// Per-project cached state
interface ProjectChatState {
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  pendingQuestion: { toolId: string; questions: Question[] } | null
  pendingPermission: PendingPermission | null
  isRunning: boolean
  isAborting: boolean
  sessionId: string
  cwd: string
  latestSummary: string | null
  suggestions: string[]
  currentModel: string
  permissionMode: PermissionMode
  // SDK-reported MCP servers, skills, and tools (from init message)
  sdkMcpServers: SdkMcpServer[]
  sdkSkills: SdkSkill[]
  sdkTools: string[]
  // SDK events timeline
  sdkEvents: DebugEvent[]
  // Activity heartbeat from server
  activityHeartbeat: {
    elapsedMs: number
    lastActivityType: string
    lastToolName?: string
    paused?: boolean
  } | null
  // Query queue for this project
  queryQueue: QueueItem[]
}

function createEmptyProjectState(): ProjectChatState {
  return {
    messages: [],
    streamingText: '',
    streamingThinking: '',
    pendingQuestion: null,
    pendingPermission: null,
    isRunning: false,
    isAborting: false,
    sessionId: '',
    cwd: '',
    latestSummary: null,
    suggestions: [],
    currentModel: '',
    permissionMode: 'bypassPermissions',
    sdkMcpServers: [],
    sdkSkills: [],
    sdkTools: [],
    sdkEvents: [],
    activityHeartbeat: null,
    queryQueue: [],
  }
}

export interface UseWebSocketReturn {
  connected: boolean
  isRunning: boolean
  isAborting: boolean
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  latestSummary: string | null
  suggestions: string[]
  pendingQuestion: { toolId: string; questions: Question[] } | null
  pendingPermission: PendingPermission | null
  cwd: string
  availableModels: ModelInfo[]
  currentModel: string
  permissionMode: PermissionMode
  sessionId: string
  projectStatuses: ProjectStatus[]
  sdkMcpServers: SdkMcpServer[]
  sdkSkills: SdkSkill[]
  sdkTools: string[]
  sdkEvents: DebugEvent[]
  activityHeartbeat: ProjectChatState['activityHeartbeat']
  queryQueue: QueueItem[]
  sdkLoaded: boolean
  probeSdk: () => void
  sendPrompt: (prompt: string, images?: ImageAttachment[], enabledMcps?: string[], disabledSdkServers?: string[], disabledSkills?: string[]) => void
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
  dequeueQuery: (queryId: string) => void
  fetchSessions: () => Promise<import('@codeclaws/shared').SessionInfo[]>
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const clientIdRef = useRef(getOrCreateClientId())

  // Connection state (global, not per-project)
  const [connected, setConnected] = useState(false)
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([])

  // Active project ID
  const activeProjectIdRef = useRef<string | null>(null)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // Per-project state cache
  const projectStatesRef = useRef(new Map<string, ProjectChatState>())

  // Re-render trigger: increment when active project's state changes
  const [, setStateVersion] = useState(0)
  const triggerRender = useCallback(() => setStateVersion((v) => v + 1), [])

  // Get or create state for a project
  const getProjectState = useCallback((projectId: string): ProjectChatState => {
    let state = projectStatesRef.current.get(projectId)
    if (!state) {
      state = createEmptyProjectState()
      projectStatesRef.current.set(projectId, state)
    }
    return state
  }, [])

  // Get active project state (returns empty state if no active project)
  const getActiveState = useCallback((): ProjectChatState => {
    const pid = activeProjectIdRef.current
    if (!pid) return createEmptyProjectState()
    return getProjectState(pid)
  }, [getProjectState])

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const clientId = clientIdRef.current
    const token = getToken()
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?clientId=${clientId}${tokenParam}`)
    wsRef.current = ws

    // Flag to prevent reconnection when closed intentionally (e.g. by React StrictMode cleanup)
    let closedIntentionally = false

    ws.onopen = () => {
      setConnected(true)
      // Re-subscribe to active project on reconnect
      const pid = activeProjectIdRef.current
      if (pid) {
        const sub = projectStatesRef.current.get(pid)
        ws.send(JSON.stringify({
          type: 'switch_project',
          projectId: pid,
          projectCwd: sub?.cwd || undefined,
        }))
      }
    }

    ws.onclose = () => {
      setConnected(false)
      // Only reconnect if the close was NOT intentional (e.g. server disconnect, not cleanup)
      if (!closedIntentionally) {
        setTimeout(connect, 2000)
      }
    }

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data)

      // Global messages (no projectId routing)
      switch (msg.type) {
        case 'available_models':
          if (msg.models && msg.models.length > 0) setAvailableModels(msg.models)
          return
        case 'project_statuses':
          setProjectStatuses(msg.statuses)
          return
      }

      // Project-scoped messages: route to per-project state
      const msgProjectId = (msg as any).projectId as string | undefined
      if (!msgProjectId) return // Ignore messages without projectId

      const pState = getProjectState(msgProjectId)
      const isActiveProject = msgProjectId === activeProjectIdRef.current

      switch (msg.type) {
        case 'query_start':
          pState.isRunning = true
          pState.latestSummary = null
          pState.suggestions = []
          pState.sdkEvents = []
          pState.activityHeartbeat = null
          if (isActiveProject) emitQueryStateChange(true)
          break

        case 'query_end':
          pState.isRunning = false
          pState.isAborting = false
          pState.activityHeartbeat = null
          if (isActiveProject) emitQueryStateChange(false)

          // Flush remaining streaming text into a message
          if (pState.streamingText || pState.streamingThinking) {
            const cleaned = (pState.streamingText || '').replace(/\n?\[SUGGESTIONS:\s*.+?\]\s*$/, '').replace(/\n?\[SUMMARY:\s*.+?\]\s*$/, '').trimEnd()
            if (cleaned || pState.streamingThinking) {
              // Check if last message is an assistant message we can attach thinking to
              const lastMsg = pState.messages[pState.messages.length - 1]
              if (pState.streamingThinking && lastMsg?.role === 'assistant' && !cleaned) {
                // Attach thinking to existing assistant message
                pState.messages = [
                  ...pState.messages.slice(0, -1),
                  { ...lastMsg, thinking: (lastMsg.thinking || '') + pState.streamingThinking },
                ]
              } else if (cleaned) {
                pState.messages = [
                  ...pState.messages,
                  { id: genId(), role: 'assistant', content: cleaned, thinking: pState.streamingThinking || undefined, timestamp: Date.now() },
                ]
              }
            }
            pState.streamingText = ''
          }
          pState.streamingThinking = ''
          break

        case 'query_summary':
          pState.latestSummary = msg.summary
          break

        case 'query_suggestions':
          pState.suggestions = msg.suggestions || []
          break

        case 'stream_delta':
          if (msg.deltaType === 'text') {
            pState.streamingText += msg.text
          } else if (msg.deltaType === 'thinking') {
            pState.streamingThinking += msg.text
          }
          break

        case 'assistant_text': {
          const thinkingToSave = pState.streamingThinking || undefined
          pState.streamingText = ''
          pState.streamingThinking = ''
          const cleanedText = msg.text.replace(/\n?\[SUGGESTIONS:\s*.+?\]\s*$/, '').replace(/\n?\[SUMMARY:\s*.+?\]\s*$/, '').trimEnd()
          pState.messages = [
            ...pState.messages,
            {
              id: genId(),
              role: 'assistant',
              content: cleanedText,
              thinking: thinkingToSave,
              parentToolUseId: msg.parentToolUseId ?? undefined,
              timestamp: Date.now(),
            },
          ]
          break
        }

        case 'thinking':
          pState.messages = (() => {
            const msgs = pState.messages
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant') {
              return [...msgs.slice(0, -1), { ...last, thinking: (last.thinking || '') + msg.thinking }]
            }
            return [
              ...msgs,
              { id: genId(), role: 'assistant', content: '', thinking: msg.thinking, timestamp: Date.now() },
            ]
          })()
          break

        case 'tool_use':
          if (pState.streamingText) {
            pState.messages = [
              ...pState.messages,
              { id: genId(), role: 'assistant', content: pState.streamingText, thinking: pState.streamingThinking || undefined, timestamp: Date.now() },
            ]
            pState.streamingText = ''
            pState.streamingThinking = ''
          }
          pState.messages = [
            ...pState.messages,
            {
              id: genId(),
              role: 'system',
              content: '',
              toolCalls: [{ name: msg.toolName, id: msg.toolId, input: msg.input }],
              timestamp: Date.now(),
            },
          ]
          break

        case 'tool_result':
          pState.messages = (() => {
            const msgs = [...pState.messages]
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i]
              if (m.toolCalls?.some((tc) => tc.id === msg.toolId)) {
                const updated = { ...m }
                updated.toolCalls = m.toolCalls!.map((tc) =>
                  tc.id === msg.toolId ? { ...tc, result: msg.content, isError: msg.isError } : tc
                )
                msgs[i] = updated
                return msgs
              }
            }
            return msgs
          })()
          break

        case 'result':
          if (msg.isError) {
            pState.messages = [
              ...pState.messages,
              {
                id: genId(),
                role: 'system',
                content: `Error: ${msg.result}`,
                timestamp: Date.now(),
              },
            ]
          }
          break

        case 'aborted':
          pState.isAborting = false
          break

        case 'cleared':
          pState.messages = []
          pState.streamingText = ''
          pState.streamingThinking = ''
          pState.sdkEvents = []
          break

        case 'cwd_changed':
          pState.cwd = msg.cwd
          break

        case 'error':
          pState.messages = [
            ...pState.messages,
            { id: genId(), role: 'system', content: `Error: ${msg.message}`, timestamp: Date.now() },
          ]
          pState.isRunning = false
          break

        case 'session_resumed':
          if (msg.sessionId) {
            pState.sessionId = msg.sessionId
          }
          break

        case 'message_history': {
          // Convert summaries to ChatMessages, preserving tool call info
          pState.messages = msg.messages.map((summary: any) => {
            const base: ChatMessage = {
              id: summary.id,
              role: summary.role,
              content: summary.content,
              timestamp: summary.timestamp,
            }
            if (summary.costUsd != null) base.costUsd = summary.costUsd
            if (summary.durationMs != null) base.durationMs = summary.durationMs
            if (summary.toolCalls?.length) {
              base.toolCalls = summary.toolCalls.map((tc: any) => ({
                name: tc.name,
                id: tc.id,
                input: tc.inputSummary || '',
                result: tc.resultPreview,
                isError: tc.isError,
              }))
            }
            return base
          })
          break
        }

        case 'user_message':
          pState.messages = (() => {
            const msgs = pState.messages
            const isDuplicate = msgs.some(
              (m) =>
                m.role === 'user' && m.content === msg.message.content && Date.now() - m.timestamp < 5000
            )
            if (isDuplicate) return msgs
            return [...msgs, msg.message]
          })()
          break

        case 'ask_user_question':
          pState.pendingQuestion = {
            toolId: msg.toolId,
            questions: msg.questions,
          }
          break

        case 'session_status_changed':
          if (msg.sessionId) {
            emitSessionStatusChanged({ sessionId: msg.sessionId, status: msg.status })
          }
          break

        case 'model_changed':
          if (msg.model) pState.currentModel = msg.model
          break

        case 'permission_mode_changed':
          pState.permissionMode = msg.mode as PermissionMode
          break

        case 'permission_request':
          pState.pendingPermission = {
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            reason: msg.reason,
          }
          break

        case 'system':
          if (msg.subtype === 'init') {
            if (msg.model) pState.currentModel = msg.model
            if (msg.sessionId) pState.sessionId = msg.sessionId
            if (msg.sdkMcpServers) pState.sdkMcpServers = msg.sdkMcpServers
            if (msg.sdkSkills) pState.sdkSkills = msg.sdkSkills
            if (msg.tools) pState.sdkTools = msg.tools
          }
          break

        case 'activity_heartbeat':
          pState.activityHeartbeat = {
            elapsedMs: msg.elapsedMs,
            lastActivityType: msg.lastActivityType,
            lastToolName: msg.lastToolName,
            paused: msg.paused,
          }
          break

        case 'sdk_event':
          if ((msg as any).event) {
            pState.sdkEvents = [...pState.sdkEvents, (msg as any).event]
          }
          break

        case 'sdk_event_history':
          if ((msg as any).events) {
            pState.sdkEvents = (msg as any).events
          }
          break

        case 'cron_task_completed': {
          const cronMsg = msg as any
          const cronEvent: DebugEvent = {
            ts: Date.now(),
            type: 'cron_task_completed',
            detail: cronMsg.cronJobName || cronMsg.cronJobId || 'Task',
            data: {
              cronJobId: cronMsg.cronJobId,
              cronJobName: cronMsg.cronJobName,
              parentSessionId: cronMsg.parentSessionId,
              execSessionId: cronMsg.execSessionId,
              success: cronMsg.success,
            },
          }
          pState.sdkEvents = [...pState.sdkEvents, cronEvent]
          break
        }

        case 'query_queue_status': {
          const qs = msg as any
          const terminalStatuses = ['completed', 'failed', 'timeout', 'cancelled']
          if (terminalStatuses.includes(qs.status)) {
            // Remove from queue
            pState.queryQueue = pState.queryQueue.filter((q) => q.queryId !== qs.queryId)
          } else {
            // Add or update
            const existing = pState.queryQueue.find((q) => q.queryId === qs.queryId)
            if (existing) {
              existing.status = qs.status
              existing.position = qs.position ?? existing.position
              if (qs.prompt) existing.prompt = qs.prompt
              pState.queryQueue = [...pState.queryQueue]
            } else if (qs.prompt) {
              pState.queryQueue = [...pState.queryQueue, {
                queryId: qs.queryId,
                status: qs.status,
                position: qs.position ?? 0,
                prompt: qs.prompt,
                queryType: qs.queryType || 'user',
                sessionId: qs.sessionId,
                cronJobName: qs.cronJobName,
              }]
            }
            // Sort by position
            pState.queryQueue.sort((a, b) => a.position - b.position)
          }
          break
        }

        case 'query_queue_snapshot': {
          const snap = msg as any
          pState.queryQueue = (snap.items || []).map((item: any) => ({
            queryId: item.queryId,
            status: item.status,
            position: item.position,
            prompt: item.prompt,
            queryType: item.queryType || 'user',
            sessionId: item.sessionId,
            cronJobName: item.cronJobName,
          }))
          break
        }
      }

      // Trigger re-render if this message is for the active project
      if (isActiveProject) {
        triggerRender()
      }
    }

    // Return a cleanup function that marks the close as intentional
    return () => {
      closedIntentionally = true
      ws.close()
    }
  }, [getProjectState, triggerRender])

  useEffect(() => {
    const cleanup = connect()
    return cleanup
  }, [connect])

  // Send helper: stamps projectId + sessionId on outgoing messages
  const sendWithProject = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const pid = activeProjectIdRef.current
    if (!pid) return
    const pState = projectStatesRef.current.get(pid)
    ws.send(JSON.stringify({
      projectId: pid,
      sessionId: pState?.sessionId || undefined,
      ...msg,
    }))
  }, [])

  const sendPrompt = useCallback((prompt: string, images?: ImageAttachment[], enabledMcps?: string[], disabledSdkServers?: string[], disabledSkills?: string[]) => {
    const pid = activeProjectIdRef.current
    if (!pid) return
    const pState = getProjectState(pid)

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: prompt,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    }
    pState.messages = [...pState.messages, userMsg]
    triggerRender()

    sendWithProject({
      type: 'prompt',
      prompt,
      ...(images?.length ? { images } : {}),
      ...(enabledMcps ? { enabledMcps } : {}),
      ...(disabledSdkServers?.length ? { disabledSdkServers } : {}),
      ...(disabledSkills?.length ? { disabledSkills } : {}),
    })
  }, [getProjectState, sendWithProject, triggerRender])

  const sendCommand = useCallback((command: string) => {
    if (!command.match(/^\/(clear|switch\s)/)) {
      const pid = activeProjectIdRef.current
      if (pid) {
        const pState = getProjectState(pid)
        const userMsg: ChatMessage = {
          id: genId(),
          role: 'user',
          content: command,
          timestamp: Date.now(),
        }
        pState.messages = [...pState.messages, userMsg]
        triggerRender()
      }
    }
    sendWithProject({ type: 'command', command })
  }, [getProjectState, sendWithProject, triggerRender])

  const abort = useCallback(() => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.isAborting = true
      triggerRender()
    }
    sendWithProject({ type: 'abort' })
  }, [getProjectState, sendWithProject, triggerRender])

  const setWorkingDir = useCallback((dir: string) => {
    sendWithProject({ type: 'set_cwd', cwd: dir })
  }, [sendWithProject])

  const setProjectId = useCallback((projectId: string | null, projectCwd?: string) => {
    const prevProjectId = activeProjectIdRef.current
    if (projectId === prevProjectId) return

    activeProjectIdRef.current = projectId
    setActiveProjectId(projectId)

    // Send switch_project to server (if we have a project and are connected)
    if (projectId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'switch_project',
        projectId,
        projectCwd: projectCwd || undefined,
      }))
    }

    // If we have a project, ensure we have a state entry for it
    if (projectId) {
      const pState = getProjectState(projectId)
      if (projectCwd && !pState.cwd) {
        pState.cwd = projectCwd
      }
    }

    triggerRender()
  }, [getProjectState, triggerRender])

  const clearMessages = useCallback(() => {
    sendWithProject({ type: 'command', command: '/clear' })
  }, [sendWithProject])

  const resumeSession = useCallback((sessionId: string) => {
    const pid = activeProjectIdRef.current
    if (!pid) return
    const pState = getProjectState(pid)
    pState.messages = []
    pState.streamingText = ''
    pState.streamingThinking = ''
    triggerRender()
    sendWithProject({ type: 'resume_session', sessionId })
  }, [getProjectState, sendWithProject, triggerRender])

  const newChat = useCallback(() => {
    sendWithProject({ type: 'command', command: '/clear' })
  }, [sendWithProject])

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
      const pid = activeProjectIdRef.current
      if (pid) {
        const pState = getProjectState(pid)
        pState.pendingQuestion = null
        triggerRender()
      }
    },
    [sendPrompt, getProjectState, triggerRender]
  )

  const dismissQuestion = useCallback(() => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.pendingQuestion = null
      triggerRender()
    }
  }, [getProjectState, triggerRender])

  const setModel = useCallback((model: string) => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.currentModel = model
      triggerRender()
    }
    sendWithProject({ type: 'set_model', model })
  }, [getProjectState, sendWithProject, triggerRender])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.permissionMode = mode
      triggerRender()
    }
    sendWithProject({ type: 'set_permission_mode', mode })
  }, [getProjectState, sendWithProject, triggerRender])

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.pendingPermission = null
      triggerRender()
    }
    sendWithProject({ type: 'respond_permission', requestId, allow })
  }, [getProjectState, sendWithProject, triggerRender])

  const dequeueQuery = useCallback((queryId: string) => {
    sendWithProject({ type: 'dequeue', queryId })
  }, [sendWithProject])

  const probeSdk = useCallback(() => {
    sendWithProject({ type: 'probe_sdk' })
  }, [sendWithProject])

  const fetchSessions = useCallback(async (): Promise<import('@codeclaws/shared').SessionInfo[]> => {
    try {
      const params = new URLSearchParams()
      const pid = activeProjectIdRef.current
      if (pid) {
        params.set('projectId', pid)
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
  }, [])

  // Read active project's state for the return value
  const activeState = getActiveState()

  return {
    connected,
    isRunning: activeState.isRunning,
    isAborting: activeState.isAborting,
    messages: activeState.messages,
    streamingText: getDisplayStreamingText(activeState.streamingText),
    streamingThinking: activeState.streamingThinking,
    latestSummary: activeState.latestSummary,
    suggestions: activeState.suggestions,
    pendingQuestion: activeState.pendingQuestion,
    pendingPermission: activeState.pendingPermission,
    cwd: activeState.cwd,
    availableModels,
    currentModel: activeState.currentModel,
    permissionMode: activeState.permissionMode,
    sessionId: activeState.sessionId,
    projectStatuses,
    activityHeartbeat: activeState.activityHeartbeat,
    queryQueue: activeState.queryQueue,
    sdkMcpServers: activeState.sdkMcpServers,
    sdkSkills: activeState.sdkSkills,
    sdkTools: activeState.sdkTools,
    sdkEvents: activeState.sdkEvents,
    sdkLoaded: activeState.sdkTools.length > 0,
    probeSdk,
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
    dequeueQuery,
    fetchSessions,
  }
}
