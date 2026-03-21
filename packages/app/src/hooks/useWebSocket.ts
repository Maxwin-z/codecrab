// WebSocket hook — client-side connection and state management
// Single WS connection, per-project state cache with per-session message isolation
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
} from '@codecrab/shared'
import { getToken, authFetch } from '@/lib/auth'
import { buildWsUrl } from '@/lib/server'
import { stripMetaTags } from '@/lib/utils'

const STORAGE_KEY_CLIENT_ID = 'codecrab_client_id'

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

// Per-session state (messages, streaming, events are isolated per session)
interface SessionChatState {
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  sdkEvents: DebugEvent[]
  latestSummary: string | null
  suggestions: string[]
  pendingQuestion: { toolId: string; questions: Question[] } | null
}

function createEmptySessionState(): SessionChatState {
  return {
    messages: [],
    streamingText: '',
    streamingThinking: '',
    sdkEvents: [],
    latestSummary: null,
    suggestions: [],
    pendingQuestion: null,
  }
}

function getSessionState(pState: ProjectChatState, sessionId: string): SessionChatState {
  let sState = pState.sessionStates.get(sessionId)
  if (!sState) {
    sState = createEmptySessionState()
    pState.sessionStates.set(sessionId, sState)
  }
  return sState
}

// Per-project cached state
interface ProjectChatState {
  // Session management
  sessionId: string // The session the user is currently viewing (viewingSessionId)
  sessionStates: Map<string, SessionChatState> // Per-session state cache
  // True when we've sent switch_project or /clear and are waiting for the server
  // to tell us the new session ID. Prevents background query broadcasts from
  // overwriting the viewing session.
  awaitingSessionSwitch: boolean
  // Per-project state
  pendingPermission: PendingPermission | null
  isRunning: boolean
  isAborting: boolean
  cwd: string
  currentModel: string
  permissionMode: PermissionMode
  // SDK-reported MCP servers, skills, and tools (from init message)
  sdkMcpServers: SdkMcpServer[]
  sdkSkills: SdkSkill[]
  sdkTools: string[]
  // Activity heartbeat from server
  activityHeartbeat: {
    elapsedMs: number
    lastActivityType: string
    lastToolName?: string
    paused?: boolean
  } | null
  // Query queue for this project
  queryQueue: QueueItem[]
  // Session usage tracking
  sessionUsage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheCreateTokens: number
    totalCostUsd: number
    totalDurationMs: number
    queryCount: number
    contextWindowUsed: number
    contextWindowMax: number
  } | null
}

function createEmptyProjectState(): ProjectChatState {
  return {
    sessionId: '',
    sessionStates: new Map(),
    awaitingSessionSwitch: false,
    pendingPermission: null,
    isRunning: false,
    isAborting: false,
    cwd: '',
    currentModel: '',
    permissionMode: 'bypassPermissions',
    sdkMcpServers: [],
    sdkSkills: [],
    sdkTools: [],
    activityHeartbeat: null,
    queryQueue: [],
    sessionUsage: null,
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
  sessionUsage: ProjectChatState['sessionUsage']
  sdkLoaded: boolean
  probeSdk: () => void
  sendPrompt: (prompt: string, images?: ImageAttachment[], enabledMcps?: string[], disabledSdkServers?: string[], disabledSkills?: string[]) => void
  sendCommand: (command: string) => void
  abort: (queryId?: string) => void
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
  executeNow: (queryId: string) => void
  fetchSessions: () => Promise<import('@codecrab/shared').SessionInfo[]>
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

  // Parse a ChatMessageSummary from the server into a ChatMessage
  const parseSummaryToMessage = (summary: any): ChatMessage => {
    const base: ChatMessage = {
      id: summary.id,
      role: summary.role,
      content: stripMetaTags(summary.content || ''),
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
    if (summary.images?.length) {
      base.images = summary.images
    }
    return base
  }

  // Fetch session history via HTTP. Always does a full replace to avoid
  // duplication caused by client-generated IDs not matching server IDs.
  const fetchSessionHistoryRef = useRef(async (projectId: string, sessionId: string) => {
    try {
      const pState = getProjectState(projectId)
      const sState = getSessionState(pState, sessionId)

      const url = `/api/sessions/${encodeURIComponent(sessionId)}/history`
      const res = await authFetch(url)
      if (!res.ok) return
      const data = await res.json()

      if (data.messages?.length) {
        sState.messages = data.messages.map(parseSummaryToMessage)
        sState.streamingText = ''
        sState.streamingThinking = ''
      }

      if (data.sdkEvents?.length) {
        sState.sdkEvents = data.sdkEvents
      }

      // Summary and suggestions always reflect latest state
      if (data.summary) sState.latestSummary = data.summary
      if (data.suggestions) sState.suggestions = data.suggestions

      triggerRender()
    } catch (err) {
      console.error('[ws] Failed to fetch session history:', err)
    }
  })

  const connect = useCallback(() => {
    const clientId = clientIdRef.current
    const token = getToken()
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
    const ws = new WebSocket(`${buildWsUrl('/ws')}?clientId=${clientId}${tokenParam}`)
    wsRef.current = ws

    // Flag to prevent reconnection when closed intentionally (e.g. by React StrictMode cleanup)
    let closedIntentionally = false

    ws.onopen = () => {
      setConnected(true)
      // Re-subscribe to active project on reconnect
      const pid = activeProjectIdRef.current
      if (pid) {
        const sub = projectStatesRef.current.get(pid)
        if (sub) sub.awaitingSessionSwitch = true
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

      // Extract sessionId from the message for per-session routing
      const msgSessionId = (msg as any).sessionId as string | undefined

      // Helper: get session state for this message, falling back to viewing session
      const getTargetSession = (): { sState: SessionChatState; sid: string; isViewing: boolean } | null => {
        const sid = msgSessionId || pState.sessionId
        if (!sid) return null
        return { sState: getSessionState(pState, sid), sid, isViewing: sid === pState.sessionId }
      }

      // Track whether we need to re-render
      let needsRender = false

      switch (msg.type) {
        case 'query_start': {
          pState.isRunning = true
          pState.activityHeartbeat = null
          needsRender = true
          if (isActiveProject) emitQueryStateChange(true)
          // Clear summary/suggestions for the session that's starting a query
          const target = getTargetSession()
          if (target) {
            target.sState.latestSummary = null
            target.sState.suggestions = []
          }
          break
        }

        case 'query_end': {
          pState.isRunning = false
          pState.isAborting = false
          pState.activityHeartbeat = null
          needsRender = true
          if (isActiveProject) emitQueryStateChange(false)

          // Defensively remove the completed query from the queue.
          // query_queue_status(completed) should handle this, but query_end
          // serves as a backup to prevent stale queue items.
          const endQueryId = (msg as any).queryId
          if (endQueryId) {
            pState.queryQueue = pState.queryQueue.filter((q) => q.queryId !== endQueryId)
          }

          // Flush remaining streaming text into the correct session's messages
          const target = getTargetSession()
          if (target) {
            const { sState } = target
            if (sState.streamingText || sState.streamingThinking) {
              const cleaned = stripMetaTags(sState.streamingText || '')
              if (cleaned || sState.streamingThinking) {
                const lastMsg = sState.messages[sState.messages.length - 1]
                if (sState.streamingThinking && lastMsg?.role === 'assistant' && !cleaned) {
                  sState.messages = [
                    ...sState.messages.slice(0, -1),
                    { ...lastMsg, thinking: (lastMsg.thinking || '') + sState.streamingThinking },
                  ]
                } else if (cleaned) {
                  sState.messages = [
                    ...sState.messages,
                    { id: genId(), role: 'assistant', content: cleaned, thinking: sState.streamingThinking || undefined, timestamp: Date.now() },
                  ]
                }
              }
              sState.streamingText = ''
            }
            sState.streamingThinking = ''
          }
          break
        }

        case 'query_summary': {
          const target = getTargetSession()
          if (target) {
            target.sState.latestSummary = msg.summary
            if (target.isViewing) needsRender = true
          }
          break
        }

        case 'query_suggestions': {
          const target = getTargetSession()
          if (target) {
            target.sState.suggestions = msg.suggestions || []
            if (target.isViewing) needsRender = true
          }
          break
        }

        case 'stream_delta': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            if (msg.deltaType === 'text') {
              sState.streamingText += msg.text
            } else if (msg.deltaType === 'thinking') {
              sState.streamingThinking += msg.text
            }
            if (isViewing) needsRender = true
          }
          break
        }

        case 'assistant_text': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            const thinkingToSave = sState.streamingThinking || undefined
            sState.streamingText = ''
            sState.streamingThinking = ''
            const cleanedText = stripMetaTags(msg.text)
            sState.messages = [
              ...sState.messages,
              {
                id: genId(),
                role: 'assistant',
                content: cleanedText,
                thinking: thinkingToSave,
                parentToolUseId: msg.parentToolUseId ?? undefined,
                timestamp: Date.now(),
              },
            ]
            if (isViewing) needsRender = true
          }
          break
        }

        case 'thinking': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            sState.messages = (() => {
              const msgs = sState.messages
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant') {
                return [...msgs.slice(0, -1), { ...last, thinking: (last.thinking || '') + msg.thinking }]
              }
              return [
                ...msgs,
                { id: genId(), role: 'assistant', content: '', thinking: msg.thinking, timestamp: Date.now() },
              ]
            })()
            if (isViewing) needsRender = true
          }
          break
        }

        case 'tool_use': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            if (sState.streamingText) {
              sState.messages = [
                ...sState.messages,
                { id: genId(), role: 'assistant', content: sState.streamingText, thinking: sState.streamingThinking || undefined, timestamp: Date.now() },
              ]
              sState.streamingText = ''
              sState.streamingThinking = ''
            }
            sState.messages = [
              ...sState.messages,
              {
                id: genId(),
                role: 'system',
                content: '',
                toolCalls: [{ name: msg.toolName, id: msg.toolId, input: msg.input }],
                timestamp: Date.now(),
              },
            ]
            if (isViewing) needsRender = true
          }
          break
        }

        case 'tool_result': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            sState.messages = (() => {
              const msgs = [...sState.messages]
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
            if (isViewing) needsRender = true
          }
          break
        }

        case 'result': {
          if (msg.isError) {
            const target = getTargetSession()
            if (target) {
              const { sState, isViewing } = target
              sState.messages = [
                ...sState.messages,
                {
                  id: genId(),
                  role: 'system',
                  content: `Error: ${msg.result}`,
                  timestamp: Date.now(),
                },
              ]
              if (isViewing) needsRender = true
            }
          }
          break
        }

        case 'aborted':
          pState.isAborting = false
          needsRender = true
          break

        case 'cleared': {
          // Server creates a new session after /clear — clear the viewing session state.
          // The new session ID will arrive via system init.
          const sid = pState.sessionId
          if (sid) {
            pState.sessionStates.set(sid, createEmptySessionState())
          }
          pState.sessionUsage = null
          needsRender = true
          break
        }

        case 'cwd_changed':
          pState.cwd = msg.cwd
          needsRender = true
          break

        case 'error': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            sState.messages = [
              ...sState.messages,
              { id: genId(), role: 'system', content: `Error: ${msg.message}`, timestamp: Date.now() },
            ]
            if (isViewing) needsRender = true
          }
          pState.isRunning = false
          needsRender = true
          break
        }

        case 'session_resumed':
          // Only update viewing session if we're expecting it (user-initiated resume/switch).
          // The server also broadcasts session_resumed during background query execution
          // (onSessionInit), which we must ignore to avoid hijacking the user's view.
          if (msg.sessionId && pState.awaitingSessionSwitch) {
            pState.sessionId = msg.sessionId
            pState.awaitingSessionSwitch = false
            needsRender = true
          }
          // Fetch session history via HTTP (server no longer sends it over WS)
          if (msg.sessionId && msgProjectId) {
            fetchSessionHistoryRef.current(msgProjectId, msg.sessionId)
          }
          break

        case 'message_history': {
          // Route to the correct session (message includes sessionId from server)
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            sState.messages = msg.messages.map(parseSummaryToMessage)
            if (isViewing) needsRender = true
          }
          break
        }

        case 'user_message': {
          const target = getTargetSession()
          if (target) {
            const { sState, isViewing } = target
            // Deduplicate: skip if a message with the same id already exists
            if (!sState.messages.some((m) => m.id === msg.message.id)) {
              sState.messages = [...sState.messages, msg.message]
              if (isViewing) needsRender = true
            }
          }
          break
        }

        case 'ask_user_question': {
          const target = getTargetSession()
          console.log('[ws] ask_user_question received', { toolId: msg.toolId, questionsCount: msg.questions?.length, hasTarget: !!target })
          if (target) {
            target.sState.pendingQuestion = {
              toolId: msg.toolId,
              questions: msg.questions,
            }
            if (target.isViewing) needsRender = true
          }
          break
        }

        case 'session_status_changed':
          if (msg.sessionId) {
            emitSessionStatusChanged({ sessionId: msg.sessionId, status: msg.status })
          }
          break

        case 'model_changed':
          if (msg.model) pState.currentModel = msg.model
          needsRender = true
          break

        case 'permission_mode_changed':
          pState.permissionMode = msg.mode as PermissionMode
          needsRender = true
          break

        case 'permission_request':
          pState.pendingPermission = {
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            reason: msg.reason,
          }
          needsRender = true
          break

        case 'system':
          if (msg.subtype === 'init') {
            if (msg.model) pState.currentModel = msg.model
            // Only update viewing session if we're expecting it (switch_project, /clear, reconnect).
            // The server also broadcasts system init during background query execution
            // (SDK system_init event), which we must ignore.
            if (msg.sessionId && pState.awaitingSessionSwitch) {
              pState.sessionId = msg.sessionId
              pState.awaitingSessionSwitch = false
              // Fetch session history via HTTP (server no longer sends it over WS)
              if (msgProjectId) {
                fetchSessionHistoryRef.current(msgProjectId, msg.sessionId)
              }
            }
            if (msg.sdkMcpServers) pState.sdkMcpServers = msg.sdkMcpServers
            if (msg.sdkSkills) pState.sdkSkills = msg.sdkSkills
            if (msg.tools) pState.sdkTools = msg.tools
          }
          needsRender = true
          break

        case 'activity_heartbeat':
          pState.activityHeartbeat = {
            elapsedMs: msg.elapsedMs,
            lastActivityType: msg.lastActivityType,
            lastToolName: msg.lastToolName,
            paused: msg.paused,
          }
          needsRender = true
          break

        case 'sdk_event': {
          const target = getTargetSession()
          if (target && (msg as any).event) {
            const { sState, isViewing } = target
            sState.sdkEvents = [...sState.sdkEvents, (msg as any).event]
            if (isViewing) needsRender = true
          }
          break
        }

        case 'sdk_event_history': {
          const target = getTargetSession()
          if (target && (msg as any).events) {
            const { sState, isViewing } = target
            sState.sdkEvents = (msg as any).events
            if (isViewing) needsRender = true
          }
          break
        }

        case 'session_usage': {
          const su = msg as any
          pState.sessionUsage = {
            totalInputTokens: su.totalInputTokens,
            totalOutputTokens: su.totalOutputTokens,
            totalCacheReadTokens: su.totalCacheReadTokens,
            totalCacheCreateTokens: su.totalCacheCreateTokens,
            totalCostUsd: su.totalCostUsd,
            totalDurationMs: su.totalDurationMs,
            queryCount: su.queryCount,
            contextWindowUsed: su.contextWindowUsed,
            contextWindowMax: su.contextWindowMax,
          }
          needsRender = true
          break
        }

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
          // Add to viewing session's events (cron completion is a project-level notification)
          const sid = pState.sessionId
          if (sid) {
            const sState = getSessionState(pState, sid)
            sState.sdkEvents = [...sState.sdkEvents, cronEvent]
          }
          needsRender = true
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
          needsRender = true
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
          needsRender = true
          break
        }
      }

      // Trigger re-render if this message is for the active project and state changed
      if (isActiveProject && needsRender) {
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

  // Send helper: stamps projectId + sessionId (viewingSessionId) on outgoing messages
  const sendWithProject = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    const pid = activeProjectIdRef.current
    if (!pid) return false
    const pState = projectStatesRef.current.get(pid)
    ws.send(JSON.stringify({
      projectId: pid,
      sessionId: pState?.sessionId || undefined,
      ...msg,
    }))
    return true
  }, [])

  const sendPrompt = useCallback((prompt: string, images?: ImageAttachment[], enabledMcps?: string[], disabledSdkServers?: string[], disabledSkills?: string[]): boolean => {
    return sendWithProject({
      type: 'prompt',
      prompt,
      ...(images?.length ? { images } : {}),
      ...(enabledMcps ? { enabledMcps } : {}),
      ...(disabledSdkServers?.length ? { disabledSdkServers } : {}),
      ...(disabledSkills?.length ? { disabledSkills } : {}),
    })
  }, [sendWithProject])

  const sendCommand = useCallback((command: string): boolean => {
    // Don't add user message locally — the server broadcasts user_message back
    // for all non-/clear commands (they're re-routed as prompts on the server).
    return sendWithProject({ type: 'command', command })
  }, [sendWithProject])

  const abort = useCallback((queryId?: string) => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.isAborting = true
      triggerRender()
    }
    sendWithProject({ type: 'abort', queryId })
  }, [getProjectState, sendWithProject, triggerRender])

  const setWorkingDir = useCallback((dir: string) => {
    sendWithProject({ type: 'set_cwd', cwd: dir })
  }, [sendWithProject])

  const setProjectId = useCallback((projectId: string | null, projectCwd?: string) => {
    const prevProjectId = activeProjectIdRef.current
    if (projectId === prevProjectId) return

    activeProjectIdRef.current = projectId
    setActiveProjectId(projectId)

    // If we have a project, ensure we have a state entry for it
    if (projectId) {
      const pState = getProjectState(projectId)
      if (projectCwd && !pState.cwd) {
        pState.cwd = projectCwd
      }
      pState.awaitingSessionSwitch = true
    }

    // Send switch_project to server (if we have a project and are connected)
    if (projectId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'switch_project',
        projectId,
        projectCwd: projectCwd || undefined,
      }))
    }

    triggerRender()
  }, [getProjectState, triggerRender])

  const clearMessages = useCallback(() => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.awaitingSessionSwitch = true
    }
    sendWithProject({ type: 'command', command: '/clear' })
  }, [getProjectState, sendWithProject])

  const resumeSession = useCallback((sessionId: string) => {
    const pid = activeProjectIdRef.current
    if (!pid) return
    const pState = getProjectState(pid)
    // Cancel any pending switch_project session assignment — this explicit resume takes priority
    pState.awaitingSessionSwitch = false
    pState.sessionId = sessionId
    // Always reset session state so the HTTP fetch does a full replace.
    // Keeping stale cached data causes duplication because client-generated message IDs
    // (from WebSocket streaming) don't match server-generated IDs (from HTTP history),
    // making incremental dedup fail.
    pState.sessionStates.set(sessionId, createEmptySessionState())
    triggerRender()
    sendWithProject({ type: 'resume_session', sessionId })
  }, [getProjectState, sendWithProject, triggerRender])

  const newChat = useCallback(() => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      pState.awaitingSessionSwitch = true
    }
    sendWithProject({ type: 'command', command: '/clear' })
  }, [getProjectState, sendWithProject])

  const submitQuestionResponse = useCallback(
    (answers: Record<string, string | string[]>) => {
      const pid = activeProjectIdRef.current
      console.log('[submitQuestionResponse] called', { pid, answers })
      if (pid) {
        const pState = getProjectState(pid)
        const sid = pState.sessionId
        if (sid) {
          const sState = getSessionState(pState, sid)
          const toolId = sState.pendingQuestion?.toolId
          console.log('[submitQuestionResponse] pendingQuestion', { toolId, sessionId: sid, hasPendingQuestion: !!sState.pendingQuestion })
          if (toolId) {
            console.log('[submitQuestionResponse] sending respond_question', { type: 'respond_question', toolId, answers })
            sendWithProject({ type: 'respond_question', toolId, answers })
          } else {
            console.warn('[submitQuestionResponse] no toolId found — pendingQuestion may have been cleared already')
          }
          sState.pendingQuestion = null
        } else {
          console.warn('[submitQuestionResponse] no sessionId found')
        }
        triggerRender()
      }
    },
    [sendWithProject, getProjectState, triggerRender]
  )

  const dismissQuestion = useCallback(() => {
    const pid = activeProjectIdRef.current
    if (pid) {
      const pState = getProjectState(pid)
      const sid = pState.sessionId
      if (sid) {
        getSessionState(pState, sid).pendingQuestion = null
      }
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

  const executeNow = useCallback((queryId: string) => {
    sendWithProject({ type: 'execute_now', queryId })
  }, [sendWithProject])

  const probeSdk = useCallback(() => {
    sendWithProject({ type: 'probe_sdk' })
  }, [sendWithProject])

  const fetchSessions = useCallback(async (): Promise<import('@codecrab/shared').SessionInfo[]> => {
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

  // Read active project's state and viewing session's state for the return value
  const activeState = getActiveState()
  const viewingSessionState = activeState.sessionId
    ? (activeState.sessionStates.get(activeState.sessionId) || createEmptySessionState())
    : createEmptySessionState()

  return {
    connected,
    isRunning: activeState.isRunning,
    isAborting: activeState.isAborting,
    messages: viewingSessionState.messages,
    streamingText: getDisplayStreamingText(viewingSessionState.streamingText),
    streamingThinking: viewingSessionState.streamingThinking,
    latestSummary: viewingSessionState.latestSummary,
    suggestions: viewingSessionState.suggestions,
    pendingQuestion: viewingSessionState.pendingQuestion,
    pendingPermission: activeState.pendingPermission,
    cwd: activeState.cwd,
    availableModels,
    currentModel: activeState.currentModel,
    permissionMode: activeState.permissionMode,
    sessionId: activeState.sessionId,
    projectStatuses,
    activityHeartbeat: activeState.activityHeartbeat,
    queryQueue: activeState.queryQueue,
    sessionUsage: activeState.sessionUsage,
    sdkMcpServers: activeState.sdkMcpServers,
    sdkSkills: activeState.sdkSkills,
    sdkTools: activeState.sdkTools,
    sdkEvents: viewingSessionState.sdkEvents,
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
    executeNow,
    fetchSessions,
  }
}
