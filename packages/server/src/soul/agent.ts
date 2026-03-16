// SoulAgent — Triggers SOUL evolution via the Agent SDK
//
// Extracts conversation data from completed user queries and sends
// an evolution prompt to the __soul__ project using executeInternalQuery.

import { executeInternalQuery } from '../engine/internal.js'
import { getSoulProjectDir, SOUL_PROJECT_ID, ensureSoulProject } from './project.js'
import { C } from '../engine/claude.js'

const TAG = `${C.bgMagenta}${C.bold} 🧬 SOUL ${C.reset}`

/** Conversation data extracted from a user query turn */
export interface ConversationTurn {
  timestamp: string
  userMessage: string
  assistantResponse: string
}

/** Result of a SOUL evolution attempt */
export interface SoulEvolutionResult {
  triggered: boolean
  output?: string
  costUsd?: number
  durationMs?: number
  error?: string
}

/**
 * Trigger SOUL evolution based on conversation data.
 * Runs asynchronously — does not block the caller.
 */
export async function triggerSoulEvolution(conversations: ConversationTurn[]): Promise<SoulEvolutionResult> {
  if (conversations.length === 0) {
    return { triggered: false }
  }

  // Ensure SOUL project exists
  try {
    ensureSoulProject()
  } catch (err) {
    console.error(`${TAG} ${C.red}Failed to ensure SOUL project:${C.reset}`, err)
    return { triggered: false, error: 'Failed to initialize SOUL project' }
  }

  const prompt = buildEvolutionPrompt(conversations)
  const cwd = getSoulProjectDir()

  // ── Log: Conversation Input ───────────────────────────────
  console.log('')
  console.log(`${TAG} ${C.blue}${C.bold}📨 Triggering evolution with ${conversations.length} conversation(s)${C.reset}`)
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i]
    console.log(`${TAG}`)
    console.log(`${TAG} ${C.blue}Conversation ${i + 1}${C.reset} ${C.dim}(${c.timestamp})${C.reset}`)
    // User message preview
    const userLines = c.userMessage.split('\n')
    const userPreview = userLines.slice(0, 5)
    console.log(`${TAG}   ${C.cyan}User:${C.reset}`)
    for (const line of userPreview) {
      console.log(`${TAG}     ${C.dim}${line.slice(0, 200)}${C.reset}`)
    }
    if (userLines.length > 5) {
      console.log(`${TAG}     ${C.dim}…(${userLines.length - 5} more lines, ${c.userMessage.length} chars)${C.reset}`)
    }
    // Assistant response preview
    const assistLines = c.assistantResponse.split('\n')
    const assistPreview = assistLines.slice(0, 5)
    console.log(`${TAG}   ${C.green}Assistant:${C.reset}`)
    for (const line of assistPreview) {
      console.log(`${TAG}     ${C.dim}${line.slice(0, 200)}${C.reset}`)
    }
    if (assistLines.length > 5) {
      console.log(`${TAG}     ${C.dim}…(${assistLines.length - 5} more lines, ${c.assistantResponse.length} chars)${C.reset}`)
    }
  }

  const result = await executeInternalQuery({
    projectId: SOUL_PROJECT_ID,
    cwd,
    prompt,
    maxTurns: 5, // Keep it short — read SOUL.json, maybe edit, done
  })

  if (!result.success) {
    console.error(`${TAG} ${C.red}${C.bold}Evolution failed: ${result.error}${C.reset}`)
  }

  return {
    triggered: true,
    output: result.output,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    error: result.error,
  }
}

function buildEvolutionPrompt(conversations: ConversationTurn[]): string {
  const conversationText = conversations.map((c, i) => {
    return `--- Conversation ${i + 1} (${c.timestamp}) ---\nUser: ${c.userMessage}\nAssistant: ${c.assistantResponse}`
  }).join('\n\n')

  return `The following conversation(s) just occurred between the user and the AI assistant. Please analyze them and determine if the SOUL profile needs updating.

${conversationText}

Follow the instructions in CLAUDE.md for how to evaluate and update the SOUL profile.`
}
