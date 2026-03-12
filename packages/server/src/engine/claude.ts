// ClaudeAdapter — Claude Code SDK implementation of EngineAdapter
//
// Wraps @anthropic-ai/claude-agent-sdk to conform to the EngineAdapter interface.

import { query, type SDKMessage, type SDKUserMessage, type Query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { buildMcpServers } from '../mcp/index.js'
import { buildSkillServers } from '../skills/index.js'
import { setCronQueryContext } from '../mcp/cron/index.js'
import type {
  ChatMessage,
  ImageAttachment,
  Question,
  ModelInfo,
  PermissionMode,
} from '@codeclaws/shared'

// Re-export types for convenience
export type { ChatMessage, Question, ModelInfo, PermissionMode }

// ── Server defaults ──────────────────────────────────────────

/** Maximum agentic turns before stopping (server default) */
export const DEFAULT_MAX_TURNS = 200

/** Thinking effort level (server default) */
export const DEFAULT_EFFORT: 'low' | 'medium' | 'high' | 'max' = 'high'

/** Read-only tools auto-approved in Safe mode (default permissionMode).
 *  All other tools go through canUseTool callback for client approval. */
export const SAFE_MODE_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
]

/** Programmatic subagent definitions — always available via the Agent tool.
 *  Project-level agents from .claude/agents/ are loaded via settingSources. */
export const agentDefinitions: Record<string, AgentDefinition> = {
  // Agents will be added here as features require them.
}

// Engine configuration from models.json
export interface ModelConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'google' | 'custom'
  modelId?: string   // Actual model identifier for the API (e.g., "claude-sonnet-4-20250514")
  apiKey?: string
  baseUrl?: string
  /** @deprecated Ignored — CLAUDE_CONFIG_DIR is always ~/.claude */
  configDir?: string
}

export interface EngineConfig {
  model?: ModelConfig
  permissionMode?: PermissionMode
}

// Pending permission request
interface PendingPermission {
  resolve: (result: { behavior: 'allow' | 'deny'; message?: string }) => void
}

// Active query state
interface ActiveQuery {
  abort: AbortController
  queryObj?: Query  // SDK Query object for forceful close
}

// Client state for WebSocket connections
export interface ClientState {
  clientId: string
  projectId?: string
  sessionId?: string
  cwd: string
  model?: string
  permissionMode: PermissionMode
  activeQuery: ActiveQuery | null
  pendingPermissions: Map<string, PendingPermission>
  lastActivity: number
  // Message accumulation during streaming
  accumulatingText: string
  accumulatingThinking: string
  currentToolCalls: ChatMessage['toolCalls']
  currentCostUsd?: number
  currentDurationMs?: number
  // Cached SDK info from init message (used for disallowedTools resolution)
  sdkTools?: string[]
}

// Project-level state (shared across clients)
export interface ProjectState {
  projectId: string
  sessionId?: string
  cwd: string
  model?: string
  permissionMode: PermissionMode
  activeQuery: ActiveQuery | null
  messages: ChatMessage[]
  lastActivity: number
  pendingQuestion?: { toolId: string; questions: any[] } | null
  pendingPermissionRequest?: any | null
}

// Session status tracking
export interface SessionStatus {
  sessionId: string
  cwd: string
  status: 'idle' | 'processing' | 'error'
  lastActivity: number
  clientId?: string
}

// Module-level state
const clients = new Map<string, ClientState>()
const projects = new Map<string, ProjectState>()
const sessionStatuses = new Map<string, SessionStatus>()
let cachedModels: ModelInfo[] | null = null
let messageIdCounter = 0

// Config paths
// ~/.claude  — SDK runtime: auth (OAuth), skills, commands, settings (shared with CLI)
// ~/.codeclaws — CodeClaws-specific: models.json, projects.json, sessions, cron, etc.
const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const CODECLAWS_DIR = path.join(os.homedir(), '.codeclaws')
const MODELS_FILE = path.join(CODECLAWS_DIR, 'models.json')
const PROJECTS_FILE = path.join(CODECLAWS_DIR, 'projects.json')

// Look up project path from projects.json
function getProjectPath(projectId: string): string | null {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf-8')
    const projects: { id: string; path: string }[] = JSON.parse(data)
    const project = projects.find((p) => p.id === projectId)
    return project?.path || null
  } catch {
    return null
  }
}

// Read models.json to get default model configuration
function readModelsConfig(): { models: ModelConfig[]; defaultModelId?: string } {
  try {
    const data = fs.readFileSync(MODELS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { models: [] }
  }
}

// Get default model configuration
export function getDefaultModelConfig(): ModelConfig | null {
  const config = readModelsConfig()
  if (!config.defaultModelId) return null
  return config.models.find((m) => m.id === config.defaultModelId) || null
}

// Generate unique IDs
function genId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

export function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Get or create project state
export function getOrCreateProjectState(projectId: string): ProjectState {
  let project = projects.get(projectId)
  if (!project) {
    project = {
      projectId,
      cwd: getProjectPath(projectId) || process.cwd(),
      permissionMode: 'bypassPermissions',
      activeQuery: null,
      messages: [],
      lastActivity: Date.now(),
    }
    projects.set(projectId, project)
  }
  return project
}

// Get project state
export function getProjectState(projectId: string): ProjectState | undefined {
  return projects.get(projectId)
}

// Get all project IDs that have active queries running
export function getActiveProjectIds(): string[] {
  const result: string[] = []
  for (const [id, state] of projects) {
    if (state.activeQuery) result.push(id)
  }
  return result
}

// Composite key for client state: clientId:projectId
function clientStateKey(clientId: string, projectId?: string): string {
  return projectId ? `${clientId}:${projectId}` : clientId
}

// Create new client state
export function createClientState(
  clientId: string,
  projectId: string | undefined,
  cwd: string
): ClientState {
  const client: ClientState = {
    clientId,
    projectId,
    cwd,
    permissionMode: 'bypassPermissions',
    activeQuery: null,
    pendingPermissions: new Map(),
    lastActivity: Date.now(),
    accumulatingText: '',
    accumulatingThinking: '',
    currentToolCalls: [],
  }
  clients.set(clientStateKey(clientId, projectId), client)
  return client
}

// Get client state
export function getClientState(clientId: string, projectId?: string): ClientState | undefined {
  return clients.get(clientStateKey(clientId, projectId))
}

// Remove client state
export function removeClientState(clientId: string, projectId?: string): boolean {
  return clients.delete(clientStateKey(clientId, projectId))
}

// Remove all client states for a given clientId
export function removeAllClientStates(clientId: string): void {
  const prefix = `${clientId}:`
  for (const key of clients.keys()) {
    if (key === clientId || key.startsWith(prefix)) {
      clients.delete(key)
    }
  }
}

// Get all client states for a given clientId
export function getClientStatesForClient(clientId: string): ClientState[] {
  const result: ClientState[] = []
  const prefix = `${clientId}:`
  for (const [key, state] of clients) {
    if (key === clientId || key.startsWith(prefix)) {
      result.push(state)
    }
  }
  return result
}

// Get session statuses
export function getSessionStatuses(): SessionStatus[] {
  return Array.from(sessionStatuses.values()).sort(
    (a, b) => b.lastActivity - a.lastActivity
  )
}

// Get cached models
export function getCachedModels(): ModelInfo[] | null {
  return cachedModels
}

// Load models from config and set as cached
export function loadModelsFromConfig(): ModelInfo[] {
  const config = readModelsConfig()
  const models: ModelInfo[] = config.models.map((m) => ({
    value: m.id,
    displayName: m.name,
    description: `${m.provider}${m.baseUrl ? ` (${m.baseUrl})` : ''}`,
  }))
  cachedModels = models
  return models
}

// Get simplified model display name for UI
// Returns: 'Claude' for anthropic, 'Google' for google, 'OpenAI' for openai, or custom name
export function getModelDisplayName(modelId: string): string {
  const config = readModelsConfig()
  const model = config.models.find((m) => m.id === modelId)
  if (!model) return 'Default'

  switch (model.provider) {
    case 'anthropic':
      return 'Claude'
    case 'google':
      return 'Google'
    case 'openai':
      return 'OpenAI'
    case 'custom':
      return model.name || 'Custom'
    default:
      return model.name || 'Default'
  }
}

// Apply model configuration to environment
// NOTE: Per-query env is built fresh in executeQuery() to avoid process.env pollution.
// This function only sets state needed at startup (logging).
function applyModelConfig(config: ModelConfig): void {
  const apiKey = config.apiKey

  console.log(`[ClaudeAdapter] Applied config for model: ${config.id}`)
  console.log(`  CLAUDE_DIR: ${CLAUDE_DIR}`)
  console.log(`  Base URL: ${config.baseUrl || 'default'}`)
  console.log(`  API Key: ${apiKey ? apiKey.slice(0, 10) + '...' : 'not set (using CLI OAuth)'}`)
}

// Build prompt for SDK: plain string or SDKUserMessage with images
export function buildPrompt(
  prompt: string,
  images?: ImageAttachment[],
  sessionId?: string,
): string | AsyncIterable<SDKUserMessage> {
  if (!images || images.length === 0) {
    return prompt
  }

  // Build content blocks: images first, then text
  const contentBlocks: unknown[] = []

  for (const img of images) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        data: img.data,
        media_type: img.mediaType,
      },
    })
  }

  contentBlocks.push({
    type: 'text',
    text: prompt,
  })

  const userMessage: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks,
    } as any,
    parent_tool_use_id: null,
    session_id: sessionId || '',
  }

  // Return an async iterable that yields a single message
  async function* singleMessage(): AsyncIterable<SDKUserMessage> {
    yield userMessage
  }

  return singleMessage()
}

/** Build the SDK query options object.
 *  Extracted for testability — unit tests can inspect the returned options
 *  without needing to mock the SDK query() call. */
export function buildQueryOptions(
  client: ClientState,
  queryEnv: Record<string, string | undefined>,
  enabledMcps?: string[],
  disabledSdkServers?: string[],
  disabledSkills?: string[],
): Record<string, unknown> {
  const isYolo = client.permissionMode === 'bypassPermissions'

  const options: Record<string, unknown> = {
    cwd: client.cwd,
    env: queryEnv,
    permissionMode: isYolo ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: isYolo,
    includePartialMessages: true,

    // Load CLAUDE.md, skills, commands, agents from:
    //   "project" → .claude/skills/, .claude/commands/, CLAUDE.md (project-level)
    //   "user"    → ~/.claude/skills/, ~/.claude/commands/ (user-level, installed skills)
    settingSources: ['project', 'user'],

    // Server-side defaults
    maxTurns: DEFAULT_MAX_TURNS,
    effort: DEFAULT_EFFORT,

    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `\n\nYour working directory is ${client.cwd}.` +
        `\n\nWhen the MCP cron tools are available (mcp__cron__cron_create, mcp__cron__cron_list, mcp__cron__cron_delete, mcp__cron__cron_get), ` +
        `you MUST use them instead of the system CronCreate/CronDelete/CronList tools for all scheduling tasks. ` +
        `The MCP cron tools provide persistent scheduled tasks that survive server restarts, while the system cron tools are session-only and will be lost when the session ends.`,
    },
  }

  // In Safe mode, pre-approve only read-only tools.
  // All other tools go through canUseTool callback for client approval.
  // In YOLO mode, don't set allowedTools — bypassPermissions handles it.
  if (!isYolo) {
    options.allowedTools = [...SAFE_MODE_ALLOWED_TOOLS]
  }

  // MCP servers — filtered by user's enabledMcps selection + skill servers
  const mcpServers = buildMcpServers(enabledMcps)
  const skillServers = buildSkillServers()
  options.mcpServers = { ...mcpServers, ...skillServers }

  // Disable SDK MCP server tools and skills via disallowedTools
  // SDK MCP tools follow the naming convention: mcp__<server_name>__<tool_name>
  // We use the cached tools list to find exact tool names for each disabled server
  const disallowed: string[] = []
  if (disabledSdkServers?.length && client.sdkTools?.length) {
    for (const serverName of disabledSdkServers) {
      const prefix = `mcp__${serverName}__`
      for (const toolName of client.sdkTools) {
        if (toolName.startsWith(prefix)) {
          disallowed.push(toolName)
        }
      }
    }
  }
  if (disabledSkills?.length && client.sdkTools?.length) {
    // Skills register tools with their name as part of the tool name
    for (const skillName of disabledSkills) {
      for (const toolName of client.sdkTools) {
        if (toolName === skillName || toolName.startsWith(`${skillName}:`)) {
          disallowed.push(toolName)
        }
      }
    }
  }
  if (disallowed.length > 0) {
    options.disallowedTools = disallowed
  }

  // Programmatic agent definitions (only set when non-empty)
  if (Object.keys(agentDefinitions).length > 0) {
    options.agents = agentDefinitions
  }

  // Session resume
  if (client.sessionId) {
    options.resume = client.sessionId
  }

  return options
}

/** Build per-query env vars from model config.
 *  Extracted so probeSdkInit can reuse it without duplicating logic. */
function buildQueryEnv(modelConfig: ModelConfig): Record<string, string | undefined> {
  const apiKey = modelConfig.apiKey || process.env.ANTHROPIC_API_KEY

  const queryEnv: Record<string, string | undefined> = {
    ...process.env,
  }

  // IMPORTANT: Do NOT set CLAUDE_CONFIG_DIR for OAuth models.
  // The SDK's embedded CLI uses CLAUDE_CONFIG_DIR to compute the macOS Keychain
  // service name (adds a sha256 hash suffix when the var is set). When the user
  // logs in via the global `claude` CLI (which runs without CLAUDE_CONFIG_DIR),
  // the credentials are stored WITHOUT the hash suffix. Setting CLAUDE_CONFIG_DIR
  // explicitly causes a Keychain key mismatch → "Not logged in".
  // For 3rd-party models with API keys, auth doesn't use Keychain, so it's safe
  // to set CLAUDE_CONFIG_DIR to ensure skills/commands are loaded from ~/.claude.
  if (apiKey) {
    queryEnv.CLAUDE_CONFIG_DIR = CLAUDE_DIR
    queryEnv.ANTHROPIC_API_KEY = apiKey
  } else {
    delete queryEnv.CLAUDE_CONFIG_DIR
    delete queryEnv.ANTHROPIC_API_KEY
  }

  if (modelConfig.baseUrl) {
    queryEnv.ANTHROPIC_BASE_URL = modelConfig.baseUrl
  } else {
    delete queryEnv.ANTHROPIC_BASE_URL
  }

  // Prevent nested-session detection when server runs inside a Claude Code terminal
  delete queryEnv.CLAUDECODE
  delete queryEnv.CLAUDE_CODE_ENTRYPOINT

  return queryEnv
}

/** Probe result from a lightweight SDK init */
export interface SdkInitInfo {
  tools: string[]
  sdkMcpServers: { name: string; status: string }[]
  sdkSkills: string[]
}

/** Lightweight probe: start an SDK subprocess just to capture the init message
 *  (tools, mcp_servers, skills), then abort immediately.
 *  No API call is made — the init message is emitted before any LLM interaction. */
export async function probeSdkInit(client: ClientState): Promise<SdkInitInfo | null> {
  const modelConfig = getDefaultModelConfig()
  if (!modelConfig) return null

  const queryEnv = buildQueryEnv(modelConfig)
  const options = buildQueryOptions(client, queryEnv)
  const abortController = new AbortController()
  options.abortController = abortController
  options.maxTurns = 1

  try {
    const stream = query({ prompt: '.', options: options as any })

    for await (const message of stream) {
      if (
        message.type === 'system' &&
        'subtype' in message &&
        (message as any).subtype === 'init'
      ) {
        const msg = message as any

        // Cache on client for future disallowedTools resolution
        if (msg.tools) client.sdkTools = msg.tools

        const result: SdkInitInfo = {
          tools: msg.tools || [],
          sdkMcpServers: msg.mcp_servers || [],
          sdkSkills: msg.skills || [],
        }

        // Got init — kill subprocess immediately (no API call made yet)
        abortController.abort()
        try { stream.close() } catch { /* already closing */ }
        return result
      }
    }

    return null
  } catch {
    return null
  }
}

// Execute a query with Claude SDK
export async function* executeQuery(
  client: ClientState,
  prompt: string,
  callbacks: {
    onTextDelta: (text: string) => void
    onThinkingDelta: (thinking: string) => void
    onToolUse: (toolName: string, toolId: string, input: unknown) => void
    onToolResult: (toolId: string, content: string, isError: boolean) => void
    onSessionInit: (sessionId: string) => void
    onPermissionRequest: (requestId: string, toolName: string, input: unknown, reason: string) => void
    onUsage: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) => void
  },
  images?: ImageAttachment[],
  enabledMcps?: string[],
  disabledSdkServers?: string[],
  disabledSkills?: string[],
): AsyncGenerator<{ type: string; data?: unknown }> {
  // Get default model configuration from models.json
  const modelConfig = getDefaultModelConfig()

  if (!modelConfig) {
    throw new Error(
      'No default model configured. Please complete the setup wizard to add a model.'
    )
  }

  const queryEnv = buildQueryEnv(modelConfig)

  const abortController = new AbortController()
  client.activeQuery = { abort: abortController }

  // Update project state if in a project
  if (client.projectId) {
    const project = getOrCreateProjectState(client.projectId)
    project.activeQuery = client.activeQuery
  }

  // Reset accumulation
  client.accumulatingText = ''
  client.accumulatingThinking = ''
  client.currentToolCalls = []
  client.currentCostUsd = undefined
  client.currentDurationMs = undefined

  const queryUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }

  // Build options via shared builder (testable independently)
  const isYolo = client.permissionMode === 'bypassPermissions'
  const options = buildQueryOptions(client, queryEnv, enabledMcps, disabledSdkServers, disabledSkills)
  options.abortController = abortController

  // Set up canUseTool for permission handling
  let reqCounter = 0
  options.canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal
      decisionReason?: string
      toolUseID: string
      updateToolInput?: (input: Record<string, unknown>) => void
    }
  ) => {
    // Auto-inject context for cron tools
    if (toolName === 'mcp__cron__cron_create') {
      const updatedInput = {
        ...input,
        projectId: client.projectId,
        clientId: client.clientId,
        sessionId: client.sessionId,
      }
      opts.updateToolInput?.(updatedInput)
      console.log(`[canUseTool] Injected context into ${toolName}:`, {
        projectId: client.projectId,
        clientId: client.clientId,
      })
    }

    // In bypass mode, auto-approve
    if (isYolo) {
      return { behavior: 'allow' }
    }

    // In normal mode, request permission
    const requestId = `perm-${Date.now()}-${++reqCounter}`

    callbacks.onPermissionRequest(
      requestId,
      toolName,
      input,
      opts.decisionReason || `Allow ${toolName}?`
    )

    // Wait for response
    return new Promise((resolve) => {
      client.pendingPermissions.set(requestId, { resolve })

      // Resolve on abort
      const onAbort = () => {
        client.pendingPermissions.delete(requestId)
        resolve({ behavior: 'deny', message: 'Aborted' })
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // Capture stderr from Claude Code process
  options.stderr = (data: string) => {
    console.error(`[ClaudeAdapter:stderr] ${data.trimEnd()}`)
  }

  // Set model: prefer client override, then modelId from config, then name for custom providers
  if (client.model) {
    options.model = client.model
  } else if (modelConfig.modelId) {
    options.model = modelConfig.modelId
  } else if (modelConfig.provider === 'custom') {
    // For custom providers without explicit modelId, use the name as fallback
    options.model = modelConfig.name
  }

  const isResuming = !!options.resume

  try {
    console.log(`[ClaudeAdapter] Starting query for project ${client.projectId || 'unknown'}...`)
    console.log(`  CWD: ${client.cwd}`)
    console.log(`  Session: ${client.sessionId || 'new'}`)
    console.log(`  Using model: ${modelConfig.name} (${modelConfig.provider})`)
    console.log(`  Model ID: ${options.model}`)
    console.log(`  Permission mode: ${client.permissionMode}`)
    console.log(`  CLAUDE_CONFIG_DIR: ${queryEnv.CLAUDE_CONFIG_DIR || '(default ~/.claude)'}`)
    console.log(`  Auth: ${queryEnv.ANTHROPIC_API_KEY ? 'API key (' + queryEnv.ANTHROPIC_API_KEY.slice(0, 10) + '...)' : 'CLI OAuth (default keychain)'}`)
    console.log(`  ANTHROPIC_BASE_URL: ${queryEnv.ANTHROPIC_BASE_URL || 'default'}`)

    // Set cron query context so cron_create can reliably access project/session info
    // (fallback for when canUseTool's updateToolInput is unavailable)
    setCronQueryContext({
      projectId: client.projectId,
      clientId: client.clientId,
      sessionId: client.sessionId,
    })

    console.log(`[ClaudeAdapter] Spawning SDK query for project ${client.projectId}...`)
    const sdkPrompt = buildPrompt(prompt, images, client.sessionId)
    const stream = query({ prompt: sdkPrompt, options: options as any })
    console.log(`[ClaudeAdapter] SDK query spawned for project ${client.projectId}`)

    // Store the Query object for forceful close on abort
    if (client.activeQuery) {
      client.activeQuery.queryObj = stream
    }

    let messageCount = 0
    for await (const message of stream) {
      if (messageCount === 0) {
        console.log(`[ClaudeAdapter] First message received for project ${client.projectId}: ${message.type}`)
      }
      messageCount++
      // Capture sessionId from init
      if (
        message.type === 'system' &&
        'subtype' in message &&
        message.subtype === 'init'
      ) {
        const newSessionId = (message as any).session_id
        client.sessionId = newSessionId
        client.lastActivity = Date.now()

        // Cache SDK tools list for disallowedTools resolution in future queries
        if ((message as any).tools) {
          client.sdkTools = (message as any).tools
        }

        // Update project state
        if (client.projectId) {
          const project = getOrCreateProjectState(client.projectId)
          project.sessionId = newSessionId
          project.lastActivity = Date.now()
        }

        // Update cron query context with the new sessionId
        setCronQueryContext({
          projectId: client.projectId,
          clientId: client.clientId,
          sessionId: newSessionId,
        })

        callbacks.onSessionInit(newSessionId)

        // Cache models from stream
        if (!cachedModels) {
          stream
            .supportedModels()
            .then((models) => {
              cachedModels = models as ModelInfo[]
            })
            .catch(() => {})
        }

        // Track session status
        if (client.sessionId) {
          sessionStatuses.set(client.sessionId, {
            sessionId: client.sessionId,
            cwd: client.cwd,
            status: 'processing',
            lastActivity: client.lastActivity,
            clientId: client.clientId,
          })
        }

        // Yield init message (only if not resuming)
        if (!isResuming) {
          yield {
            type: 'system_init',
            data: {
              sessionId: newSessionId,
              model: (message as any).model,
              tools: (message as any).tools,
              sdkMcpServers: (message as any).mcp_servers,
              sdkSkills: (message as any).skills,
            },
          }
        }
      }

      // Extract token usage
      if (message.type === 'assistant') {
        const usage = (message as any).message?.usage
        if (usage) {
          queryUsage.inputTokens += usage.input_tokens || 0
          queryUsage.outputTokens += usage.output_tokens || 0
          queryUsage.cacheReadTokens += usage.cache_read_input_tokens || 0
          queryUsage.cacheCreationTokens +=
            usage.cache_creation_input_tokens || 0
          callbacks.onUsage({ ...queryUsage })
        }
      }

      // Process message and yield events
      yield* processMessage(message, client, callbacks)
    }
    console.log(`[ClaudeAdapter] Stream completed for project ${client.projectId}, ${messageCount} messages`)
  } catch (err: any) {
    const isAbort =
      err.name === 'AbortError' ||
      abortController.signal.aborted ||
      (err.message && err.message.includes('aborted'))
    if (!isAbort) {
      // If resume failed (process exited with code 1), retry without resume
      if (
        isResuming &&
        err.message?.includes('exited with code 1')
      ) {
        console.warn(`[ClaudeAdapter] Resume failed for session ${client.sessionId}, retrying without resume...`)
        client.sessionId = undefined
        // Clear project state session too
        if (client.projectId) {
          const project = getOrCreateProjectState(client.projectId)
          project.sessionId = undefined
        }
        // Retry without resume — yield from recursive call
        yield* executeQuery(client, prompt, callbacks, images)
        return
      }
      console.error(`[ClaudeAdapter] Query error for project ${client.projectId}:`, err)
      throw err
    } else {
      console.log(`[ClaudeAdapter] Query aborted for project ${client.projectId}`)
    }
  } finally {
    console.log(`[ClaudeAdapter] Cleaning up query for project ${client.projectId}`)
    // Clear active query
    client.activeQuery = null
    if (client.projectId) {
      const project = getOrCreateProjectState(client.projectId)
      project.activeQuery = null
    }

    // Update session status
    if (client.sessionId) {
      const status = sessionStatuses.get(client.sessionId)
      if (status) {
        status.status = 'idle'
        status.lastActivity = Date.now()
      }
    }
  }
}

// Process SDK message and yield events
async function* processMessage(
  message: SDKMessage,
  client: ClientState,
  callbacks: {
    onTextDelta: (text: string) => void
    onThinkingDelta: (thinking: string) => void
    onToolUse: (toolName: string, toolId: string, input: unknown) => void
    onToolResult: (toolId: string, content: string, isError: boolean) => void
  }
): AsyncGenerator<{ type: string; data?: unknown }> {
  switch (message.type) {
    case 'system': {
      if ('subtype' in message && message.subtype === 'compact_boundary') {
        yield { type: 'compact' }
      }
      break
    }

    case 'assistant': {
      const content = (message as any).message?.content
      if (!content) break

      // With includePartialMessages, assistant messages contain the FULL accumulated
      // content (snapshots), not deltas. stream_event handles real-time streaming.
      // Here we only:
      // 1. Update accumulated text/thinking snapshots (for final message storage)
      // 2. Process tool_use blocks (which need immediate callback handling)
      let fullText = ''
      let fullThinking = ''
      for (const block of content) {
        if (block.type === 'text') {
          fullText += block.text
        } else if (block.type === 'thinking') {
          fullThinking += block.thinking
        } else if (block.type === 'tool_use') {
          // Handle AskUserQuestion specially
          if (
            block.name === 'AskUserQuestion' &&
            block.input &&
            (block.input as any).questions
          ) {
            yield {
              type: 'ask_user_question',
              data: {
                toolId: block.id,
                questions: (block.input as any).questions,
              },
            }
          }

          // Only emit tool_use if we haven't seen this tool call before
          const alreadyTracked = client.currentToolCalls?.some(tc => tc.id === block.id)
          if (!alreadyTracked) {
            // Store tool call
            client.currentToolCalls = client.currentToolCalls || []
            client.currentToolCalls.push({
              name: block.name,
              id: block.id,
              input: block.input,
            })

            callbacks.onToolUse(block.name, block.id, block.input)
            yield {
              type: 'tool_use',
              data: { toolName: block.name, toolId: block.id, input: block.input },
            }
          }
        }
      }
      // Update snapshots (replace, not append) for final message storage
      if (fullText) client.accumulatingText = fullText
      if (fullThinking) client.accumulatingThinking = fullThinking
      break
    }

    case 'user': {
      const content = (message as any).message?.content
      if (!Array.isArray(content)) break

      for (const block of content) {
        if (block.type === 'tool_result') {
          // Update tool call with result
          if (client.currentToolCalls) {
            const toolCall = client.currentToolCalls.find(
              (tc) => tc.id === block.tool_use_id
            )
            if (toolCall) {
              toolCall.result =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
              toolCall.isError = block.is_error || false
            }
          }

          const contentStr =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)

          callbacks.onToolResult(block.tool_use_id, contentStr, block.is_error || false)
          yield {
            type: 'tool_result',
            data: {
              toolId: block.tool_use_id,
              content: contentStr,
              isError: block.is_error || false,
            },
          }
        }
      }
      break
    }

    case 'result': {
      const result = message as any
      console.log(`[ClaudeAdapter] Result message:`, JSON.stringify({
        subtype: result.subtype,
        is_error: result.is_error,
        result: result.result,
        duration_ms: result.duration_ms,
      }))
      client.currentCostUsd = result.total_cost_usd
      client.currentDurationMs = result.duration_ms

      yield {
        type: 'result',
        data: {
          subtype: result.subtype,
          costUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          result: result.result,
          isError: result.is_error,
        },
      }
      break
    }

    case 'stream_event': {
      const event = (message as any).event
      if (!event) break

      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          client.accumulatingText += event.delta.text
          callbacks.onTextDelta(event.delta.text)
          yield { type: 'text_delta', data: { text: event.delta.text } }
        } else if (event.delta?.type === 'thinking_delta') {
          client.accumulatingThinking += event.delta.thinking
          callbacks.onThinkingDelta(event.delta.thinking)
          yield {
            type: 'thinking_delta',
            data: { thinking: event.delta.thinking },
          }
        }
      }
      break
    }
  }
}

// Store assistant message to project state
export function storeAssistantMessage(client: ClientState): ChatMessage | null {
  if (
    !client.accumulatingText &&
    !client.accumulatingThinking &&
    (!client.currentToolCalls || client.currentToolCalls.length === 0)
  ) {
    return null
  }

  const assistantMessage: ChatMessage = {
    id: genId(),
    role: 'assistant',
    content: client.accumulatingText,
    thinking: client.accumulatingThinking || undefined,
    toolCalls:
      client.currentToolCalls && client.currentToolCalls.length > 0
        ? [...client.currentToolCalls]
        : undefined,
    costUsd: client.currentCostUsd,
    durationMs: client.currentDurationMs,
    timestamp: Date.now(),
  }

  if (client.projectId) {
    const project = getOrCreateProjectState(client.projectId)
    project.messages.push(assistantMessage)
  }

  // Reset accumulation
  client.accumulatingText = ''
  client.accumulatingThinking = ''
  client.currentToolCalls = []
  client.currentCostUsd = undefined
  client.currentDurationMs = undefined

  return assistantMessage
}

// Handle permission response
export function handlePermissionResponse(
  client: ClientState,
  requestId: string,
  allow: boolean
): boolean {
  const pending = client.pendingPermissions.get(requestId)
  if (!pending) return false

  pending.resolve({
    behavior: allow ? 'allow' : 'deny',
    message: allow ? undefined : 'User denied permission',
  })
  client.pendingPermissions.delete(requestId)
  return true
}

// Abort active query
export function abortQuery(client: ClientState): boolean {
  if (client.activeQuery) {
    // Signal abort via AbortController
    client.activeQuery.abort.abort()
    // Forcefully close the SDK subprocess if available
    if (client.activeQuery.queryObj) {
      try {
        client.activeQuery.queryObj.close()
      } catch {
        // Ignore close errors (process may already be dead)
      }
    }
    client.activeQuery = null

    if (client.projectId) {
      const project = getOrCreateProjectState(client.projectId)
      project.activeQuery = null
    }

    return true
  }
  return false
}

// Clean up inactive clients and projects
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
setInterval(() => {
  const now = Date.now()

  // Clean up inactive clients
  for (const [id, client] of clients) {
    if (!client.activeQuery && now - client.lastActivity > CLEANUP_INTERVAL_MS) {
      clients.delete(id)
      console.log(`[Cleanup] Removed inactive client: ${id}`)
    }
  }

  // Clean up session statuses
  for (const [sessionId, status] of sessionStatuses) {
    if (now - status.lastActivity > CLEANUP_INTERVAL_MS) {
      sessionStatuses.delete(sessionId)
    }
  }

  // Clean up inactive projects
  for (const [key, project] of projects) {
    const hasConnectedClients = Array.from(clients.values()).some(
      (c) => c.projectId === project.projectId
    )
    if (!hasConnectedClients && !project.activeQuery) {
      projects.delete(key)
      console.log(`[Cleanup] Removed inactive project: ${key}`)
    }
  }
}, CLEANUP_INTERVAL_MS)
