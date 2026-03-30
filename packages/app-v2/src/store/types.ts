import type { DebugEvent, ProjectStatus, Question, ImageAttachment } from '@codecrab/shared'

// ============ Thread Types (Inter-Agent Communication) ============

export interface ThreadInfo {
  id: string
  title: string
  status: 'active' | 'completed' | 'stalled'
  parentThreadId: string | null
  participants: Array<{ agentId: string; agentName: string }>
  createdAt: number
  updatedAt: number
  stalledReason?: string
  messages: ThreadMessageInfo[]
}

export interface ThreadMessageInfo {
  id: string
  from: string
  to: string
  content: string
  artifacts: Array<{ id: string; name: string; path: string }>
  timestamp: number
}

export interface AutoResumeBanner {
  id: string
  agentId: string
  agentName: string
  threadId: string
  threadTitle: string
  triggeredBy: { agentId: string; agentName: string }
  timestamp: number
}

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
  threads: Record<string, ThreadInfo>
  autoResumeBanners: AutoResumeBanner[]
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
  upsertThread(thread: ThreadInfo): void
  addThreadMessage(threadId: string, message: ThreadMessageInfo): void
  addAutoResumeBanner(banner: AutoResumeBanner): void
  dismissAutoResumeBanner(id: string): void
}

export type Store = StoreState & StoreActions
