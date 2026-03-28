import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage } from '@codecrab/shared'
import type { CoreEngine } from '../core/index.js'
import { isSoulEnabled } from './settings.js'
import { loadSoulState, saveSoulState } from './state.js'
import { ensureSoulProject } from './project.js'

// ── Constants ───────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 1 * 60 * 1000   // 1 minute after last turn completes (testing; production: 5 min)
const EVOLUTION_TIMEOUT_MS = 120_000      // 2 minutes max per evolution
const MAX_TURNS = 10                      // Agent turns for a single evolution

// ── Module state ────────────────────────────────────────────────────────────

/** Per-session idle timers: sessionId -> timeout handle */
const idleTimers = new Map<string, NodeJS.Timeout>()

/** Prevent concurrent evolutions */
let evolutionInProgress = false

/** @internal Reset module state — for testing only */
export function _resetForTest(): void {
  for (const timer of idleTimers.values()) clearTimeout(timer)
  idleTimers.clear()
  evolutionInProgress = false
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SoulConsumer {
  destroy(): void
}

export function initSoul(core: CoreEngine): SoulConsumer {
  // Cancel idle timer when user starts a new turn (they're active)
  core.on('turn:start', (event) => {
    if (event.type !== 'user') return
    clearIdleTimer(event.sessionId)
  })

  // Start/reset idle timer when a user turn completes
  core.on('turn:close', (event) => {
    if (event.type !== 'user') return
    if (!isSoulEnabled()) return

    startIdleTimer(event.sessionId, event.projectId, core)
  })

  return {
    destroy() {
      for (const timer of idleTimers.values()) {
        clearTimeout(timer)
      }
      idleTimers.clear()
    },
  }
}

// ── Idle timer management ───────────────────────────────────────────────────

function clearIdleTimer(sessionId: string): void {
  const timer = idleTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    idleTimers.delete(sessionId)
  }
}

function startIdleTimer(sessionId: string, projectId: string, core: CoreEngine): void {
  clearIdleTimer(sessionId)

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId)
    triggerSoulEvolution(core, projectId, sessionId).catch((err) => {
      console.error('[Soul] Evolution error:', err?.message || err)
    })
  }, IDLE_TIMEOUT_MS)

  // Don't keep the process alive just for soul timers
  timer.unref()

  idleTimers.set(sessionId, timer)
}

// ── Evolution trigger ───────────────────────────────────────────────────────

async function triggerSoulEvolution(
  core: CoreEngine,
  projectId: string,
  sessionId: string,
): Promise<void> {
  // Re-check at trigger time — settings may have changed during the 5-min wait
  if (!isSoulEnabled()) return
  if (evolutionInProgress) return

  evolutionInProgress = true
  try {
    await runEvolution(core, projectId, sessionId)
  } finally {
    evolutionInProgress = false
  }
}

// ── Core evolution logic ────────────────────────────────────────────────────

async function runEvolution(
  core: CoreEngine,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const projectPath = core.projects.getPath(projectId)
  if (!projectPath) return

  // Get full message history for this session
  const messages = await core.sessions.getHistory(sessionId, projectPath)
  if (!messages || messages.length === 0) return

  // Only process messages added since last evolution
  const state = await loadSoulState()
  const lastCount = state.sessions[sessionId]?.lastEvolvedMessageCount ?? 0
  const newMessages = messages.slice(lastCount)
  if (newMessages.length === 0) return

  // Extract user prompts + assistant text (skip tool calls, thinking, etc.)
  const conversation = formatConversation(newMessages)
  if (!conversation.trim()) return

  // Ensure soul project directory with CLAUDE.md
  const soulDir = await ensureSoulProject()

  // Resolve model & env from the triggering project's default provider
  const { model, env } = resolveProvider(core, projectId)

  console.log(`[Soul] Starting evolution for session ${sessionId} (${newMessages.length} new messages)`)

  // Run a fresh Agent SDK session for this evolution
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), EVOLUTION_TIMEOUT_MS)

  try {
    const q = sdkQuery({
      prompt: buildPrompt(conversation),
      options: {
        cwd: soulDir,
        maxTurns: MAX_TURNS,
        effort: 'medium' as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'] as const,
        abortController,
        ...(model ? { model } : {}),
        ...(env ? { env } : {}),
      } as any,
    })

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              console.log(`[Soul] Agent text: ${block.text.slice(0, 200)}`)
            } else if (block.type === 'tool_use') {
              console.log(`[Soul] Agent tool: ${block.name} → ${JSON.stringify(block.input).slice(0, 200)}`)
            }
          }
        }
      } else if (msg.type === 'result') {
        const resultText = typeof (msg as any).result === 'string' ? (msg as any).result : ''
        if (resultText) console.log(`[Soul] Result: ${resultText.slice(0, 300)}`)
        break
      }
    }
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError' || abortController.signal.aborted
    if (isAbort) {
      console.warn('[Soul] Evolution timed out')
    } else {
      console.error(`[Soul] SDK error: ${err?.message || err}`)
    }
    return // Don't update state on failure — retry next time
  } finally {
    clearTimeout(timeout)
  }

  // Update state after successful evolution
  state.sessions[sessionId] = { lastEvolvedMessageCount: messages.length }
  await saveSoulState(state)

  console.log(`[Soul] Evolution completed for session ${sessionId}`)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveProvider(core: CoreEngine, projectId: string): {
  model: string | undefined
  env: Record<string, string | undefined> | undefined
} {
  const providerId = core.projects.getDefaultProvider(projectId)
  const config = core.projects.resolveProviderConfig(providerId)

  if (config) {
    const model = config.modelId
      || (config.provider === 'custom' ? config.name : undefined)
    return { model, env: core.projects.buildProviderEnv(config) }
  }

  return { model: providerId, env: undefined }
}

function formatConversation(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      parts.push(`[User]: ${msg.content}`)
    } else if (msg.role === 'assistant' && msg.content) {
      parts.push(`[Assistant]: ${msg.content}`)
    }
  }
  return parts.join('\n\n')
}

function buildPrompt(conversation: string): string {
  return (
    '以下是用户与 AI 助手的最近对话。请阅读当前 SOUL.md，分析这段对话，' +
    '判断是否需要更新用户画像。如果需要，请更新 SOUL.md 并记录到 evolution-log.jsonl。' +
    '如果对话内容平淡无奇，不需要更新，请什么都不做。\n\n' +
    '--- 对话内容 ---\n\n' +
    conversation
  )
}
