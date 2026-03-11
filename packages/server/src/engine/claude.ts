// ClaudeAdapter — Claude Code SDK implementation of EngineAdapter
//
// Wraps @anthropic-ai/claude-agent-sdk to conform to the EngineAdapter interface.

import { query, type SDKMessage, type Query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { chromeTools } from '../mcp/chrome/index.js'
import type {
  ChatMessage,
  Question,
  ModelInfo,
  PermissionMode,
} from '@codeclaws/shared'

// Re-export types for convenience
export type { ChatMessage, Question, ModelInfo, PermissionMode }

// Engine configuration from models.json
export interface ModelConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'google' | 'custom'
  modelId?: string   // Actual model identifier for the API (e.g., "claude-sonnet-4-20250514")
  apiKey?: string
  baseUrl?: string
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
const CONFIG_DIR = path.join(os.homedir(), '.codeclaws')
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json')

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
      cwd: process.cwd(),
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

// Load API key from config directory
function loadApiKeyFromConfigDir(configDir: string): string | undefined {
  try {
    const configPath = path.join(configDir, 'config.json')
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8')
      const config = JSON.parse(configContent)
      if (config.apiKey) {
        return config.apiKey
      }
    }
  } catch (err) {
    console.log(`[Config] Failed to load API key from ${configDir}:`, err)
  }
  return undefined
}

// Apply model configuration to environment
function applyModelConfig(config: ModelConfig): void {
  // Set config directory
  const configDir = config.configDir || path.join(os.homedir(), '.codeclaws')
  process.env.CLAUDE_CONFIG_DIR = configDir

  // Set API key
  const apiKey = config.apiKey || loadApiKeyFromConfigDir(configDir) || process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    process.env.ANTHROPIC_API_KEY = apiKey
  }

  // Set base URL
  if (config.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = config.baseUrl
  } else if (process.env.ANTHROPIC_BASE_URL) {
    // Keep existing
  }

  console.log(`[ClaudeAdapter] Applied config for model: ${config.id}`)
  console.log(`  Config dir: ${configDir}`)
  console.log(`  Base URL: ${process.env.ANTHROPIC_BASE_URL || 'default'}`)
  console.log(`  API Key: ${apiKey ? apiKey.slice(0, 10) + '...' : 'not set'}`)
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
  }
): AsyncGenerator<{ type: string; data?: unknown }> {
  // Get default model configuration from models.json
  const modelConfig = getDefaultModelConfig()

  if (!modelConfig) {
    throw new Error(
      'No default model configured. Please complete the setup wizard to add a model.'
    )
  }

  // Build per-query env vars (avoid mutating process.env for concurrent query safety)
  const configDir = modelConfig.configDir || path.join(os.homedir(), '.codeclaws')

  // Get API key from model config or fallback
  const apiKey = modelConfig.apiKey || loadApiKeyFromConfigDir(configDir) || process.env.ANTHROPIC_API_KEY

  // Check if API key is configured
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured. Please set it in the model configuration or set the ANTHROPIC_API_KEY environment variable.'
    )
  }

  // Per-query env: inherit process.env but override with model-specific config
  const queryEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: apiKey,
  }
  if (modelConfig.baseUrl) {
    queryEnv.ANTHROPIC_BASE_URL = modelConfig.baseUrl
  }

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

  // Build options (matching claude-remote-app)
  const isYolo = client.permissionMode === 'bypassPermissions'
  const options: Record<string, unknown> = {
    abortController,
    cwd: client.cwd,
    env: queryEnv,
    permissionMode: isYolo ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: isYolo,
    includePartialMessages: true,
  }

  // Set up MCP servers (cron, push, chrome)
  const chromeMcp = createSdkMcpServer({
    name: 'chrome',
    tools: chromeTools,
  })

  // MCP servers — cron & push temporarily disabled, chrome enabled
  options.mcpServers = {
    // cron: {
    //   type: 'stdio',
    //   command: 'npx',
    //   args: ['tsx', path.join(process.cwd(), 'src/mcp/cron/index.ts')],
    //   env: {
    //     CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.codeclaws'),
    //     PATH: process.env.PATH || '',
    //   },
    // },
    // push: {
    //   type: 'stdio',
    //   command: 'npx',
    //   args: ['tsx', path.join(process.cwd(), 'src/mcp/push/index.ts')],
    //   env: {
    //     PATH: process.env.PATH || '',
    //   },
    // },
    chrome: chromeMcp,
  }

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

  // Set model: prefer client override, then modelId from config, then name for custom providers
  if (client.model) {
    options.model = client.model
  } else if (modelConfig.modelId) {
    options.model = modelConfig.modelId
  } else if (modelConfig.provider === 'custom') {
    // For custom providers without explicit modelId, use the name as fallback
    options.model = modelConfig.name
  }

  // Set session resume if available
  if (client.sessionId) {
    options.resume = client.sessionId
  }

  const isResuming = !!options.resume

  try {
    console.log(`[ClaudeAdapter] Starting query for project ${client.projectId || 'unknown'}...`)
    console.log(`  CWD: ${client.cwd}`)
    console.log(`  Session: ${client.sessionId || 'new'}`)
    console.log(`  Using model: ${modelConfig.name} (${modelConfig.provider})`)
    console.log(`  Model ID: ${options.model}`)
    console.log(`  Permission mode: ${client.permissionMode}`)
    console.log(`  CLAUDE_CONFIG_DIR: ${queryEnv.CLAUDE_CONFIG_DIR}`)
    console.log(`  ANTHROPIC_API_KEY: ${(queryEnv.ANTHROPIC_API_KEY || '').slice(0, 10)}...`)
    console.log(`  ANTHROPIC_BASE_URL: ${queryEnv.ANTHROPIC_BASE_URL || 'default'}`)

    console.log(`[ClaudeAdapter] Spawning SDK query for project ${client.projectId}...`)
    const stream = query({ prompt, options: options as any })
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

        // Update project state
        if (client.projectId) {
          const project = getOrCreateProjectState(client.projectId)
          project.sessionId = newSessionId
          project.lastActivity = Date.now()
        }

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
