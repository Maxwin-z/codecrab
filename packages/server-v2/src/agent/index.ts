// ClaudeAgent — Pure SDK wrapper for the Agent layer (stateless except active query tracking)
//
// Wraps @anthropic-ai/claude-agent-sdk and yields normalized AgentStreamEvent objects
// via an AsyncIterable backed by an AsyncChannel. Permission and question handling
// uses a resolver pattern: canUseTool/onElicitation callbacks push events into the
// channel and block on a Promise that the caller (TurnManager) resolves externally.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { buildExtensionServers } from './extensions/index.js'
import { getCronQueryContext } from './extensions/cron/tools.js'
import { tsLog, logSdkMessage, createStreamLogState, C } from '../logger.js'
import type {
  AgentInterface,
  AgentQueryOptions,
  AgentStreamEvent,
  SdkInitInfo,
  UsageInfo,
} from '../types/index.js'

// ── AsyncChannel ────────────────────────────────────────────────────────────
// A push-based async iterable. Producers call push()/close(); consumers
// for-await over the channel. This decouples SDK callbacks (canUseTool)
// from the consumer's iteration loop.

class AsyncChannel<T> {
  private queue: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  push(value: T): void {
    if (this.closed) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value, done: false })
    } else {
      this.queue.push(value)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as unknown as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const self = this
    return {
      next(): Promise<IteratorResult<T>> {
        if (self.queue.length > 0) {
          return Promise.resolve({ value: self.queue.shift()!, done: false })
        }
        if (self.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          self.waiting = resolve
        })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}

// ── ID generation ───────────────────────────────────────────────────────────

let idCounter = 0
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Text extraction helper ──────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block
        if (block.type === 'text') return block.text || ''
        return JSON.stringify(block)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}

// ── Read-only tools auto-approved in Safe (default) mode ────────────────────

const SAFE_MODE_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  // Auto-approve inter-agent thread tools in safe mode
  'mcp__threads__thread_send_message',
  'mcp__threads__thread_save_artifact',
  'mcp__threads__thread_list_threads',
  'mcp__threads__thread_get_messages',
  'mcp__threads__thread_complete_thread',
  // Auto-approve cron tools in safe mode
  'mcp__cron__cron_create',
  'mcp__cron__cron_list',
  'mcp__cron__cron_delete',
  'mcp__cron__cron_get',
]

// ── Default query constants ─────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 200
const DEFAULT_EFFORT: 'low' | 'medium' | 'high' | 'max' = 'high'

const SUMMARY_INSTRUCTION =
  `\n\n[IMPORTANT: After completing your response, you MUST append a brief summary on its own line in EXACTLY this format — including BOTH the opening "[" and closing "]" brackets:\n` +
  `[SUMMARY: your summary here]\n` +
  `The closing "]" bracket is MANDATORY — do NOT omit it. This summary will be used as a push notification sent to the user, so write it as a natural, conversational reply to the user's request — as if you're briefly telling them what you did. Use first person, keep it casual and concise (one sentence). For example, if the user asked "check the directory structure", write: [SUMMARY: 已查看目录结构，共有14个目录和26个文件]. Match the language the user used. Never omit this line.]`

// ── ClaudeAgent ─────────────────────────────────────────────────────────────

export class ClaudeAgent implements AgentInterface {
  /** Map of sessionId -> SDK Query object for abort support */
  private activeQueries = new Map<string, any>()

  /** Permission resolvers: requestId -> resolver function */
  private permissionResolvers = new Map<
    string,
    (result: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }) => void
  >()

  /** Question resolvers: toolId -> { resolve, input } for allow/deny */
  private questionResolvers = new Map<
    string,
    { resolve: (value: { behavior: string; updatedInput?: unknown }) => void; input: unknown }
  >()

  // ── query ───────────────────────────────────────────────────────────────

  query(prompt: string, options: AgentQueryOptions): AsyncIterable<AgentStreamEvent> {
    const channel = new AsyncChannel<AgentStreamEvent>()

    // Run the SDK query in the background, pushing events into the channel.
    this.runQuery(prompt, options, channel).catch((error) => {
      console.error(`[Agent] runQuery error: ${error?.message || String(error)}`)
      console.error(error?.stack || '')
      const isAbort =
        error?.name === 'AbortError' ||
        options.abortController?.signal.aborted ||
        (error?.message && String(error.message).includes('aborted'))

      if (!isAbort) {
        channel.push({
          type: 'sdk_event',
          raw: { ts: Date.now(), type: 'error', detail: error?.message || String(error) },
        })
      }
      channel.close()
    })

    return channel
  }

  // ── abort ───────────────────────────────────────────────────────────────

  abort(sessionId: string): void {
    // 1. Clear pending resolvers BEFORE aborting the query
    //    so canUseTool promises are resolved before the signal fires
    for (const [id, resolver] of this.permissionResolvers) {
      resolver({ behavior: 'deny', message: 'Aborted' })
      this.permissionResolvers.delete(id)
    }
    // Remove question resolvers without calling them —
    // they will NOT be resolved via the allow path.
    // The abort signal handler in canUseTool won't fire either
    // since we delete the resolver first.
    this.questionResolvers.clear()

    // 2. Then abort the query stream
    const q = this.activeQueries.get(sessionId)
    if (q) {
      try { q.abort?.() } catch { /* ignore */ }
      setTimeout(() => {
        try { q.close() } catch { /* already closed */ }
      }, 500)
      this.activeQueries.delete(sessionId)
    }
  }

  // ── probe ───────────────────────────────────────────────────────────────

  async probe(cwd: string, model?: string, env?: Record<string, string | undefined>): Promise<SdkInitInfo> {
    const abortController = new AbortController()

    const sdkOpts: Record<string, unknown> = {
      cwd,
      maxTurns: 1,
      abortController,
      settingSources: ['project', 'user'] as const,
    }
    if (model) sdkOpts.model = model
    if (env) sdkOpts.env = env

    const q = sdkQuery({
      prompt: '.',
      options: sdkOpts as any,
    })

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          const m = msg as any
          abortController.abort()
          try { q.close() } catch { /* already closing */ }

          const mcpStatus: Array<{ name: string; status: string }> = (m.mcp_servers || []).map(
            (s: any) => ({ name: s.name, status: s.status }),
          )

          let skills: Array<{ name: string; description: string }> = []
          if (m.skills) {
            skills = m.skills.map((name: string) => ({ name, description: '' }))
          }

          let models: Array<{ id: string; name: string }> = []
          try {
            const supportedModels = await q.supportedModels()
            models = (supportedModels as any[]).map((mod: any) => ({
              id: mod.id || mod.value || '',
              name: mod.name || mod.displayName || '',
            }))
          } catch { /* models unavailable */ }

          return {
            tools: m.tools || [],
            mcpServers: mcpStatus,
            skills,
            models,
          }
        }
      }

      return { tools: [], mcpServers: [], skills: [], models: [] }
    } catch {
      return { tools: [], mcpServers: [], skills: [], models: [] }
    }
  }

  // ── Permission / question resolution ────────────────────────────────────

  resolvePermission(requestId: string, behavior: 'allow' | 'deny', updatedInput?: unknown): void {
    const resolver = this.permissionResolvers.get(requestId)
    if (resolver) {
      resolver({ behavior, updatedInput })
      this.permissionResolvers.delete(requestId)
    }
  }

  resolveQuestion(toolId: string, answers: Record<string, string | string[]>): void {
    const entry = this.questionResolvers.get(toolId)
    if (entry) {
      entry.resolve({
        behavior: 'allow',
        updatedInput: { ...(entry.input as any), answers },
      })
      this.questionResolvers.delete(toolId)
    }
  }

  /** Deny/dismiss a pending question — resolves the canUseTool promise with 'deny' */
  denyQuestion(toolId: string): void {
    const entry = this.questionResolvers.get(toolId)
    if (entry) {
      entry.resolve({ behavior: 'deny' })
      this.questionResolvers.delete(toolId)
    }
  }

  // ── Build prompt with optional image content blocks ─────────────────

  private buildPrompt(
    prompt: string,
    images?: import('../types/index.js').ImageAttachment[],
  ): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
    if (!images || images.length === 0) {
      return prompt
    }

    const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
    const contentBlocks: unknown[] = []

    for (const img of images) {
      if (supportedTypes.has(img.mediaType) && img.data) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            data: img.data,
            media_type: img.mediaType,
          },
        })
      }
    }

    // If no supported images, fall back to plain text
    if (contentBlocks.length === 0) {
      return prompt
    }

    contentBlocks.push({ type: 'text', text: prompt })

    const userMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: contentBlocks },
      parent_tool_use_id: null,
      session_id: '',
    }

    async function* singleMessage() {
      yield userMessage
    }

    return singleMessage()
  }

  // ── Internal: run query and push events into channel ────────────────────

  private async runQuery(
    prompt: string,
    options: AgentQueryOptions,
    channel: AsyncChannel<AgentStreamEvent>,
  ): Promise<void> {
    const isYolo = options.permissionMode === 'bypassPermissions'
    const extensionServers = buildExtensionServers(options.enabledMcps)
    const logTag = `${C.blue}[SDK]${C.reset}`

    // Build disallowed tools list for disabled SDK servers and skills
    const disallowed: string[] = []
    // Note: disallowedTools will be resolved after we receive the init message
    // with the full tool list. For now, track the server/skill names.
    const disabledSdkServers = options.disabledSdkServers || []
    const disabledSkills = options.disabledSkills || []
    let sdkTools: string[] = []

    // Permission request counter
    let reqCounter = 0

    const sdkOptions: Record<string, unknown> = {
      ...(options.model ? { model: options.model } : {}),
      cwd: options.cwd,
      resume: options.resume || undefined,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      effort: DEFAULT_EFFORT,
      settingSources: ['project', 'user'] as const,
      mcpServers: { ...extensionServers },
      permissionMode: isYolo ? 'bypassPermissions' : 'default',
      allowDangerouslySkipPermissions: isYolo,
      includePartialMessages: true,
      abortController: options.abortController,
      agentProgressSummaries: true,
      // Block system cron tools — force AI to use our persistent MCP cron tools instead
      // Block SendMessage — it conflicts with our inter-agent thread_send_message tool
      disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'SendMessage'],
      ...(options.env ? { env: options.env } : {}),

      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          `\n\nYour working directory is ${options.cwd}.` +
          `\n\nIMPORTANT: When running long-lived processes such as servers (http-server, python -m http.server, npm run dev, etc.), ` +
          `you MUST use the Bash tool with run_in_background: true. Never run server processes in the foreground — ` +
          `they will block the session and prevent further interaction. After starting the server in the background, ` +
          `tell the user the URL they can visit.` +
          `\n\nIMPORTANT: For commands that are known to take extremely long (e.g. brew install --cask mactex, ` +
          `apt install texlive-full, or other multi-gigabyte downloads/installs that may exceed 10 minutes), ` +
          `use the Bash tool with run_in_background: true, then periodically check progress with the TaskOutput tool ` +
          `until the task completes. Report progress to the user along the way.` +
          `\n\nWhen the MCP cron tools are available (mcp__cron__cron_create, mcp__cron__cron_list, mcp__cron__cron_delete, mcp__cron__cron_get), ` +
          `you MUST use them instead of the system CronCreate/CronDelete/CronList tools for all scheduling tasks. ` +
          `The MCP cron tools provide persistent scheduled tasks that survive server restarts, while the system cron tools are session-only and will be lost when the session ends.` +
          `\n\nSCHEDULING GUIDE: cron_create supports three modes:` +
          `\n- 'schedule' (cron expression): for RECURRING tasks only (e.g., "every day at 9am" → schedule: "0 9 * * *")` +
          `\n- 'delay': for one-time tasks relative to now (e.g., "remind me in 5 minutes" → delay: "5m")` +
          `\n- 'runAt' (ISO 8601): for one-time tasks at a specific time (e.g., "remind me at 3:30 PM" → runAt: "2026-03-27T15:30:00+08:00")` +
          `\nNEVER use a cron expression for one-time reminders or delayed tasks — always use 'delay' or 'runAt' instead.` +
          `\n\nINTER-AGENT COMMUNICATION: When you need to send messages to other agents (referenced as @agentName in user prompts or your CLAUDE.md), ` +
          `you MUST use the thread-based inter-agent tools (mcp__threads__*). These tools create collaboration threads ` +
          `and automatically resume the target agent to process your message. Do NOT use any other messaging tools.` +
          `\n- mcp__threads__thread_send_message: Send a message to @agentName or "broadcast" to all thread participants. Set new_thread=true to create a sub-thread.` +
          `\n- mcp__threads__thread_save_artifact: Save work artifacts (documents, data) to the current thread for sharing.` +
          `\n- mcp__threads__thread_list_threads: List collaboration threads you participate in.` +
          `\n- mcp__threads__thread_get_messages: View message history of a thread.` +
          `\n- mcp__threads__thread_complete_thread: Mark the current thread as completed when your work is done.` +
          `\n\nIMPORTANT: To reduce unnecessary API round-trips, you MUST proactively use the AskUserQuestion tool in these situations:` +
          `\n1. When the user's request is ambiguous or could be interpreted in multiple ways — ask for clarification BEFORE starting work.` +
          `\n2. When there are multiple possible approaches or solutions — present the options and let the user choose.` +
          `\n3. When you need to confirm potentially destructive or irreversible actions (deleting files, overwriting data, force-pushing, etc.).` +
          `\n4. When a task requires assumptions about the user's intent, preferences, or environment that you cannot determine from context.` +
          `\n5. When the user explicitly asks you to ask questions, confirm with them, or discuss before proceeding ` +
          `(e.g. "问我几个问题", "有什么问题先和我确认", "ask me questions", "check with me first", "先问我再做", "和我讨论一下方案"). ` +
          `In these cases you MUST use the AskUserQuestion tool — do NOT just output text. The user is on a chat interface and can ONLY respond through the AskUserQuestion tool's interactive form.` +
          `\nPrefer using select/multi-select question types when there are discrete options, and free-text when open-ended input is needed. ` +
          `Do NOT guess and iterate — ask once, then act. This saves both time and API costs.` +
          `\n\nHIGHEST PRIORITY OVERRIDE: If the user explicitly says to decide on your own (e.g. "你自主决定", "let you decide", "你来决定", "自己判断", "不用问我"), ` +
          `do NOT use AskUserQuestion and do NOT ask for confirmation — just proceed autonomously with your best judgment. This override takes precedence over all the rules above.` +
          SUMMARY_INSTRUCTION +
          (options.systemPromptAppend || ''),
      },

      // Capture stderr from the SDK subprocess for debugging
      stderr: (data: string) => {
        console.error(`${logTag} stderr: ${data.trimEnd()}`)
      },

      // In Safe mode, pre-approve only read-only tools
      ...(isYolo ? {} : { allowedTools: [...SAFE_MODE_ALLOWED_TOOLS] }),

      // canUseTool: handles permissions, questions, and tool input tweaks
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        opts: {
          signal: AbortSignal
          decisionReason?: string
          toolUseID: string
          updateToolInput?: (input: Record<string, unknown>) => void
        },
      ) => {
        // Auto-inject context for cron tools
        if (toolName === 'mcp__cron__cron_create') {
          const ctx = getCronQueryContext()
          if (ctx.projectId || ctx.sessionId) {
            opts.updateToolInput?.({
              ...input,
              projectId: ctx.projectId,
              sessionId: ctx.sessionId,
            })
          }
        }

        // Auto-tune Bash tool: raise timeout and disable sandbox
        if (toolName === 'Bash') {
          let updated = { ...input }
          let didUpdate = false
          if (!input.run_in_background && !input.timeout) {
            updated.timeout = 600_000
            didUpdate = true
          }
          if (!input.dangerouslyDisableSandbox) {
            updated.dangerouslyDisableSandbox = true
            didUpdate = true
          }
          if (didUpdate) {
            opts.updateToolInput?.(updated)
          }
        }

        // Handle AskUserQuestion: must wait for user answers regardless of mode
        if (toolName === 'AskUserQuestion' && (input as any).questions) {
          const toolId = opts.toolUseID

          // Push event into channel so the consumer knows a question is pending
          channel.push({
            type: 'ask_user_question',
            toolId,
            questions: (input as any).questions,
          })

          // Block until resolved (by resolveQuestion or denyQuestion)
          return new Promise<{ behavior: string; updatedInput?: unknown }>((resolve) => {
            this.questionResolvers.set(toolId, { resolve, input })

            // On abort, just clean up the resolver — do NOT call resolve().
            // The SDK handles abort via its own signal mechanism.
            // Resolving with 'deny' here races with the abort and causes
            // "Operation aborted" when the SDK tries to write the deny response.
            const onAbort = () => {
              this.questionResolvers.delete(toolId)
            }
            opts.signal.addEventListener('abort', onAbort, { once: true })
          })
        }

        // Auto-approve cron and push tools (whitelisted, no user confirmation needed)
        if (toolName.startsWith('mcp__cron__') || toolName.startsWith('mcp__push__') || toolName.startsWith('mcp__threads__')) {
          return { behavior: 'allow' as const }
        }

        // In bypass mode, auto-approve everything else
        if (isYolo) {
          return { behavior: 'allow' as const }
        }

        // In default mode, request permission from the user
        const requestId = generateId(`perm-${++reqCounter}`)

        // Push permission_request event into channel
        channel.push({
          type: 'permission_request',
          requestId,
          toolName,
          input,
          reason: opts.decisionReason || `Allow ${toolName}?`,
        })

        // Block until resolved
        // SDK Zod schema requires updatedInput (record) for allow, message (string) for deny
        return new Promise<{ behavior: string; message?: string; updatedInput?: unknown }>((resolve) => {
          this.permissionResolvers.set(requestId, (result: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }) => {
            if (result.behavior === 'allow') {
              resolve({ behavior: 'allow', updatedInput: result.updatedInput ?? input })
            } else {
              resolve({ behavior: 'deny', message: result.message || 'Permission denied by user' })
            }
          })

          // Resolve on abort
          const onAbort = () => {
            this.permissionResolvers.delete(requestId)
            resolve({ behavior: 'deny', message: 'Aborted' })
          }
          opts.signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    }

    // Build prompt: plain string or structured content blocks with images
    const sdkPrompt = this.buildPrompt(prompt, options.images)

    const q = sdkQuery({ prompt: sdkPrompt, options: sdkOptions as any })

    // Track for abort
    const sessionKey = options.resume || `pending-${Date.now()}`
    this.activeQueries.set(sessionKey, q)

    // Track context window info from message_start events
    let contextWindowUsed = 0
    let contextWindowMax = 0

    // Track background tasks
    const pendingTasks = new Map<string, { description: string; startedAt: number }>()
    let gotResult = false

    // Track the resolved session ID (may differ from sessionKey after init)
    let resolvedSessionId = sessionKey

    // SDK stream logging state
    const logState = createStreamLogState()

    try {
      let currentSessionId = options.resume || ''

      for await (const msg of q) {
        // Log every raw SDK message for debugging
        logSdkMessage(logTag, msg, logState)
        // ── system messages ───────────────────────────────────────────
        if (msg.type === 'system') {
          const m = msg as any

          if (m.subtype === 'init') {
            currentSessionId = m.session_id || currentSessionId
            sdkTools = m.tools || []

            // Re-key the active query map
            if (sessionKey !== currentSessionId) {
              this.activeQueries.delete(sessionKey)
              this.activeQueries.set(currentSessionId, q)
              resolvedSessionId = currentSessionId
            }

            // Now resolve disallowed tools using the full SDK tool list
            if (disabledSdkServers.length > 0 || disabledSkills.length > 0) {
              for (const serverName of disabledSdkServers) {
                const prefix = `mcp__${serverName}__`
                for (const tool of sdkTools) {
                  if (tool.startsWith(prefix)) disallowed.push(tool)
                }
              }
              for (const skillName of disabledSkills) {
                for (const tool of sdkTools) {
                  if (tool === skillName || tool.startsWith(`${skillName}:`)) {
                    disallowed.push(tool)
                  }
                }
              }
              // Note: disallowedTools is set at query creation and cannot be modified
              // mid-stream. For v2, disabled servers/skills should be set before query starts.
            }

            channel.push({
              type: 'session_init',
              sdkSessionId: currentSessionId,
              tools: sdkTools,
            })
          } else if (m.subtype === 'task_started') {
            pendingTasks.set(m.task_id, {
              description: m.description || '',
              startedAt: Date.now(),
            })
            channel.push({
              type: 'background_task_update',
              taskId: m.task_id,
              status: 'started',
              description: m.description || '',
            })
          } else if (m.subtype === 'task_progress') {
            channel.push({
              type: 'background_task_update',
              taskId: m.task_id,
              status: 'progress',
              description: m.description,
              summary: m.summary,
              usage: m.usage
                ? {
                    totalTokens: m.usage.total_tokens,
                    toolUses: m.usage.tool_uses,
                    durationMs: m.usage.duration_ms,
                  }
                : undefined,
            })
          } else if (m.subtype === 'task_notification') {
            pendingTasks.delete(m.task_id)
            const taskStatus = m.status === 'completed' ? 'completed'
              : m.status === 'stopped' ? 'stopped'
              : 'failed'
            channel.push({
              type: 'background_task_update',
              taskId: m.task_id,
              status: taskStatus,
              summary: m.summary,
              usage: m.usage
                ? {
                    totalTokens: m.usage.total_tokens,
                    toolUses: m.usage.tool_uses,
                    durationMs: m.usage.duration_ms,
                  }
                : undefined,
            })

            // If result already received and all tasks done, close
            if (gotResult && pendingTasks.size === 0) {
              try { q.close() } catch { /* already closing */ }
              break
            }
          }

          // Forward as sdk_event for debug visibility
          channel.push({
            type: 'sdk_event',
            raw: { ts: Date.now(), type: m.subtype || 'system', detail: m.subtype },
          })
        }

        // ── stream_event messages (real-time deltas) ──────────────────
        if (msg.type === 'stream_event') {
          const event = (msg as any).event
          if (!event) continue

          if (event.type === 'content_block_delta') {
            const delta = event.delta
            if (delta?.type === 'text_delta') {
              channel.push({ type: 'text_delta', text: delta.text })
            } else if (delta?.type === 'thinking_delta') {
              channel.push({ type: 'thinking_delta', text: delta.thinking })
            }
            // input_json_delta is ignored — tool input is accumulated in assistant messages
          } else if (event.type === 'message_start') {
            // Capture usage/context window info
            const usage = event.message?.usage
            if (usage) {
              contextWindowUsed = usage.input_tokens || 0
            }
          }
        }

        // ── assistant messages (accumulated content snapshots) ────────
        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content
          const parentToolUseId: string | null = (msg as any).parent_tool_use_id ?? null
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                channel.push({
                  type: 'assistant_text',
                  text: block.text,
                  parentToolUseId,
                })
              } else if (block.type === 'thinking' && block.thinking) {
                channel.push({
                  type: 'thinking_complete',
                  thinking: block.thinking,
                })
              } else if (block.type === 'tool_use') {
                channel.push({
                  type: 'tool_use',
                  toolName: block.name,
                  toolId: block.id,
                  input: block.input,
                })
              }
            }
          }
        }

        // ── user messages (tool results) ──────────────────────────────
        if (msg.type === 'user') {
          const content = (msg as any).message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const contentStr = extractTextContent(block.content)
                channel.push({
                  type: 'tool_result',
                  toolId: block.tool_use_id,
                  content: contentStr,
                  isError: block.is_error || false,
                })
              }
            }
          }
        }

        // ── result message ────────────────────────────────────────────
        if (msg.type === 'result') {
          const m = msg as any
          gotResult = true

          // Extract summary and suggestions from result text
          let resultText = typeof m.result === 'string' ? m.result : ''
          let summary: string | undefined
          let suggestions: string[] | undefined

          const summaryMatch = resultText.match(/\[SUMMARY:\s*(.*?)\]/)
          if (summaryMatch) {
            summary = summaryMatch[1].trim()
            resultText = resultText.replace(summaryMatch[0], '').trim()
          }

          const suggestionsMatch = resultText.match(/\[SUGGESTIONS:\s*(.*?)\]/)
          if (suggestionsMatch) {
            suggestions = suggestionsMatch[1].split('|').map((s: string) => s.trim()).filter(Boolean)
            resultText = resultText.replace(suggestionsMatch[0], '').trim()
          }

          // Extract contextWindow from modelUsage (keyed by model name)
          const modelUsageValues = Object.values(m.modelUsage || {}) as Array<{ contextWindow?: number }>
          if (modelUsageValues.length > 0 && modelUsageValues[0].contextWindow) {
            contextWindowMax = modelUsageValues[0].contextWindow
          }

          const usage: UsageInfo = {
            inputTokens: m.usage?.input_tokens ?? 0,
            outputTokens: m.usage?.output_tokens ?? 0,
            cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
            cacheCreateTokens: m.usage?.cache_creation_input_tokens ?? 0,
            contextWindowUsed,
            contextWindowMax,
          }

          channel.push({
            type: 'result',
            result: resultText || (typeof m.result === 'string' ? m.result : ''),
            isError: m.is_error || false,
            usage,
            costUsd: m.total_cost_usd ?? 0,
            durationMs: m.duration_ms ?? 0,
            hasBackgroundTasks: pendingTasks.size > 0,
            backgroundTaskIds: pendingTasks.size > 0 ? [...pendingTasks.keys()] : undefined,
          })

          // Emit summary & suggestions as separate events
          if (summary) {
            channel.push({ type: 'query_summary', summary })
          }
          if (suggestions && suggestions.length > 0) {
            channel.push({ type: 'query_suggestions', suggestions })
          }

          // Close if no background tasks pending
          if (pendingTasks.size === 0) {
            try { q.close() } catch { /* already closing */ }
            break
          }
          // Otherwise, keep consuming for background task updates
        }
      }
    } finally {
      // Clean up active query tracking (both original and re-keyed)
      this.activeQueries.delete(sessionKey)
      if (resolvedSessionId !== sessionKey) {
        this.activeQueries.delete(resolvedSessionId)
      }
      channel.close()
    }
  }
}
