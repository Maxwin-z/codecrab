// EngineAdapter — Pluggable AI engine interface
//
// Any engine (Claude Code SDK, opencode, etc.) must implement this interface.
// The server interacts only through EngineAdapter, never directly with SDK APIs.

export interface EngineAdapter {
  id: string
  name: string

  // Lifecycle
  init(config: EngineConfig): Promise<void>
  dispose(): Promise<void>

  // Session management
  createSession(opts: CreateSessionOpts): Promise<EngineSession>
  resumeSession(sessionId: string): Promise<EngineSession>
  destroySession(sessionId: string): Promise<void>

  // Query execution with streaming
  query(session: EngineSession, prompt: string, opts: QueryOpts): AsyncIterable<StreamEvent>
  abort(session: EngineSession): void

  // MCP server creation (engine-specific)
  createMcpServers?(session: EngineSession): McpServerConfig[]
}

export interface EngineConfig {
  apiKey: string
  baseUrl?: string
  configDir?: string
  permissionMode: 'bypassPermissions' | 'default'
}

export interface CreateSessionOpts {
  projectId?: string
  cwd?: string
  model?: string
}

export interface EngineSession {
  sessionId: string
  projectId?: string
  cwd: string
  model?: string
}

export interface QueryOpts {
  abortController: AbortController
  permissionMode: 'bypassPermissions' | 'default'
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResponse>
}

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: unknown
  reason: string
}

export interface PermissionResponse {
  behavior: 'allow' | 'deny'
  message?: string
}

export interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'result' | 'error'
  data: unknown
}

export interface McpServerConfig {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}
