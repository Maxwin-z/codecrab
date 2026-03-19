// Channel plugin system — type definitions

import type { Question, PermissionMode, ImageAttachment } from '@codecrab/shared'
import type { Request, Response } from 'express'

// ============ Channel Definition (Registry Entry) ============

export interface ChannelDefinition {
  id: string                           // 'telegram', 'feishu', 'imessage'
  name: string                         // 'Telegram'
  description: string
  icon: string
  configSchema: ChannelConfigField[]   // Describes required config fields for UI
  factory: (config: ChannelConfig) => ChannelPlugin
}

export interface ChannelConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  required: boolean
  description?: string
  placeholder?: string
}

// ============ Channel Plugin (Plugin Interface) ============

export interface ChannelPlugin {
  readonly id: string
  readonly status: ChannelStatus

  // Lifecycle
  start(context: ChannelContext): Promise<void>
  stop(): Promise<void>
  healthCheck(): Promise<ChannelHealthResult>

  // Outbound callbacks (called by query executor when engine produces events)
  onQueryStart(conversationId: string, queryId: string): void
  onTextDelta(conversationId: string, text: string): void
  onToolUse(conversationId: string, toolName: string, toolId: string): void
  onToolResult(conversationId: string, toolId: string, content: string, isError: boolean): void
  onResult(conversationId: string, fullText: string, costUsd?: number, durationMs?: number): void
  onError(conversationId: string, error: string): void

  // Interactive flows (plugin decides how to present to user)
  onAskUserQuestion(conversationId: string, toolId: string, questions: Question[]): void
  onPermissionRequest(conversationId: string, requestId: string, toolName: string, input: unknown, reason: string): void

  // Webhook (optional — for platforms that use webhooks instead of polling)
  handleWebhook?(req: Request, res: Response): Promise<void>
}

export type ChannelStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ChannelHealthResult {
  healthy: boolean
  message?: string
  lastMessageAt?: number
}

// ============ Channel Context (Injected by ChannelManager) ============

export interface ChannelContext {
  // Submit a user prompt to a project
  submitPrompt(params: ChannelPromptParams): Promise<ChannelQueryResult>

  // Resolve pending interactive flows
  respondToQuestion(projectId: string, toolId: string, answers: Record<string, string | string[]>): boolean
  respondToPermission(projectId: string, requestId: string, allow: boolean): boolean

  // Project resolution (via mapping rules + defaultProjectId)
  resolveProject(externalUserId: string, conversationId?: string): Promise<ChannelProjectMapping | null>

  // Abort running query for a project
  abortQuery(projectId: string): boolean

  // Logging (prefixed with channel instance ID)
  log(level: 'info' | 'warn' | 'error', message: string): void

  // Plugin state persistence (~/.codecrab/channels/{instanceId}/state.json)
  loadState(): Promise<Record<string, unknown>>
  saveState(state: Record<string, unknown>): Promise<void>
}

export interface ChannelPromptParams {
  projectId: string
  prompt: string
  conversationId: string          // Platform-specific conversation/chat ID
  externalUserId: string          // Platform-specific user ID
  images?: ImageAttachment[]
}

export interface ChannelQueryResult {
  success: boolean
  queryId: string
  output?: string
  error?: string
  costUsd?: number
  durationMs?: number
}

export interface ChannelProjectMapping {
  projectId: string
  projectName: string
  permissionMode: PermissionMode
}

// ============ Channel Config (Per-Instance Configuration) ============

export interface ChannelConfig {
  id: string                           // Channel definition ID ('telegram')
  instanceId: string                   // Unique instance ID (supports multiple bots)
  enabled: boolean
  config: Record<string, unknown>      // Platform-specific (botToken, webhookUrl, etc.)

  // Project mapping
  projectMapping: ChannelProjectMappingRule[]
  defaultProjectId?: string            // Fallback when no rule matches

  // Behavior
  interactiveMode: 'forward' | 'auto_allow' | 'auto_deny'
  responseMode: 'streaming' | 'buffered'
  maxMessageLength?: number            // Platform limit (Telegram: 4096)

  createdAt: string
  updatedAt: string
}

export interface ChannelProjectMappingRule {
  externalUserIds?: string[]
  conversationIds?: string[]
  pattern?: string                     // Regex
  projectId: string
  permissionMode?: PermissionMode
}

// ============ Engine Context (Dependency Injection from Server) ============
// Uses `any` for opaque server types (ClientState, ServerMessage, QueuedQuery)
// to avoid circular dependency between channels and server packages.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ChannelEngineContext {
  queryQueue: {
    enqueue(params: {
      type: string
      projectId: string
      sessionId: string
      prompt: string
      priority?: number
      metadata?: Record<string, any>
      executor: (query: any) => Promise<any>
    }): { queryId: string; promise: Promise<any> }
    abortRunning(projectId: string): void
    touchActivity(queryId: string, activityType: string, toolName?: string, textSnippet?: string): void
    pauseTimeout(queryId: string): void
    resumeTimeout(queryId: string): void
    getRunningQuery?(projectId: string): any
  }
  createClientState: (clientId: string, projectId: string | undefined, cwd: string) => any
  executeQuery: (
    client: any,
    prompt: string,
    callbacks: {
      onTextDelta: (text: string) => void
      onThinkingDelta: (thinking: string) => void
      onToolUse: (toolName: string, toolId: string, input: unknown) => void
      onToolResult: (toolId: string, content: string, isError: boolean) => void
      onSessionInit: (sessionId: string) => void
      onPermissionRequest: (requestId: string, toolName: string, input: unknown, reason: string) => void
      onAskUserQuestion: (toolId: string, questions: unknown[]) => void
      onUsage: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) => void
    },
    images?: ImageAttachment[],
  ) => AsyncGenerator<{ type: string; data?: unknown }>
  handleQuestionResponse: (client: any, answers: Record<string, string | string[]>) => boolean
  handlePermissionResponse: (client: any, requestId: string, allow: boolean) => boolean
  broadcastToProject: (projectId: string | undefined, message: any) => void
  getOrCreateProjectState: (projectId: string) => { projectId: string; cwd: string }
  storeAssistantMessage: (client: any) => void
  generateSessionId: () => string
  listProjects: () => Promise<Array<{ id: string; name: string; path: string; icon: string }>>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ============ Conversation State ============

export interface ConversationState {
  conversationId: string
  sessionId: string
  projectId: string
  lastActivityAt: number
}
