// SoulAgent — Triggers SOUL evolution via the Agent SDK
//
// Extracts conversation data from completed user queries and sends
// an evolution prompt to the __soul__ project using executeInternalQuery.

import { executeInternalQuery } from '../engine/internal.js'
import { getSoulProjectDir, SOUL_PROJECT_ID, ensureSoulProject } from './project.js'

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
    console.error('[SoulAgent] Failed to ensure SOUL project:', err)
    return { triggered: false, error: 'Failed to initialize SOUL project' }
  }

  const prompt = buildEvolutionPrompt(conversations)
  const cwd = getSoulProjectDir()

  console.log(`[SoulAgent] Triggering evolution with ${conversations.length} conversation(s)`)

  const result = await executeInternalQuery({
    projectId: SOUL_PROJECT_ID,
    cwd,
    prompt,
    maxTurns: 5, // Keep it short — read SOUL.json, maybe edit, done
  })

  if (result.success) {
    console.log(`[SoulAgent] Evolution completed: $${result.costUsd?.toFixed(4) || '?'} | ${result.durationMs}ms`)
  } else {
    console.error(`[SoulAgent] Evolution failed: ${result.error}`)
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
