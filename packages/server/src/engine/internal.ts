// Internal Query Executor — Headless query execution for background agents
//
// Runs queries through the Agent SDK without WebSocket broadcasting.
// Used by SoulAgent and other internal agents that operate silently.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import {
  getDefaultModelConfig,
  createClientState,
  buildQueryOptions,
  buildQueryEnv,
  removeAllClientStates,
  C,
  logSdkMessage,
  createStreamLogState,
} from './claude.js'

export interface InternalQueryOpts {
  /** Project ID to run the query in */
  projectId: string
  /** Working directory for the agent */
  cwd: string
  /** The prompt to send */
  prompt: string
  /** Max agentic turns (default: 10 for internal agents) */
  maxTurns?: number
  /** Model override (uses default model if not specified) */
  model?: string
}

export interface InternalQueryResult {
  success: boolean
  /** Final text output from the agent */
  output: string
  /** Error message if failed */
  error?: string
  /** Cost in USD */
  costUsd?: number
  /** Duration in ms */
  durationMs?: number
}

/**
 * Execute a query silently without WebSocket broadcasting.
 * Creates a temporary client state, runs the query, and returns the result.
 *
 * - Always runs in bypassPermissions mode
 * - No WebSocket events emitted
 * - Creates a new session each time (no resume)
 */
export async function executeInternalQuery(opts: InternalQueryOpts): Promise<InternalQueryResult> {
  const startTime = Date.now()
  const isSoul = opts.projectId === '__soul__'
  const tag = isSoul
    ? `${C.bgMagenta}${C.bold} 🧬 SOUL ${C.reset}`
    : `${C.dim}[InternalQuery]${C.reset}`

  // Get model configuration
  const modelConfig = getDefaultModelConfig()
  if (!modelConfig) {
    return { success: false, output: '', error: 'No default model configured' }
  }

  // Build environment
  const queryEnv = buildQueryEnv(modelConfig)

  // Create a temporary client state
  const clientId = `internal-${opts.projectId}-${Date.now()}`
  const clientState = createClientState(clientId, opts.projectId, opts.cwd)
  clientState.permissionMode = 'bypassPermissions'

  if (opts.model) {
    clientState.model = opts.model
  }

  // Build options — no MCP servers, no disabled tools for internal agents
  const options = buildQueryOptions(clientState, queryEnv)

  // Override settings for internal agents
  options.maxTurns = opts.maxTurns ?? 10
  options.permissionMode = 'bypassPermissions'
  options.allowDangerouslySkipPermissions = true

  // No MCP servers for internal queries (keep it lightweight)
  options.mcpServers = {}

  // Create abort controller
  const abortController = new AbortController()
  options.abortController = abortController

  try {
    // ── Log: Query Start ──────────────────────────────────────
    if (isSoul) {
      console.log('')
      console.log(`${tag} ${C.magenta}${'━'.repeat(60)}${C.reset}`)
      console.log(`${tag} ${C.magenta}${C.bold}SOUL Evolution Started${C.reset}`)
      console.log(`${tag} ${C.magenta}${'━'.repeat(60)}${C.reset}`)
      console.log(`${tag} ${C.dim}cwd:${C.reset}       ${opts.cwd}`)
      console.log(`${tag} ${C.dim}model:${C.reset}     ${modelConfig.id}`)
      console.log(`${tag} ${C.dim}maxTurns:${C.reset}  ${options.maxTurns}`)
      console.log(`${tag}`)
      console.log(`${tag} ${C.cyan}${C.bold}📤 Prompt Sent to Agent:${C.reset}`)
      console.log(`${tag} ${C.cyan}${'─'.repeat(50)}${C.reset}`)
      const promptLines = opts.prompt.split('\n')
      for (const line of promptLines) {
        console.log(`${tag}   ${C.cyan}${line}${C.reset}`)
      }
      console.log(`${tag} ${C.cyan}${'─'.repeat(50)}${C.reset}`)
      console.log(`${tag}`)
      console.log(`${tag} ${C.yellow}${C.bold}⚙️  Agent SDK Events:${C.reset}`)
    } else {
      console.log(`[InternalQuery] Starting query for project ${opts.projectId}`)
    }

    const stream = sdkQuery({ prompt: opts.prompt, options: options as any })

    let output = ''
    let costUsd: number | undefined
    let durationMs: number | undefined

    // Use stream log state for SOUL to get detailed event logging
    const streamLog = isSoul ? createStreamLogState() : null

    for await (const message of stream) {
      // Log every SDK event for SOUL
      if (isSoul && streamLog) {
        logSdkMessage(tag, message, streamLog)
      }

      // Capture session ID from init
      if (message.type === 'system' && 'subtype' in message && (message as any).subtype === 'init') {
        const newSessionId = (message as any).session_id
        clientState.sessionId = newSessionId
        if (!isSoul) {
          console.log(`[InternalQuery] Session initialized: ${newSessionId}`)
        }
      }

      // Accumulate text output
      if (message.type === 'assistant') {
        const content = (message as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              output += block.text
            }
          }
        }
      }

      // Capture result
      if (message.type === 'result') {
        costUsd = (message as any).cost_usd ?? (message as any).total_cost_usd
        durationMs = (message as any).duration_ms
        try { stream.close() } catch { /* already closing */ }
        break
      }
    }

    const elapsed = Date.now() - startTime

    // ── Log: Query Complete ─────────────────────────────────
    if (isSoul) {
      console.log(`${tag}`)
      console.log(`${tag} ${C.green}${C.bold}📥 Evolution Result:${C.reset}`)
      console.log(`${tag} ${C.green}${'─'.repeat(50)}${C.reset}`)
      if (output) {
        const outputLines = output.split('\n')
        for (const line of outputLines) {
          console.log(`${tag}   ${C.green}${line}${C.reset}`)
        }
      } else {
        console.log(`${tag}   ${C.dim}(no text output)${C.reset}`)
      }
      console.log(`${tag} ${C.green}${'─'.repeat(50)}${C.reset}`)
      console.log(`${tag}`)
      console.log(`${tag} ${C.bold}📊 Summary:${C.reset}`)
      console.log(`${tag}   ${C.dim}status:${C.reset}    ${C.green}${C.bold}✅ success${C.reset}`)
      console.log(`${tag}   ${C.dim}cost:${C.reset}      ${C.bold}$${costUsd?.toFixed(4) || '?'}${C.reset}`)
      console.log(`${tag}   ${C.dim}duration:${C.reset}  ${C.bold}${elapsed}ms${C.reset}`)
      console.log(`${tag}   ${C.dim}sdk time:${C.reset}  ${durationMs ? `${durationMs}ms` : '?'}`)
      console.log(`${tag} ${C.magenta}${'━'.repeat(60)}${C.reset}`)
      console.log('')
    } else {
      console.log(`[InternalQuery] Completed for ${opts.projectId} in ${elapsed}ms (cost: $${costUsd?.toFixed(4) || '?'})`)
    }

    return {
      success: true,
      output,
      costUsd,
      durationMs: durationMs || elapsed,
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime

    // ── Log: Query Failed ───────────────────────────────────
    if (isSoul) {
      console.log(`${tag}`)
      console.log(`${tag} ${C.red}${C.bold}❌ Evolution Failed:${C.reset}`)
      console.log(`${tag}   ${C.red}${err.message}${C.reset}`)
      console.log(`${tag}   ${C.dim}duration:${C.reset}  ${elapsed}ms`)
      console.log(`${tag} ${C.magenta}${'━'.repeat(60)}${C.reset}`)
      console.log('')
    } else {
      console.error(`[InternalQuery] Failed for ${opts.projectId} after ${elapsed}ms:`, err.message)
    }

    return {
      success: false,
      output: '',
      error: err.message || 'Internal query failed',
      durationMs: elapsed,
    }
  } finally {
    // Clean up temporary client state to avoid memory leaks
    removeAllClientStates(clientId)
  }
}
