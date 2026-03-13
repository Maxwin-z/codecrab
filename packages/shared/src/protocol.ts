// WebSocket message protocol — shared between server, app, and relay

// ============ Client → Server Messages ============

// All project-scoped client messages carry optional projectId + sessionId
export interface ProjectContext {
  projectId?: string
  sessionId?: string
}

export interface PromptMessage extends ProjectContext {
  type: 'prompt'
  prompt: string
  images?: ImageAttachment[]
  enabledMcps?: string[]        // Custom MCP IDs to enable for this query (default: all)
  disabledSdkServers?: string[] // SDK MCP server names to disable for this query
  disabledSkills?: string[]     // Skill names to disable for this query
}

export interface CommandMessage extends ProjectContext {
  type: 'command'
  command: string
}

export interface SetCwdMessage extends ProjectContext {
  type: 'set_cwd'
  cwd: string
}

export interface AbortMessage extends ProjectContext {
  type: 'abort'
}

export interface ResumeSessionMessage extends ProjectContext {
  type: 'resume_session'
  sessionId: string
}

export interface RespondQuestionMessage extends ProjectContext {
  type: 'respond_question'
  toolId: string
  answers: Record<string, string | string[]>
}

export interface RespondPermissionMessage extends ProjectContext {
  type: 'respond_permission'
  requestId: string
  allow: boolean
}

export interface SetModelMessage extends ProjectContext {
  type: 'set_model'
  model: string
}

export interface SetPermissionModeMessage extends ProjectContext {
  type: 'set_permission_mode'
  mode: 'bypassPermissions' | 'default'
}

export interface SwitchProjectMessage {
  type: 'switch_project'
  projectId: string
  projectCwd?: string
}

export interface ProbeSdkMessage extends ProjectContext {
  type: 'probe_sdk'
}

export type ClientMessage =
  | PromptMessage
  | CommandMessage
  | SetCwdMessage
  | AbortMessage
  | ResumeSessionMessage
  | RespondQuestionMessage
  | RespondPermissionMessage
  | SetModelMessage
  | SetPermissionModeMessage
  | SwitchProjectMessage
  | ProbeSdkMessage

// ============ Server → Client Messages ============

// Server messages that are project-scoped carry projectId + sessionId
export interface ServerProjectContext {
  projectId?: string
  sessionId?: string
}

export interface SystemMessage extends ServerProjectContext {
  type: 'system'
  subtype: 'init' | string
  model?: string
  tools?: string[]
  sdkMcpServers?: SdkMcpServer[]   // MCP servers reported by Claude Code SDK
  sdkSkills?: SdkSkill[]            // Skills reported by Claude Code SDK
}

export interface StreamDeltaMessage extends ServerProjectContext {
  type: 'stream_delta'
  deltaType: 'text' | 'thinking'
  text: string
}

export interface AssistantTextMessage extends ServerProjectContext {
  type: 'assistant_text'
  text: string
  parentToolUseId?: string | null
}

export interface ThinkingMessage extends ServerProjectContext {
  type: 'thinking'
  thinking: string
}

export interface ToolUseMessage extends ServerProjectContext {
  type: 'tool_use'
  toolName: string
  toolId: string
  input: unknown
}

export interface ToolResultMessage extends ServerProjectContext {
  type: 'tool_result'
  toolId: string
  content: string
  isError: boolean
}

export interface ResultMessage extends ServerProjectContext {
  type: 'result'
  subtype: string
  costUsd?: number
  durationMs?: number
  result?: string
  isError?: boolean
}

export interface QueryStartMessage extends ServerProjectContext {
  type: 'query_start'
  queryId?: string
}

export interface QueryEndMessage extends ServerProjectContext {
  type: 'query_end'
  queryId?: string
}

export type QueryQueueItemStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'

export interface QueryQueueStatusMessage extends ServerProjectContext {
  type: 'query_queue_status'
  queryId: string
  status: QueryQueueItemStatus
  position?: number
  queueLength?: number
}

export interface QueryQueuedMessage extends ServerProjectContext {
  type: 'query_queued'
  queryId: string
  position: number
  queueLength: number
}

export interface QuerySummaryMessage extends ServerProjectContext {
  type: 'query_summary'
  summary: string
}

export interface QuerySuggestionsMessage extends ServerProjectContext {
  type: 'query_suggestions'
  suggestions: string[]
}

export interface ClearedMessage extends ServerProjectContext {
  type: 'cleared'
}

export interface AbortedMessage extends ServerProjectContext {
  type: 'aborted'
}

export interface CwdChangedMessage extends ServerProjectContext {
  type: 'cwd_changed'
  cwd: string
}

export interface ErrorMessage extends ServerProjectContext {
  type: 'error'
  message: string
}

export interface SessionResumedMessage extends ServerProjectContext {
  type: 'session_resumed'
}

export interface SessionCreatedMessage extends ServerProjectContext {
  type: 'session_created'
  parentSessionId?: string
  cronJobId?: string
  cronJobName?: string
}

export interface CronTaskCompletedMessage extends ServerProjectContext {
  type: 'cron_task_completed'
  cronJobId: string
  cronJobName?: string
  parentSessionId: string
  execSessionId: string
  success: boolean
}

export interface ActivityHeartbeatMessage extends ServerProjectContext {
  type: 'activity_heartbeat'
  queryId: string
  elapsedMs: number
  lastActivityType: string
  lastToolName?: string
  paused?: boolean
}

export interface SessionStatusChangedMessage extends ServerProjectContext {
  type: 'session_status_changed'
  status: 'idle' | 'processing' | 'error'
}

export interface AskUserQuestionMessage extends ServerProjectContext {
  type: 'ask_user_question'
  toolId: string
  questions: Question[]
}

export interface ModelChangedMessage extends ServerProjectContext {
  type: 'model_changed'
  model?: string
}

export interface PermissionModeChangedMessage extends ServerProjectContext {
  type: 'permission_mode_changed'
  mode: string
}

export interface PermissionRequestMessage extends ServerProjectContext {
  type: 'permission_request'
  requestId: string
  toolName: string
  input: unknown
  reason: string
}

export interface MessageHistoryMessage extends ServerProjectContext {
  type: 'message_history'
  messages: ChatMessageSummary[]
}

export interface MessageHistoryChunkMessage extends ServerProjectContext {
  type: 'message_history_chunk'
  messages: ChatMessage[]
  chunkIndex: number
  totalChunks: number
  isFirstChunk: boolean
  isLastChunk: boolean
}

// Summary version of ChatMessage for history preview
export interface ChatMessageSummary {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string  // full content for assistant/user, truncated for system
  contentPreview: string
  isTruncated: boolean
  hasToolCalls: boolean
  hasImages: boolean
  timestamp: number
  // Lightweight tool call info for history display
  toolCalls?: { name: string; id: string; input?: unknown; inputSummary: string; resultPreview?: string; isError?: boolean }[]
  costUsd?: number
  durationMs?: number
}

export interface UserMessage extends ServerProjectContext {
  type: 'user_message'
  message: ChatMessage
}

export interface AvailableModelsMessage {
  type: 'available_models'
  models: ModelInfo[]
}

export interface ProjectStatus {
  projectId: string
  status: 'idle' | 'processing'
  sessionId?: string
  firstPrompt?: string
  lastModified?: number
}

export interface ProjectStatusesMessage {
  type: 'project_statuses'
  statuses: ProjectStatus[]
}

export type ServerMessage =
  | SystemMessage
  | StreamDeltaMessage
  | AssistantTextMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage
  | QueryStartMessage
  | QueryEndMessage
  | QuerySummaryMessage
  | QuerySuggestionsMessage
  | ClearedMessage
  | AbortedMessage
  | CwdChangedMessage
  | ErrorMessage
  | SessionResumedMessage
  | SessionCreatedMessage
  | SessionStatusChangedMessage
  | AskUserQuestionMessage
  | ModelChangedMessage
  | PermissionModeChangedMessage
  | PermissionRequestMessage
  | MessageHistoryMessage
  | MessageHistoryChunkMessage
  | UserMessage
  | AvailableModelsMessage
  | ProjectStatusesMessage
  | QueryQueueStatusMessage
  | QueryQueuedMessage
  | CronTaskCompletedMessage
  | ActivityHeartbeatMessage

// ============ Image Attachments ============

export interface ImageAttachment {
  data: string       // base64-encoded image data
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  name?: string      // original filename
}

// ============ Shared Types ============

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: ImageAttachment[]
  thinking?: string
  toolCalls?: { name: string; id: string; input: unknown; result?: string; isError?: boolean }[]
  costUsd?: number
  durationMs?: number
  timestamp: number
}

export interface DebugEvent {
  ts: number
  type: 'query_start' | 'sdk_spawn' | 'sdk_init' | 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'result' | 'error' | 'permission_request' | 'permission_response' | 'ask_question' | 'usage'
  detail?: string
  data?: Record<string, unknown>
}

export interface PendingPermission {
  requestId: string
  toolName: string
  input: unknown
  reason: string
}

export type PermissionMode = 'bypassPermissions' | 'default'

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  cwd?: string
  status?: 'idle' | 'processing' | 'error'
  isActive?: boolean
  projectId?: string
}

export interface McpInfo {
  id: string
  name: string
  description: string
  icon?: string           // emoji or icon identifier
  toolCount: number
  source?: 'custom' | 'sdk' | 'skill'  // where this MCP/skill originates
  tools?: string[]        // tool names (for SDK MCPs, used for disallowedTools)
}

/** SDK MCP server info from the Claude Code init message */
export interface SdkMcpServer {
  name: string
  status: string
}

/** SDK skill info with name and description */
export interface SdkSkill {
  name: string
  description: string
}
