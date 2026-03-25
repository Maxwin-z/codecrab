// ── Logger utility for server-v2 ─────────────────────────────────────────────
// Provides timestamped, color-coded console logging for debugging.
// Mirrors the v1 logging style from packages/server/src/engine/claude.ts.

// ── ANSI colors ──────────────────────────────────────────────────────────────
export const C = {
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

// ── Timestamp helper ─────────────────────────────────────────────────────────

function formatTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

export function tsLog(prefix: string, ...args: unknown[]): void {
  const ts = formatTimestamp()
  console.log(`${C.dim}[${ts}]${C.reset} ${prefix}`, ...args)
}

// ── SDK stream log state ─────────────────────────────────────────────────────

export interface StreamLogState {
  inputJsonAccum: Map<number, string>
  currentToolName?: string
  textAccum: string
  thinkingAccum: string
}

export function createStreamLogState(): StreamLogState {
  return {
    inputJsonAccum: new Map(),
    textAccum: '',
    thinkingAccum: '',
  }
}

// ── SDK message logger ───────────────────────────────────────────────────────
// Logs raw SDK messages with formatted, color-coded output.
// Accumulates streaming deltas and prints condensed output on block_stop.

export function logSdkMessage(tag: string, msg: any, state: StreamLogState): void {
  const type = msg.type

  switch (type) {
    case 'system': {
      const m = msg as any
      if (m.subtype === 'init') {
        const toolCount = m.tools?.length || 0
        const mcps = m.mcp_servers || []
        const mcpList = mcps.map((s: any) => {
          const st = s.status === 'connected' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
          return `${st}${s.name}`
        }).join('  ')
        const skillList = (m.skills || []).join(', ')
        tsLog(`${tag} ${C.green}${C.bold}⚡ init${C.reset}`)
        tsLog(`${tag}   ${C.dim}model:${C.reset}       ${C.bold}${m.model}${C.reset}`)
        tsLog(`${tag}   ${C.dim}session:${C.reset}     ${m.session_id}`)
        tsLog(`${tag}   ${C.dim}permission:${C.reset}  ${m.permissionMode}`)
        tsLog(`${tag}   ${C.dim}tools (${toolCount}):${C.reset}  ${C.dim}${(m.tools || []).slice(0, 20).join(', ')}${toolCount > 20 ? ` …+${toolCount - 20}` : ''}${C.reset}`)
        tsLog(`${tag}   ${C.dim}mcps:${C.reset}        ${mcpList || 'none'}`)
        if (skillList) tsLog(`${tag}   ${C.dim}skills:${C.reset}      ${skillList}`)
        tsLog(`${tag}   ${C.dim}version:${C.reset}     ${m.claude_code_version || '?'}`)
      } else if (m.subtype === 'task_started') {
        const parentId = m.tool_use_id ? `  tool=${m.tool_use_id.slice(-8)}` : ''
        tsLog(`${tag} ${C.magenta}${C.bold}🚀 task_started${C.reset}  task=${m.task_id}${parentId}  ${C.dim}${m.description || ''}${C.reset}`)
      } else if (m.subtype === 'task_progress') {
        const tokens = m.usage?.total_tokens || '?'
        const tools = m.usage?.tool_uses || '?'
        tsLog(`${tag} ${C.magenta}⏳ task_progress${C.reset}  task=${m.task_id}  tokens=${tokens}  tools=${tools}  ${C.dim}${m.summary || m.description || ''}${C.reset}`)
      } else if (m.subtype === 'task_notification') {
        const taskStatus = m.status === 'completed' ? `${C.green}✓ completed${C.reset}` : `${C.red}✗ ${m.status}${C.reset}`
        tsLog(`${tag} ${C.magenta}${C.bold}🏁 task_notification${C.reset}  task=${m.task_id}  ${taskStatus}  ${C.dim}${m.summary || ''}${C.reset}`)
      } else if (m.subtype === 'compact_boundary') {
        tsLog(`${tag} ${C.dim}── compact boundary ──${C.reset}`)
      } else {
        tsLog(`${tag} ${C.dim}system: ${m.subtype || 'unknown'}${C.reset}`)
      }
      break
    }

    case 'stream_event': {
      const evt = (msg as any).event
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
            tsLog(`${tag} ${C.blue}▶ message_start${C.reset}  ${C.dim}id=${m.id}  model=${m.model}${C.reset}`)
            tsLog(`${tag}   ${C.dim}tokens: in=${u.input_tokens || 0}  out=${u.output_tokens || 0}  cache_read=${u.cache_read_input_tokens || 0}  cache_create=${u.cache_creation_input_tokens || 0}${ephStr}${C.reset}`)
            if (u.service_tier) tsLog(`${tag}   ${C.dim}tier=${u.service_tier}${C.reset}`)
          } else {
            tsLog(`${tag} ${C.blue}▶ message_start${C.reset}  ${C.dim}id=${m?.id}${C.reset}`)
          }
          break
        }
        case 'content_block_start': {
          const block = evt.content_block
          if (block?.type === 'tool_use') {
            state.currentToolName = block.name
            state.inputJsonAccum.set(evt.index, '')
            const caller = block.caller?.type ? `  caller=${block.caller.type}` : ''
            tsLog(`${tag} ${C.yellow}🔧 tool_use[${evt.index}]${C.reset} ${C.bold}${block.name}${C.reset}  ${C.dim}id=${block.id}${caller}${C.reset}`)
          } else if (block?.type === 'text') {
            state.textAccum = ''
            tsLog(`${tag} ${C.cyan}📝 text[${evt.index}]${C.reset}`)
          } else if (block?.type === 'thinking') {
            state.thinkingAccum = ''
            tsLog(`${tag} ${C.magenta}💭 thinking[${evt.index}]${C.reset}`)
          } else {
            tsLog(`${tag} ${C.dim}block_start[${evt.index}] type=${block?.type}${C.reset}`)
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
                if (typeof val === 'string' && val.includes('\n')) {
                  tsLog(`${tag}   ${C.yellow}${k}:${C.reset}`)
                  for (const line of val.split('\n').slice(0, 15)) {
                    tsLog(`${tag}     ${C.dim}${line}${C.reset}`)
                  }
                  if (val.split('\n').length > 15) {
                    tsLog(`${tag}     ${C.dim}…(${val.split('\n').length - 15} more lines)${C.reset}`)
                  }
                } else {
                  const display = val.length > 200 ? val.slice(0, 200) + '…' : val
                  tsLog(`${tag}   ${C.yellow}${k}:${C.reset} ${C.dim}${display}${C.reset}`)
                }
              }
            } catch {
              tsLog(`${tag}   ${C.dim}raw: ${accum.slice(0, 300)}${C.reset}`)
            }
            state.inputJsonAccum.delete(evt.index)
          }
          // Print accumulated text
          if (state.textAccum) {
            const lines = state.textAccum.split('\n')
            const preview = lines.slice(0, 8).join('\n')
            const suffix = lines.length > 8 ? `\n     ${C.dim}…(${lines.length - 8} more lines, ${state.textAccum.length} chars total)${C.reset}` : ''
            tsLog(`${tag}   ${C.cyan}text (${state.textAccum.length} chars):${C.reset}`)
            for (const line of preview.split('\n')) {
              tsLog(`${tag}     ${C.dim}${line}${C.reset}`)
            }
            if (suffix) console.log(suffix)
            state.textAccum = ''
          }
          // Print accumulated thinking
          if (state.thinkingAccum) {
            const lines = state.thinkingAccum.split('\n')
            const preview = lines.slice(0, 5).join('\n')
            const suffix = lines.length > 5 ? `\n     ${C.dim}…(${lines.length - 5} more lines, ${state.thinkingAccum.length} chars total)${C.reset}` : ''
            tsLog(`${tag}   ${C.magenta}thinking (${state.thinkingAccum.length} chars):${C.reset}`)
            for (const line of preview.split('\n')) {
              tsLog(`${tag}     ${C.magenta}${line}${C.reset}`)
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
          tsLog(`${tag} ${C.blue}■ message_done${C.reset}  stop=${C.bold}${stop || 'none'}${C.reset}  out_tokens=${outTokens || '?'}${edits}`)
          break
        }
        case 'message_stop':
          break
        default:
          tsLog(`${tag} ${C.dim}stream: ${evt.type}${C.reset}`)
      }
      break
    }

    case 'assistant': {
      const m = (msg as any).message
      const content = m?.content
      if (!content) break
      const usage = m?.usage
      tsLog(`${tag} ${C.green}${C.bold}◀ assistant${C.reset}  ${C.dim}id=${m.id}${C.reset}`)
      for (const block of content) {
        if (block.type === 'tool_use') {
          const inputPreview = JSON.stringify(block.input)
          const display = inputPreview.length > 200 ? inputPreview.slice(0, 200) + '…' : inputPreview
          tsLog(`${tag}   ${C.yellow}🔧 ${block.name}${C.reset}  ${C.dim}id=${block.id}${C.reset}`)
          tsLog(`${tag}     ${C.dim}${display}${C.reset}`)
        } else if (block.type === 'text') {
          const lines = (block.text || '').split('\n')
          const preview = lines.slice(0, 6)
          tsLog(`${tag}   ${C.cyan}📝 text (${(block.text || '').length} chars):${C.reset}`)
          for (const line of preview) {
            tsLog(`${tag}     ${C.dim}${line}${C.reset}`)
          }
          if (lines.length > 6) tsLog(`${tag}     ${C.dim}…(${lines.length - 6} more lines)${C.reset}`)
        } else if (block.type === 'thinking') {
          const lines = (block.thinking || '').split('\n')
          const preview = lines.slice(0, 4)
          tsLog(`${tag}   ${C.magenta}💭 thinking (${(block.thinking || '').length} chars):${C.reset}`)
          for (const line of preview) {
            tsLog(`${tag}     ${C.magenta}${line}${C.reset}`)
          }
          if (lines.length > 4) tsLog(`${tag}     ${C.magenta}…(${lines.length - 4} more lines)${C.reset}`)
        }
      }
      if (usage) {
        tsLog(`${tag}   ${C.dim}tokens: in=${usage.input_tokens || 0}  out=${usage.output_tokens || 0}  cache_read=${usage.cache_read_input_tokens || 0}  cache_create=${usage.cache_creation_input_tokens || 0}${C.reset}`)
      }
      break
    }

    case 'user': {
      const content = (msg as any).message?.content
      if (!Array.isArray(content)) break
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b: any) => b.text || '').join('')
              : JSON.stringify(block.content)
          const errTag = block.is_error ? `${C.red}ERROR${C.reset} ` : ''
          const preview = text.length > 300 ? text.slice(0, 300) + '…' : text
          const lines = preview.split('\n').slice(0, 8)
          tsLog(`${tag} ${C.green}▷ tool_result${C.reset}  ${errTag}${C.dim}id=${block.tool_use_id}${C.reset}  (${text.length} chars)`)
          for (const line of lines) {
            tsLog(`${tag}     ${C.dim}${line}${C.reset}`)
          }
        }
      }
      break
    }

    case 'result': {
      const m = msg as any
      const u = m.usage
      const costStr = m.total_cost_usd != null ? `$${m.total_cost_usd.toFixed(4)}` : '?'
      const durStr = m.duration_ms != null ? `${(m.duration_ms / 1000).toFixed(1)}s` : '?'
      const errStr = m.is_error ? `  ${C.red}ERROR${C.reset}` : ''
      tsLog(`${tag} ${C.green}${C.bold}✅ result${C.reset}  cost=${costStr}  duration=${durStr}${errStr}`)
      if (u) {
        tsLog(`${tag}   ${C.dim}tokens: in=${u.input_tokens || 0}  out=${u.output_tokens || 0}  cache_read=${u.cache_read_input_tokens || 0}  cache_create=${u.cache_creation_input_tokens || 0}${C.reset}`)
      }
      const resultText = typeof m.result === 'string' ? m.result : ''
      if (resultText) {
        const lines = resultText.split('\n').slice(0, 6)
        for (const line of lines) {
          tsLog(`${tag}   ${C.dim}${line.slice(0, 200)}${C.reset}`)
        }
        if (resultText.split('\n').length > 6) {
          tsLog(`${tag}   ${C.dim}…(${resultText.split('\n').length - 6} more lines)${C.reset}`)
        }
      }
      // Dump all fields when error for debugging
      if (m.is_error) {
        const keys = Object.keys(m).filter(k => !['type', 'usage', 'total_cost_usd', 'duration_ms', 'is_error'].includes(k))
        for (const k of keys) {
          const v = typeof m[k] === 'string' ? m[k] : JSON.stringify(m[k])
          if (v && v !== '""' && v !== 'null' && v !== 'undefined') {
            tsLog(`${tag}   ${C.red}${k}: ${String(v).slice(0, 300)}${C.reset}`)
          }
        }
      }
      break
    }
  }
}
