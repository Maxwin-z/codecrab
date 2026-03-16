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
  SdkSkill,
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

// Look up project from projects.json
interface ProjectInfo {
  id: string
  name: string
  path: string
  icon: string
}

function getProjectInfo(projectId: string): ProjectInfo | null {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf-8')
    const projects: ProjectInfo[] = JSON.parse(data)
    return projects.find((p) => p.id === projectId) || null
  } catch {
    return null
  }
}

function getProjectPath(projectId: string): string | null {
  return getProjectInfo(projectId)?.path || null
}

// Build log prefix: [emoji name] or [ClaudeAdapter] as fallback
function logPrefix(projectId?: string): string {
  if (!projectId) return '[ClaudeAdapter]'
  const info = getProjectInfo(projectId)
  if (info?.icon && info?.name) return `[${info.icon} ${info.name}]`
  return `[ClaudeAdapter]`
}

// ── ANSI colors for terminal output ──────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgCyan: '\x1b[46m',
  bgMagenta: '\x1b[45m',
}

// Formatted SDK message logger
// Accumulates content_block_delta partials and prints condensed output
interface StreamLogState {
  /** Accumulating input_json_delta partials per content block index */
  inputJsonAccum: Map<number, string>
  /** Track current tool being streamed */
  currentToolName?: string
  /** Track text_delta accumulation */
  textAccum: string
  /** Track thinking_delta accumulation */
  thinkingAccum: string
}

function createStreamLogState(): StreamLogState {
  return {
    inputJsonAccum: new Map(),
    textAccum: '',
    thinkingAccum: '',
  }
}

function logSdkMessage(tag: string, msg: any, state: StreamLogState): void {
  const type = msg.type

  switch (type) {
    case 'system': {
      if (msg.subtype === 'init') {
        const toolCount = msg.tools?.length || 0
        const mcps = msg.mcp_servers || []
        const mcpList = mcps.map((s: any) => {
          const st = s.status === 'connected' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
          return `${st}${s.name}`
        }).join('  ')
        const skillList = (msg.skills || []).join(', ')
        const agents = (msg.agents || []).join(', ')
        const plugins = (msg.plugins || []).map((p: any) => p.name).join(', ')
        console.log(`${tag} ${C.green}${C.bold}⚡ init${C.reset}`)
        console.log(`${tag}   ${C.dim}model:${C.reset}       ${C.bold}${msg.model}${C.reset}`)
        console.log(`${tag}   ${C.dim}session:${C.reset}     ${msg.session_id}`)
        console.log(`${tag}   ${C.dim}permission:${C.reset}  ${msg.permissionMode}`)
        console.log(`${tag}   ${C.dim}tools (${toolCount}):${C.reset}  ${C.dim}${(msg.tools || []).slice(0, 20).join(', ')}${toolCount > 20 ? ` …+${toolCount - 20}` : ''}${C.reset}`)
        console.log(`${tag}   ${C.dim}mcps:${C.reset}        ${mcpList || 'none'}`)
        if (skillList) console.log(`${tag}   ${C.dim}skills:${C.reset}      ${skillList}`)
        if (agents) console.log(`${tag}   ${C.dim}agents:${C.reset}      ${agents}`)
        if (plugins) console.log(`${tag}   ${C.dim}plugins:${C.reset}     ${plugins}`)
        console.log(`${tag}   ${C.dim}version:${C.reset}     ${msg.claude_code_version || '?'}`)
      } else if (msg.subtype === 'compact_boundary') {
        console.log(`${tag} ${C.dim}── compact boundary ──${C.reset}`)
      } else if (msg.subtype === 'task_started') {
        const parentId = msg.tool_use_id ? `  tool=${msg.tool_use_id.slice(-8)}` : ''
        console.log(`${tag} ${C.magenta}${C.bold}🚀 task_started${C.reset}  task=${msg.task_id}${parentId}  ${C.dim}${msg.description || ''}${C.reset}`)
      } else if (msg.subtype === 'task_progress') {
        const tokens = msg.usage?.total_tokens || '?'
        const tools = msg.usage?.tool_uses || '?'
        console.log(`${tag} ${C.magenta}⏳ task_progress${C.reset}  task=${msg.task_id}  tokens=${tokens}  tools=${tools}  ${C.dim}${msg.summary || msg.description || ''}${C.reset}`)
      } else if (msg.subtype === 'task_notification') {
        const taskStatus = msg.status === 'completed' ? `${C.green}✓ completed${C.reset}` : `${C.red}✗ ${msg.status}${C.reset}`
        console.log(`${tag} ${C.magenta}${C.bold}🏁 task_notification${C.reset}  task=${msg.task_id}  ${taskStatus}  ${C.dim}${msg.summary || ''}${C.reset}`)
      } else {
        console.log(`${tag} ${C.dim}system: ${msg.subtype || 'unknown'}${C.reset}`)
      }
      break
    }

    case 'stream_event': {
      const evt = msg.event
      if (!evt) break

      switch (evt.type) {
        case 'message_start': {
          const m = evt.message
          const u = m?.usage
          if (u) {
            const cacheEph = u.cache_creation
            const ephParts: string[] = []
            if (cacheEph?.ephemeral_5m_input_tokens) ephParts.push(`5m=${cacheEph.ephemeral_5m_input_tokens}`)
            if (cacheEph?.ephemeral_1h_input_tokens) ephParts.push(`1h=${cacheEph.ephemeral_1h_input_tokens}`)
            const ephStr = ephParts.length > 0 ? `  eph=[${ephParts.join(' ')}]` : ''
            console.log(`${tag} ${C.blue}▶ message_start${C.reset}  ${C.dim}id=${m.id}  model=${m.model}${C.reset}`)
            console.log(`${tag}   ${C.dim}tokens: in=${u.input_tokens || 0}  out=${u.output_tokens || 0}  cache_read=${u.cache_read_input_tokens || 0}  cache_create=${u.cache_creation_input_tokens || 0}${ephStr}${C.reset}`)
            if (u.service_tier) console.log(`${tag}   ${C.dim}tier=${u.service_tier}${C.reset}`)
          } else {
            console.log(`${tag} ${C.blue}▶ message_start${C.reset}  ${C.dim}id=${m?.id}${C.reset}`)
          }
          break
        }
        case 'content_block_start': {
          const block = evt.content_block
          if (block?.type === 'tool_use') {
            state.currentToolName = block.name
            state.inputJsonAccum.set(evt.index, '')
            const caller = block.caller?.type ? `  caller=${block.caller.type}` : ''
            console.log(`${tag} ${C.yellow}🔧 tool_use[${evt.index}]${C.reset} ${C.bold}${block.name}${C.reset}  ${C.dim}id=${block.id}${caller}${C.reset}`)
          } else if (block?.type === 'text') {
            state.textAccum = ''
            console.log(`${tag} ${C.cyan}📝 text[${evt.index}]${C.reset}`)
          } else if (block?.type === 'thinking') {
            state.thinkingAccum = ''
            console.log(`${tag} ${C.magenta}💭 thinking[${evt.index}]${C.reset}`)
          } else {
            console.log(`${tag} ${C.dim}block_start[${evt.index}] type=${block?.type}${C.reset}`)
          }
          break
        }
        case 'content_block_delta': {
          const delta = evt.delta
          if (!delta) break
          if (delta.type === 'input_json_delta') {
            const prev = state.inputJsonAccum.get(evt.index) || ''
            state.inputJsonAccum.set(evt.index, prev + (delta.partial_json || ''))
          } else if (delta.type === 'text_delta') {
            state.textAccum += delta.text || ''
          } else if (delta.type === 'thinking_delta') {
            state.thinkingAccum += delta.thinking || ''
          }
          // Accumulate silently — printed on content_block_stop
          break
        }
        case 'content_block_stop': {
          // Print accumulated tool input
          const accum = state.inputJsonAccum.get(evt.index)
          if (accum !== undefined) {
            try {
              const parsed = JSON.parse(accum)
              for (const [k, v] of Object.entries(parsed)) {
                const val = typeof v === 'string' ? v : JSON.stringify(v)
                // Multi-line values: indent each line
                if (typeof val === 'string' && val.includes('\n')) {
                  console.log(`${tag}   ${C.yellow}${k}:${C.reset}`)
                  for (const line of val.split('\n').slice(0, 15)) {
                    console.log(`${tag}     ${C.dim}${line}${C.reset}`)
                  }
                  if (val.split('\n').length > 15) {
                    console.log(`${tag}     ${C.dim}…(${val.split('\n').length - 15} more lines)${C.reset}`)
                  }
                } else {
                  const display = val.length > 200 ? val.slice(0, 200) + '…' : val
                  console.log(`${tag}   ${C.yellow}${k}:${C.reset} ${C.dim}${display}${C.reset}`)
                }
              }
            } catch {
              console.log(`${tag}   ${C.dim}raw: ${accum.slice(0, 300)}${C.reset}`)
            }
            state.inputJsonAccum.delete(evt.index)
          }
          // Print accumulated text
          if (state.textAccum) {
            const lines = state.textAccum.split('\n')
            const preview = lines.slice(0, 8).join('\n')
            const suffix = lines.length > 8 ? `\n${tag}     ${C.dim}…(${lines.length - 8} more lines, ${state.textAccum.length} chars total)${C.reset}` : ''
            console.log(`${tag}   ${C.cyan}text (${state.textAccum.length} chars):${C.reset}`)
            for (const line of preview.split('\n')) {
              console.log(`${tag}     ${C.dim}${line}${C.reset}`)
            }
            if (suffix) console.log(suffix)
            state.textAccum = ''
          }
          // Print accumulated thinking
          if (state.thinkingAccum) {
            const lines = state.thinkingAccum.split('\n')
            const preview = lines.slice(0, 5).join('\n')
            const suffix = lines.length > 5 ? `\n${tag}     ${C.dim}…(${lines.length - 5} more lines, ${state.thinkingAccum.length} chars total)${C.reset}` : ''
            console.log(`${tag}   ${C.magenta}thinking (${state.thinkingAccum.length} chars):${C.reset}`)
            for (const line of preview.split('\n')) {
              console.log(`${tag}     ${C.magenta}${line}${C.reset}`)
            }
            if (suffix) console.log(suffix)
            state.thinkingAccum = ''
          }
          break
        }
        case 'message_delta': {
          const stop = evt.delta?.stop_reason
          const outTokens = evt.usage?.output_tokens
          const cm = evt.context_management
          const edits = cm?.applied_edits?.length ? `  context_edits=${cm.applied_edits.length}` : ''
          console.log(`${tag} ${C.blue}■ message_done${C.reset}  stop=${C.bold}${stop || 'none'}${C.reset}  out_tokens=${outTokens || '?'}${edits}`)
          break
        }
        case 'message_stop': {
          // Silent — message_delta already covers it
          break
        }
        default: {
          console.log(`${tag} ${C.dim}stream: ${evt.type}${C.reset}`)
        }
      }
      break
    }

    case 'assistant': {
      const m = msg.message
      const content = m?.content
      if (!content) break
      const usage = m?.usage
      const cm = m?.context_management
      console.log(`${tag} ${C.green}${C.bold}◀ assistant${C.reset}  ${C.dim}id=${m.id}${C.reset}`)
      for (const block of content) {
        if (block.type === 'tool_use') {
          const inputPreview = JSON.stringify(block.input)
          const display = inputPreview.length > 200 ? inputPreview.slice(0, 200) + '…' : inputPreview
          console.log(`${tag}   ${C.yellow}🔧 ${block.name}${C.reset}  ${C.dim}id=${block.id}${C.reset}`)
          console.log(`${tag}     ${C.dim}${display}${C.reset}`)
        } else if (block.type === 'text') {
          const lines = (block.text || '').split('\n')
          const preview = lines.slice(0, 6)
          console.log(`${tag}   ${C.cyan}📝 text (${(block.text || '').length} chars):${C.reset}`)
          for (const line of preview) {
            console.log(`${tag}     ${C.dim}${line}${C.reset}`)
          }
          if (lines.length > 6) console.log(`${tag}     ${C.dim}…(${lines.length - 6} more lines)${C.reset}`)
        } else if (block.type === 'thinking') {
          const lines = (block.thinking || '').split('\n')
          const preview = lines.slice(0, 4)
          console.log(`${tag}   ${C.magenta}💭 thinking (${(block.thinking || '').length} chars):${C.reset}`)
          for (const line of preview) {
            console.log(`${tag}     ${C.magenta}${line}${C.reset}`)
          }
          if (lines.length > 4) console.log(`${tag}     ${C.magenta}…(${lines.length - 4} more lines)${C.reset}`)
        }
      }
      if (usage) {
        console.log(`${tag}   ${C.dim}tokens: in=${usage.input_tokens || 0}  out=${usage.output_tokens || 0}  cache_read=${usage.cache_read_input_tokens || 0}  cache_create=${usage.cache_creation_input_tokens || 0}${C.reset}`)
      }
      if (cm?.applied_edits?.length) {
        console.log(`${tag}   ${C.dim}context_edits: ${cm.applied_edits.length}${C.reset}`)
      }
      break
    }

    case 'user': {
      const content = msg.message?.content
      if (!Array.isArray(content)) break
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolResult = msg.tool_use_result
          const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          const lines = resultStr.split('\n')
          const errTag = block.is_error ? `${C.red} ERROR${C.reset}` : ''
          console.log(`${tag} ${C.yellow}◀ tool_result${C.reset}${errTag}  ${C.dim}tool_use_id=${block.tool_use_id}${C.reset}`)
          // Show output lines (up to 12)
          const preview = lines.slice(0, 12)
          for (const line of preview) {
            console.log(`${tag}   ${C.dim}${line}${C.reset}`)
          }
          if (lines.length > 12) {
            console.log(`${tag}   ${C.dim}…(${lines.length - 12} more lines, ${resultStr.length} chars total)${C.reset}`)
          }
          // Show stderr if present
          if (toolResult?.stderr) {
            console.log(`${tag}   ${C.red}stderr: ${toolResult.stderr.slice(0, 200)}${C.reset}`)
          }
          if (toolResult?.interrupted) {
            console.log(`${tag}   ${C.red}⚠ interrupted${C.reset}`)
          }
        }
      }
      break
    }

    case 'result': {
      const cost = msg.total_cost_usd != null ? `$${msg.total_cost_usd.toFixed(4)}` : '?'
      const dur = msg.duration_ms != null ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '?'
      const err = msg.is_error ? `  ${C.red}ERROR${C.reset}` : ''
      const sub = msg.subtype ? `  subtype=${msg.subtype}` : ''
      console.log(`${tag} ${C.green}${C.bold}✅ result${C.reset}  cost=${C.bold}${cost}${C.reset}  duration=${C.bold}${dur}${C.reset}${sub}${err}`)
      if (msg.result) {
        const resultStr = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result)
        const lines = resultStr.split('\n').slice(0, 5)
        for (const line of lines) {
          console.log(`${tag}   ${C.dim}${line.slice(0, 200)}${C.reset}`)
        }
      }
      break
    }

    case 'rate_limit_event': {
      const info = msg.rate_limit_info
      if (!info) break
      const status = info.status === 'allowed' ? `${C.green}✓ allowed${C.reset}` : `${C.red}✗ ${info.status}${C.reset}`
      const resets = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '?'
      const overage = info.isUsingOverage ? `${C.yellow}overage=on${C.reset}` : ''
      console.log(`${tag} ${C.dim}⏱ rate_limit${C.reset}  ${status}  type=${info.rateLimitType || '?'}  resets=${resets}  ${overage}`)
      break
    }

    case 'tool_progress': {
      const parentId = msg.parent_tool_use_id ? `  parent=${msg.parent_tool_use_id.slice(-8)}` : ''
      console.log(`${tag} ${C.dim}⏱ tool_progress${C.reset}  ${msg.tool_name}  ${msg.elapsed_time_seconds}s${parentId}`)
      break
    }

    default: {
      console.log(`${tag} ${C.dim}${type}: ${JSON.stringify(msg).slice(0, 300)}${C.reset}`)
    }
  }
}

// Emit structured SDK log events for each raw SDK message
// These go through logEvent → broadcastToProject → iOS client
function emitSdkLog(msg: any, log: (type: string, detail?: string, data?: Record<string, unknown>, parentToolUseId?: string | null, taskId?: string) => void): void {
  const type = msg.type

  switch (type) {
    case 'system': {
      if (msg.subtype === 'init') {
        const mcps = (msg.mcp_servers || []).map((s: any) => `${s.status === 'connected' ? '✓' : '✗'}${s.name}`).join('  ')
        log('sdk_init', `model: ${msg.model}`, {
          model: msg.model,
          session: msg.session_id,
          permission: msg.permissionMode,
          toolCount: msg.tools?.length || 0,
          tools: (msg.tools || []).slice(0, 20).join(', ') + (msg.tools?.length > 20 ? ` …+${msg.tools.length - 20}` : ''),
          mcps,
          skills: (msg.skills || []).join(', '),
          agents: (msg.agents || []).join(', '),
          plugins: (msg.plugins || []).map((p: any) => p.name).join(', '),
          version: msg.claude_code_version,
        })
      } else if (msg.subtype === 'task_started') {
        log('task_started', msg.description || '', {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          taskType: msg.task_type,
          prompt: msg.prompt,
          description: msg.description,
        }, null, msg.task_id)
      } else if (msg.subtype === 'task_progress') {
        log('task_progress', msg.summary || msg.description || '', {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          description: msg.description,
          lastToolName: msg.last_tool_name,
          summary: msg.summary,
          totalTokens: msg.usage?.total_tokens,
          toolUses: msg.usage?.tool_uses,
          durationMs: msg.usage?.duration_ms,
        }, null, msg.task_id)
      } else if (msg.subtype === 'task_notification') {
        log('task_notification', `${msg.status}: ${msg.summary || ''}`, {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          status: msg.status,
          summary: msg.summary,
          outputFile: msg.output_file,
          totalTokens: msg.usage?.total_tokens,
          toolUses: msg.usage?.tool_uses,
          durationMs: msg.usage?.duration_ms,
        }, null, msg.task_id)
      }
      break
    }

    case 'stream_event': {
      const evt = msg.event
      if (!evt) break
      const streamParent: string | null = msg.parent_tool_use_id ?? null

      switch (evt.type) {
        case 'message_start': {
          const m = evt.message
          const u = m?.usage
          log('message_start', `id=${m?.id}  model=${m?.model}`, {
            messageId: m?.id,
            model: m?.model,
            inputTokens: u?.input_tokens,
            outputTokens: u?.output_tokens,
            cacheReadTokens: u?.cache_read_input_tokens,
            cacheCreateTokens: u?.cache_creation_input_tokens,
            serviceTier: u?.service_tier,
          }, streamParent)
          break
        }
        case 'content_block_start': {
          const block = evt.content_block
          if (block?.type === 'tool_use') {
            log('content_block_start', `tool_use: ${block.name}`, {
              blockType: 'tool_use',
              index: evt.index,
              toolName: block.name,
              toolId: block.id,
              caller: block.caller?.type,
            }, streamParent)
          } else if (block?.type === 'text') {
            log('content_block_start', 'text', { blockType: 'text', index: evt.index }, streamParent)
          } else if (block?.type === 'thinking') {
            log('content_block_start', 'thinking', { blockType: 'thinking', index: evt.index }, streamParent)
          }
          break
        }
        case 'content_block_stop': {
          log('content_block_stop', `block[${evt.index}]`, { index: evt.index }, streamParent)
          break
        }
        case 'message_delta': {
          const stop = evt.delta?.stop_reason
          const outTokens = evt.usage?.output_tokens
          const edits = evt.context_management?.applied_edits?.length
          log('message_done', `stop=${stop || 'none'}  out_tokens=${outTokens || '?'}`, {
            stopReason: stop,
            outputTokens: outTokens,
            contextEdits: edits,
          }, streamParent)
          break
        }
      }
      break
    }

    case 'assistant': {
      const m = msg.message
      const content = m?.content
      if (!content) break
      const usage = m?.usage
      const assistantParent: string | null = msg.parent_tool_use_id ?? null
      // Emit per-block events with full content
      for (const block of content) {
        if (block.type === 'tool_use') {
          const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)
          log('tool_use', `${block.name}`, {
            toolName: block.name,
            toolId: block.id,
            input: inputStr,
          }, assistantParent)
        } else if (block.type === 'text' && block.text) {
          log('text', block.text.length > 200 ? block.text.slice(0, 200) + '…' : block.text, {
            content: block.text,
            length: block.text.length,
          }, assistantParent)
        } else if (block.type === 'thinking' && block.thinking) {
          log('thinking', block.thinking.length > 200 ? block.thinking.slice(0, 200) + '…' : block.thinking, {
            content: block.thinking,
            length: block.thinking.length,
          }, assistantParent)
        }
      }
      // Also emit the overall assistant summary with token usage
      const blockSummary: string[] = []
      for (const block of content) {
        if (block.type === 'tool_use') blockSummary.push(`🔧 ${block.name}`)
        else if (block.type === 'text') blockSummary.push(`📝 text(${(block.text || '').length})`)
        else if (block.type === 'thinking') blockSummary.push(`💭 thinking(${(block.thinking || '').length})`)
      }
      log('assistant', `id=${m.id}  ${blockSummary.join('  ')}`, {
        messageId: m.id,
        blocks: blockSummary.join(', '),
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheReadTokens: usage?.cache_read_input_tokens,
        cacheCreateTokens: usage?.cache_creation_input_tokens,
      }, assistantParent)
      break
    }

    case 'user': {
      const content = msg.message?.content
      if (!Array.isArray(content)) break
      const userParent: string | null = msg.parent_tool_use_id ?? null
      for (const block of content) {
        if (block.type === 'tool_result') {
          const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          log('tool_result', block.is_error ? `Error: ${resultStr.slice(0, 200)}` : resultStr.slice(0, 200), {
            toolUseId: block.tool_use_id,
            content: resultStr,
            isError: block.is_error || false,
            length: resultStr.length,
          }, userParent)
        }
      }
      break
    }

    case 'rate_limit_event': {
      const info = msg.rate_limit_info
      if (!info) break
      const status = info.status === 'allowed' ? '✓ allowed' : `✗ ${info.status}`
      const resets = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '?'
      log('rate_limit', `${status}  type=${info.rateLimitType || '?'}  resets=${resets}`, {
        status: info.status,
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
        isUsingOverage: info.isUsingOverage,
      })
      break
    }

    case 'tool_progress': {
      log('tool_progress', `${msg.tool_name} (${msg.elapsed_time_seconds}s)`, {
        toolUseId: msg.tool_use_id,
        toolName: msg.tool_name,
        elapsedSeconds: msg.elapsed_time_seconds,
        taskId: msg.task_id,
      }, msg.parent_tool_use_id ?? null, msg.task_id)
      break
    }
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

const SUMMARY_INSTRUCTION = `\n[IMPORTANT: After completing your response, you MUST append a brief summary on its own line in exactly this format: [SUMMARY: ...]. This summary will be used as a push notification sent to the user, so write it as a natural, conversational reply to the user's request — as if you're briefly telling them what you did. Use first person, keep it casual and concise (one sentence). For example, if the user asked "check the directory structure", write something like "已查看目录结构，共有14个目录和26个文件". Match the language the user used. Never omit this line.]`

const SUGGESTIONS_INSTRUCTION = `\n[IMPORTANT: After the [SUMMARY] line, you MUST also append exactly 3 suggested next actions in this format: [SUGGESTIONS: suggestion1 | suggestion2 | suggestion3]. Each suggestion is a complete, ready-to-send prompt that the user can use directly WITHOUT any editing. CRITICAL RULES: 1) NEVER use placeholders, ellipsis, or vague references like "某个文件", "具体的XXX", "某个方法" — instead use real names from the conversation context (e.g. "查看 src/utils/auth.ts 的内容" not "查看某个文件的内容"). 2) Each suggestion must be a specific, self-contained instruction — the user should be able to click it and get a meaningful result immediately. 3) Predict what the user would logically do next based on what just happened. For example, after reviewing a project structure, suggest examining specific key files you noticed; after fixing a bug, suggest running tests or checking related code. Keep each under 20 words. Match the user's language. Never omit this line.]`

// Build prompt for SDK: plain string or SDKUserMessage with images
export function buildPrompt(
  prompt: string,
  images?: ImageAttachment[],
  sessionId?: string,
): string | AsyncIterable<SDKUserMessage> {
  const enhancedPrompt = prompt + SUMMARY_INSTRUCTION + SUGGESTIONS_INSTRUCTION

  if (!images || images.length === 0) {
    return enhancedPrompt
  }

  // Build content blocks: images first, then text
  const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
  const contentBlocks: unknown[] = []

  for (const img of images) {
    if (supportedImageTypes.has(img.mediaType)) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          data: img.data,
          media_type: img.mediaType,
        },
      })
    }
    // Skip unsupported media types (video, etc.)
  }

  // If no supported images remain, return plain text
  if (contentBlocks.length === 0) {
    return enhancedPrompt
  }

  contentBlocks.push({
    type: 'text',
    text: enhancedPrompt,
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
    agentProgressSummaries: true,

    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `\n\nYour working directory is ${client.cwd}.` +
        `\n\nIMPORTANT: When running long-lived processes such as servers (http-server, python -m http.server, npm run dev, etc.), ` +
        `you MUST use the Bash tool with run_in_background: true. Never run server processes in the foreground — ` +
        `they will block the session and prevent further interaction. After starting the server in the background, ` +
        `tell the user the URL they can visit.` +
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
export function buildQueryEnv(modelConfig: ModelConfig): Record<string, string | undefined> {
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
  sdkSkills: SdkSkill[]
}

/** Scan a skills directory for SKILL.md frontmatter descriptions.
 *  Reads each <skillsDir>/<name>/SKILL.md and extracts the description field. */
function scanSkillsDir(skillsDir: string, descriptions: Map<string, string>): void {
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (descriptions.has(entry.name)) continue // project-level takes priority
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md')
      try {
        const content = fs.readFileSync(skillFile, 'utf-8')
        // Parse YAML frontmatter: --- ... description: "..." ... ---
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/^description:\s*["']?(.*?)["']?\s*$/m)
          if (descMatch) {
            descriptions.set(entry.name, descMatch[1])
          }
        }
      } catch { /* skip unreadable skill files */ }
    }
  } catch { /* skills dir doesn't exist */ }
}

/** Enrich skill names with descriptions from disk.
 *  Reads from both project-level (.claude/skills/) and user-level (~/.claude/skills/). */
function enrichSkills(skillNames: string[], cwd?: string): SdkSkill[] {
  const descriptions = new Map<string, string>()
  // Project-level first (higher priority)
  if (cwd) {
    scanSkillsDir(path.join(cwd, '.claude', 'skills'), descriptions)
  }
  // User-level second
  scanSkillsDir(path.join(CLAUDE_DIR, 'skills'), descriptions)
  return skillNames.map((name) => ({
    name,
    description: descriptions.get(name) || '',
  }))
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
          sdkSkills: enrichSkills(msg.skills || [], client.cwd),
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
    onSdkLog?: (type: string, detail?: string, data?: Record<string, unknown>, parentToolUseId?: string | null, taskId?: string) => void
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

    // Auto-disable sandbox for Bash commands that require full system access
    // (e.g. xcodebuild install to real devices needs Keychain & USB access)
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command
      const needsFullAccess =
        cmd.includes('xcodebuild') ||
        cmd.includes('ios-deploy') ||
        cmd.includes('ideviceinstaller') ||
        cmd.includes('xcrun devicectl') ||
        cmd.includes('xcrun simctl install') ||
        cmd.includes('codesign')
      if (needsFullAccess && !input.dangerouslyDisableSandbox) {
        opts.updateToolInput?.({ ...input, dangerouslyDisableSandbox: true })
        console.log(`[canUseTool] Auto-disabled sandbox for Bash command: ${cmd.slice(0, 80)}`)
      }
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
    console.error(`${tag} stderr: ${data.trimEnd()}`)
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
  const tag = logPrefix(client.projectId)

  try {
    console.log(`${tag} Starting query...`)
    console.log(`  CWD: ${client.cwd}`)
    console.log(`  Session: ${client.sessionId || 'new'}`)
    console.log(`  Using model: ${modelConfig.name} (${modelConfig.provider})`)
    console.log(`  Model ID: ${options.model}`)
    console.log(`  Permission mode: ${client.permissionMode}`)
    console.log(`  CLAUDE_CONFIG_DIR: ${queryEnv.CLAUDE_CONFIG_DIR || '(default ~/.claude)'}`)
    console.log(`  Auth: ${queryEnv.ANTHROPIC_API_KEY ? 'API key (' + queryEnv.ANTHROPIC_API_KEY.slice(0, 10) + '...)' : 'CLI OAuth (default keychain)'}`)
    console.log(`  ANTHROPIC_BASE_URL: ${queryEnv.ANTHROPIC_BASE_URL || 'default'}`)
    console.log(`${tag} ${C.bgCyan}${C.bold} PROMPT ${C.reset} ${C.cyan}${prompt}${C.reset}`)

    // Set cron query context so cron_create can reliably access project/session info
    // (fallback for when canUseTool's updateToolInput is unavailable)
    setCronQueryContext({
      projectId: client.projectId,
      clientId: client.clientId,
      sessionId: client.sessionId,
    })

    console.log(`${tag} Spawning SDK query...`)
    const sdkPrompt = buildPrompt(prompt, images, client.sessionId)
    const stream = query({ prompt: sdkPrompt, options: options as any })
    console.log(`${tag} SDK query spawned`)

    // Store the Query object for forceful close on abort
    if (client.activeQuery) {
      client.activeQuery.queryObj = stream
    }

    let messageCount = 0
    let gotResult = false
    const streamLog = createStreamLogState()
    const sdkLog = callbacks.onSdkLog || (() => {})
    for await (const message of stream) {
      logSdkMessage(tag, message, streamLog)
      emitSdkLog(message, sdkLog)
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
              sdkSkills: enrichSkills((message as any).skills || []),
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

      // Break out of the loop once we've received the result message.
      // The SDK subprocess may linger if a background process (run_in_background)
      // holds stdout open, which would keep the stream alive indefinitely.
      if (message.type === 'result') {
        gotResult = true
        console.log(`${tag} Result received, closing stream`)
        // Forcefully close the SDK subprocess so it doesn't block
        try { stream.close() } catch { /* already closing */ }
        break
      }
    }
    console.log(`${tag} Stream completed, ${messageCount} messages (gotResult: ${gotResult})`)
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
        console.warn(`${tag} Resume failed for session ${client.sessionId}, retrying without resume...`)
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
      console.error(`${tag} Query error:`, err)
      throw err
    } else {
      console.log(`${tag} Query aborted`)
    }
  } finally {
    console.log(`${tag} Cleaning up query`)
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
