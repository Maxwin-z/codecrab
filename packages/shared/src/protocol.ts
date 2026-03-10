// WebSocket message protocol — shared between server, app, and relay

// ============ Client → Server Messages ============

export interface PromptMessage {
  type: 'prompt'
  prompt: string
}

export interface CommandMessage {
  type: 'command'
  command: string
}

export interface SetCwdMessage {
  type: 'set_cwd'
  cwd: string
}

export interface AbortMessage {
  type: 'abort'
}

export interface ResumeSessionMessage {
  type: 'resume_session'
  sessionId: string
}

export interface RespondQuestionMessage {
  type: 'respond_question'
  toolId: string
  answers: Record<string, string | string[]>
}

export interface RespondPermissionMessage {
  type: 'respond_permission'
  requestId: string
  allow: boolean
}

export interface SetModelMessage {
  type: 'set_model'
  model: string
}

export interface SetPermissionModeMessage {
  type: 'set_permission_mode'
  mode: 'bypassPermissions' | 'default'
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

// ============ Server → Client Messages ============

export interface SystemMessage {
  type: 'system'
  subtype: 'init' | string
  sessionId?: string
  model?: string
  tools?: string[]
}

export interface StreamDeltaMessage {
  type: 'stream_delta'
  deltaType: 'text' | 'thinking'
  text: string
}

export interface AssistantTextMessage {
  type: 'assistant_text'
  text: string
  parentToolUseId?: string | null
}

export interface ThinkingMessage {
  type: 'thinking'
  thinking: string
}

export interface ToolUseMessage {
  type: 'tool_use'
  toolName: string
  toolId: string
  input: unknown
}

export interface ToolResultMessage {
  type: 'tool_result'
  toolId: string
  content: string
  isError: boolean
}

export interface ResultMessage {
  type: 'result'
  subtype: string
  costUsd?: number
  durationMs?: number
  result?: string
  isError?: boolean
}

export interface QueryStartMessage {
  type: 'query_start'
}

export interface QueryEndMessage {
  type: 'query_end'
}

export interface QuerySummaryMessage {
  type: 'query_summary'
  summary: string
}

export interface ClearedMessage {
  type: 'cleared'
}

export interface AbortedMessage {
  type: 'aborted'
}

export interface CwdChangedMessage {
  type: 'cwd_changed'
  cwd: string
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface SessionResumedMessage {
  type: 'session_resumed'
  sessionId: string
}

export interface SessionStatusChangedMessage {
  type: 'session_status_changed'
  sessionId: string
  status: 'idle' | 'processing' | 'error'
}

export interface AskUserQuestionMessage {
  type: 'ask_user_question'
  toolId: string
  questions: Question[]
}

export interface ModelChangedMessage {
  type: 'model_changed'
  model?: string
}

export interface PermissionModeChangedMessage {
  type: 'permission_mode_changed'
  mode: string
}

export interface PermissionRequestMessage {
  type: 'permission_request'
  requestId: string
  toolName: string
  input: unknown
  reason: string
}

export interface MessageHistoryMessage {
  type: 'message_history'
  messages: ChatMessage[]
}

export interface UserMessage {
  type: 'user_message'
  message: ChatMessage
}

export interface AvailableModelsMessage {
  type: 'available_models'
  models: ModelInfo[]
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
  | ClearedMessage
  | AbortedMessage
  | CwdChangedMessage
  | ErrorMessage
  | SessionResumedMessage
  | SessionStatusChangedMessage
  | AskUserQuestionMessage
  | ModelChangedMessage
  | PermissionModeChangedMessage
  | PermissionRequestMessage
  | MessageHistoryMessage
  | UserMessage
  | AvailableModelsMessage

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
  thinking?: string
  toolCalls?: { name: string; id: string; input: unknown; result?: string; isError?: boolean }[]
  costUsd?: number
  durationMs?: number
  timestamp: number
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
}
