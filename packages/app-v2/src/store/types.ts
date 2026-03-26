import type { DebugEvent, ProjectStatus, Question, ImageAttachment } from '@codecrab/shared'

// ============ Session-level Types ============

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

// ============ Per-session Data ============

export interface SessionData {
  sessionId: string
  projectId: string
  status: 'idle' | 'processing' | 'error'
  providerId: string | null
  permissionMode: 'bypassPermissions' | 'default'
  messages: ChatMsg[]
  streamingText: string
  streamingThinking: string
  isStreaming: boolean
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  suggestions: string[]
  summary: string
  usage: SessionUsage | null
  activityHeartbeat: ActivityHeartbeat | null
  backgroundTasks: Record<string, BackgroundTask>
  sdkEvents: DebugEvent[]
}

// ============ Per-project State ============

export interface ProjectState {
  projectId: string
  sessions: Record<string, SessionData>
  viewingSessionId: string | null
  queryQueue: QueueItem[]
  isAborting: boolean
  promptPending: boolean
}

// ============ Root Store ============

export interface StoreState {
  connected: boolean
  projectStatuses: ProjectStatus[]
  projects: Record<string, ProjectState>
  sessionIdMap: Record<string, string> // tempId → realId
}

export interface StoreActions {
  setConnected(connected: boolean): void
  setProjectStatuses(statuses: ProjectStatus[]): void
  getOrCreateProject(projectId: string): ProjectState
  getOrCreateSession(projectId: string, sessionId: string): SessionData
  updateSession(projectId: string, sessionId: string, mutator: (session: SessionData) => void): void
  updateProject(projectId: string, mutator: (project: ProjectState) => void): void
  setViewingSession(projectId: string, sessionId: string | null): void
  resolveSessionId(tempId: string, realId: string): void
  resetViewingSession(projectId: string): void
}

export type Store = StoreState & StoreActions
