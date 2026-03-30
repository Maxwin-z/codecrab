import type { PermissionMode, ImageAttachment, Question, DebugEvent, ProviderConfig } from '@codecrab/shared'

// Re-export shared types used by other layers
export type { PermissionMode, ImageAttachment, Question, DebugEvent, ProviderConfig }

// ============ Agent Layer Types ============

/** Normalized stream event from Agent layer */
export type AgentStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; toolName: string; toolId: string; input: unknown; summary?: string }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean; totalLength?: number }
  | { type: 'ask_user_question'; toolId: string; questions: Question[] }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown; reason?: string }
  | { type: 'session_init'; sdkSessionId: string; tools: string[] }
  | { type: 'result'; result: string; isError: boolean; usage: UsageInfo; costUsd: number; durationMs: number; hasBackgroundTasks?: boolean; backgroundTaskIds?: string[] }
  | { type: 'sdk_event'; raw: DebugEvent }
  | { type: 'assistant_text'; text: string; parentToolUseId?: string | null }
  | { type: 'thinking_complete'; thinking: string }
  | { type: 'query_summary'; summary: string }
  | { type: 'query_suggestions'; suggestions: string[] }
  | { type: 'background_task_update'; taskId: string; status: 'started' | 'progress' | 'completed' | 'failed' | 'stopped'; description?: string; summary?: string; usage?: { totalTokens?: number; toolUses?: number; durationMs?: number } }

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  contextWindowUsed: number
  contextWindowMax: number
}

export interface AgentQueryOptions {
  model?: string
  permissionMode: PermissionMode
  cwd: string
  resume?: string
  enabledMcps?: string[]
  disabledSdkServers?: string[]
  disabledSkills?: string[]
  images?: ImageAttachment[]
  maxTurns?: number
  abortController?: AbortController
  soulEnabled?: boolean
  env?: Record<string, string | undefined>
  systemPromptAppend?: string
}

export interface SdkInitInfo {
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
  skills: Array<{ name: string; description: string }>
  models: Array<{ id: string; name: string }>
}

/** Agent interface — pure SDK wrapper, no state */
export interface AgentInterface {
  query(prompt: string, options: AgentQueryOptions): AsyncIterable<AgentStreamEvent>
  abort(sessionId: string): void
  probe(cwd: string, model?: string, env?: Record<string, string | undefined>): Promise<SdkInitInfo>
  resolvePermission(requestId: string, behavior: 'allow' | 'deny'): void
  resolveQuestion(sessionId: string, answers: Record<string, string | string[]>): void
  denyQuestion(toolId: string): void
}

// ============ Core Layer Types ============

export interface ProjectConfig {
  id: string
  name: string
  path: string
  icon: string
  defaultProviderId: string
  defaultPermissionMode: PermissionMode
  createdAt: number
  updatedAt: number
  lastActivityAt?: number
}

export interface SessionMeta {
  sdkSessionId: string
  projectId: string
  status: 'idle' | 'processing' | 'error'
  providerId: string
  permissionMode: PermissionMode
  pendingQuestion?: {
    toolId: string
    questions: Question[]
  } | null
  pendingPermissionRequest?: {
    requestId: string
    toolName: string
    input: unknown
    reason?: string
  } | null
  cronJobId?: string
  cronJobName?: string
  threadId?: string
  autoResumeCount?: number
  createdAt: number
  /** Cumulative usage for this session */
  usage: SessionUsage
}

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

export function createEmptyUsage(): SessionUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    queryCount: 0,
    contextWindowUsed: 0,
    contextWindowMax: 0,
  }
}

export interface Turn {
  id: string
  sessionId: string
  projectId: string
  queryId: string
  type: TurnType
  prompt: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout'
  startedAt?: number
  completedAt?: number
}

export type TurnType = 'user' | 'cron' | 'channel' | 'agent'

export interface TurnSubmitParams {
  projectId: string
  sessionId: string
  prompt: string
  type: TurnType
  images?: ImageAttachment[]
  /** URL-based image refs (data cleared, url set) for client broadcasting */
  urlImages?: ImageAttachment[]
  enabledMcps?: string[]
  disabledSdkServers?: string[]
  disabledSkills?: string[]
  soulEnabled?: boolean
  metadata?: TurnMetadata
}

export interface TurnMetadata {
  cronJobId?: string
  cronJobName?: string
  channelId?: string
  channelInstanceId?: string
  threadId?: string
  fromAgentId?: string
  fromAgentName?: string
  systemPromptAppend?: string
}

// ============ Core Events ============

export interface CoreEventMap {
  // Turn lifecycle
  'turn:start': TurnStartEvent
  'turn:delta': TurnDeltaEvent
  'turn:tool_use': TurnToolUseEvent
  'turn:tool_result': TurnToolResultEvent
  'turn:close': TurnCloseEvent
  'turn:error': TurnErrorEvent
  'turn:activity': TurnActivityEvent

  // SDK raw events
  'turn:sdk_event': TurnSdkEvent

  // Full text/thinking (accumulated)
  'turn:assistant_text': TurnAssistantTextEvent
  'turn:thinking_complete': TurnThinkingCompleteEvent

  // Summary & suggestions
  'turn:summary': TurnSummaryEvent
  'turn:suggestions': TurnSuggestionsEvent

  // Background tasks
  'turn:background_task': TurnBackgroundTaskEvent

  // Interaction requests
  'interaction:ask_question': InteractionAskQuestionEvent
  'interaction:permission_request': InteractionPermissionRequestEvent
  'interaction:permission_resolved': InteractionPermissionResolvedEvent
  'interaction:question_resolved': InteractionQuestionResolvedEvent

  // Session lifecycle
  'session:created': SessionCreatedEvent
  'session:id_resolved': SessionIdResolvedEvent
  'session:resumed': SessionResumedEvent
  'session:updated': SessionUpdatedEvent
  'session:status_changed': SessionStatusChangedEvent

  // Project state
  'project:status_changed': ProjectStatusChangedEvent

  // Queue state
  'queue:status': QueueStatusEvent
  'queue:snapshot': QueueSnapshotEvent

  // Thread lifecycle (inter-agent communication)
  'thread:created': ThreadCreatedEvent
  'thread:updated': ThreadUpdatedEvent
  'thread:completed': ThreadCompletedEvent
  'thread:stalled': ThreadStalledEvent

  // Inter-agent messaging
  'message:sent': MessageSentEvent
  'message:delivered': MessageDeliveredEvent

  // Auto-resume
  'agent:auto_resume': AgentAutoResumeEvent
}

export interface TurnStartEvent {
  projectId: string
  sessionId: string
  turnId: string
  queryId: string
  prompt: string
  type: TurnType
  images?: ImageAttachment[]
}

export interface TurnDeltaEvent {
  projectId: string
  sessionId: string
  turnId: string
  deltaType: 'text' | 'thinking'
  text: string
}

export interface TurnToolUseEvent {
  projectId: string
  sessionId: string
  turnId: string
  toolName: string
  toolId: string
  input: unknown
  summary?: string
}

export interface TurnToolResultEvent {
  projectId: string
  sessionId: string
  turnId: string
  toolId: string
  content: string
  isError: boolean
  totalLength?: number
}

export interface TurnCloseEvent {
  projectId: string
  sessionId: string
  turnId: string
  type: TurnType
  result: string
  isError: boolean
  usage: UsageInfo
  costUsd: number
  durationMs: number
  hasBackgroundTasks?: boolean
  backgroundTaskIds?: string[]
}

export interface TurnErrorEvent {
  projectId: string
  sessionId: string
  turnId: string
  error: string
}

export interface TurnActivityEvent {
  projectId: string
  sessionId: string
  queryId: string
  elapsedMs: number
  activityType: string
  toolName?: string
  textSnippet?: string
  paused?: boolean
}

export interface TurnSdkEvent {
  projectId: string
  sessionId: string
  turnId: string
  event: DebugEvent
}

export interface TurnAssistantTextEvent {
  projectId: string
  sessionId: string
  turnId: string
  text: string
  parentToolUseId?: string | null
}

export interface TurnThinkingCompleteEvent {
  projectId: string
  sessionId: string
  turnId: string
  thinking: string
}

export interface TurnSummaryEvent {
  projectId: string
  sessionId: string
  turnId: string
  summary: string
}

export interface TurnSuggestionsEvent {
  projectId: string
  sessionId: string
  turnId: string
  suggestions: string[]
}

export interface TurnBackgroundTaskEvent {
  projectId: string
  sessionId: string
  turnId: string
  taskId: string
  status: 'started' | 'progress' | 'completed' | 'failed' | 'stopped'
  description?: string
  summary?: string
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
}

export interface InteractionAskQuestionEvent {
  projectId: string
  sessionId: string
  turnId: string
  toolId: string
  questions: Question[]
}

export interface InteractionPermissionRequestEvent {
  projectId: string
  sessionId: string
  turnId: string
  requestId: string
  toolName: string
  input: unknown
  reason?: string
}

export interface InteractionPermissionResolvedEvent {
  projectId: string
  sessionId: string
  requestId: string
}

export interface InteractionQuestionResolvedEvent {
  projectId: string
  sessionId: string
  toolId: string
}

export interface SessionCreatedEvent {
  projectId: string
  sessionId: string
  parentSessionId?: string
  cronJobId?: string
  cronJobName?: string
}

export interface SessionIdResolvedEvent {
  projectId: string
  tempSessionId: string
  sessionId: string
}

export interface SessionResumedEvent {
  projectId: string
  sessionId: string
  providerId?: string
}

export interface SessionUpdatedEvent {
  projectId: string
  sessionId: string
}

export interface SessionStatusChangedEvent {
  projectId: string
  sessionId: string
  status: 'idle' | 'processing' | 'error'
}

export interface ProjectStatusChangedEvent {
  projectId: string
  status: 'idle' | 'processing'
  activityType?: string
  sessionId?: string
}

export interface QueueStatusEvent {
  projectId: string
  sessionId?: string
  queryId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  position?: number
  queueLength?: number
  prompt?: string
  queryType?: TurnType
  cronJobName?: string
}

export interface QueueSnapshotEvent {
  projectId: string
  items: Array<{
    queryId: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
    position: number
    prompt: string
    queryType: TurnType
    sessionId?: string
    cronJobName?: string
  }>
}

// ============ Queue Types ============

export interface QueuedQuery {
  id: string
  type: TurnType
  projectId: string
  sessionId: string
  prompt: string
  cronJobName?: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  position: number
  enqueuedAt: number
  startedAt?: number
  lastActivityAt?: number
  lastActivityType?: string
  paused: boolean
  executor: (query: QueuedQuery) => Promise<void>
}

// ============ Gateway Types ============

export interface Client {
  ws: import('ws').WebSocket
  connectionId: string
  clientId: string
  subscribedProjects: Map<string, { sessionId?: string }>
}

// ============ Cron Types ============

export interface CronJob {
  id: string
  projectId: string
  sessionId: string
  name: string
  schedule: string
  prompt: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastRunStatus?: 'success' | 'failure'
  /** 'cron' = recurring (default), 'at' = one-shot at a specific time */
  type?: 'cron' | 'at'
  /** Epoch ms — absolute time for one-shot execution */
  runAt?: number
}

export interface CronExecution {
  jobId: string
  jobName: string
  projectId: string
  sessionId: string
  execSessionId: string
  startedAt: number
  completedAt?: number
  success?: boolean
  error?: string
}

// ============ Thread Types (Inter-Agent Communication) ============

export type ThreadStatus = 'active' | 'completed' | 'stalled'

export interface Thread {
  id: string
  title: string
  parentThreadId: string | null
  status: ThreadStatus
  participants: ThreadParticipant[]
  config: ThreadConfig
  turnCount: number
  createdAt: number
  updatedAt: number
}

export interface ThreadParticipant {
  agentId: string
  agentName: string
  sessionId: string
  joinedAt: number
  lastActiveAt: number
}

export interface ThreadConfig {
  maxTurns: number
}

export interface ThreadMessage {
  id: string
  threadId: string
  from: AgentRef
  to: AgentRef | 'broadcast'
  content: string
  artifacts: ArtifactRef[]
  status: MessageStatus
  createdAt: number
}

export interface AgentRef {
  agentId: string
  agentName: string
}

export type MessageStatus = 'pending' | 'delivered' | 'failed'

export interface Artifact {
  id: string
  threadId: string
  name: string
  mimeType: string
  createdBy: AgentRef
  path: string
  size: number
  createdAt: number
}

export type ArtifactRef = Pick<Artifact, 'id' | 'name' | 'path'>

// ============ Thread Event Types ============

export interface ThreadCreatedEvent { thread: Thread }
export interface ThreadUpdatedEvent { thread: Thread }
export interface ThreadCompletedEvent { thread: Thread }
export interface ThreadStalledEvent { thread: Thread; reason: string }

export interface MessageSentEvent { message: ThreadMessage; threadId: string }
export interface MessageDeliveredEvent { message: ThreadMessage; targetAgentId: string; targetSessionId: string }

export interface AgentAutoResumeEvent {
  agentId: string
  agentName: string
  sessionId: string
  threadId: string
  threadTitle: string
  triggeredBy: AgentRef
}
