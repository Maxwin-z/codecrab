// SoulPipeline — Orchestrates SOUL evolution from conversation evidence
//
// Flow: conversations → signal extraction → EvolutionStrategy → persist
// This is a Pipeline (not an Agent): no sessions, no tools, no streaming.

import Anthropic from '@anthropic-ai/sdk'
import type { Pipeline } from './types.js'
import type { SoulDocument, EvolutionEvidence, ConversationChunk, SoulDiff, EvolutionEntry } from '../soul/types.js'
import type { EvolutionStrategy } from '../soul/evolution/types.js'
import type { IdentityStore } from '../identity/store.js'

export interface SoulPipelineInput {
  conversations: ConversationChunk[]
}

export interface SoulPipelineOutput {
  updatedSoul: SoulDocument
  changes: SoulDiff[]
  reasoning: string
}

export class SoulPipeline implements Pipeline<SoulPipelineInput, SoulPipelineOutput> {
  id = 'soul-pipeline'
  name = 'SOUL Evolution Pipeline'

  private strategy: EvolutionStrategy
  private store: IdentityStore
  private apiKey: string
  private extractionModel: string

  constructor(opts: {
    strategy: EvolutionStrategy
    store: IdentityStore
    apiKey: string
    extractionModel?: string
  }) {
    this.strategy = opts.strategy
    this.store = opts.store
    this.apiKey = opts.apiKey
    this.extractionModel = opts.extractionModel || 'claude-haiku-4-5-20251001'
  }

  async run(input: SoulPipelineInput): Promise<SoulPipelineOutput> {
    const { conversations } = input

    if (conversations.length === 0) {
      const currentSoul = await this.store.loadSoul()
      return { updatedSoul: currentSoul, changes: [], reasoning: 'No conversations to analyze.' }
    }

    // Step 1: Extract evolution evidence from conversations
    const evidence = await this.extractEvidence(conversations)

    if (evidence.length === 0) {
      const currentSoul = await this.store.loadSoul()
      return { updatedSoul: currentSoul, changes: [], reasoning: 'No actionable signals found in conversations.' }
    }

    // Step 2: Load current SOUL
    const currentSoul = await this.store.loadSoul()

    // Step 3: Run evolution strategy
    const { updatedSoul, reasoning } = await this.strategy.evolve(currentSoul, evidence)

    // Step 4: Compute changes
    const changes = diffSoul(currentSoul, updatedSoul)

    if (changes.length === 0) {
      return { updatedSoul: currentSoul, changes: [], reasoning }
    }

    // Step 5: Record evolution entry
    const entry: EvolutionEntry = {
      timestamp: new Date().toISOString(),
      strategyUsed: this.strategy.id,
      changes,
      reasoning,
    }
    updatedSoul.meta.evolutionLog = [...currentSoul.meta.evolutionLog, entry]

    // Step 6: Persist
    await this.store.saveSoul(updatedSoul)
    await this.store.appendEvolutionLog(entry)

    console.log(`[SoulPipeline] Evolved SOUL v${currentSoul.meta.version} → v${updatedSoul.meta.version} (${changes.length} changes)`)

    return { updatedSoul, changes, reasoning }
  }

  private async extractEvidence(conversations: ConversationChunk[]): Promise<EvolutionEvidence[]> {
    const client = new Anthropic({ apiKey: this.apiKey })

    const conversationText = conversations
      .map((c, i) => `--- Conversation ${i + 1} (${c.timestamp}) ---\nUser: ${c.userMessage}\nAssistant: ${c.assistantResponse}${c.feedbackSignals?.length ? `\nFeedback signals: ${c.feedbackSignals.join(', ')}` : ''}`)
      .join('\n\n')

    const response = await client.messages.create({
      model: this.extractionModel,
      max_tokens: 1024,
      system: `You extract behavioral signals from conversations between a user and an AI assistant. For each meaningful signal, identify:
- source: "conversation" (from dialogue content), "feedback" (explicit user correction/praise), or "behavior" (implicit pattern like skipping explanations)
- signal: A concise description of what this reveals about the user
- confidence: 0-1 how confident you are

Return JSON array only. If no meaningful signals, return [].
Example: [{"source":"feedback","signal":"User prefers data tables over prose explanations","content":"User said 'just show me the numbers'","confidence":0.8}]`,
      messages: [{
        role: 'user',
        content: `Extract user behavioral signals from these conversations:\n\n${conversationText}`,
      }],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    try {
      const signals = JSON.parse(text) as Array<{
        source: EvolutionEvidence['source']
        signal: string
        content: string
        confidence: number
      }>
      return signals.map((s) => ({
        ...s,
        timestamp: new Date().toISOString(),
      }))
    } catch {
      console.error('[SoulPipeline] Failed to parse evidence extraction:', text.slice(0, 200))
      return []
    }
  }
}

// Compute diff between two SOUL documents (flat comparison of leaf values)
function diffSoul(before: SoulDocument, after: SoulDocument): SoulDiff[] {
  const diffs: SoulDiff[] = []

  function compare(a: unknown, b: unknown, path: string) {
    if (a === b) return
    if (typeof a !== typeof b || a === null || b === null) {
      diffs.push({ path, before: JSON.stringify(a), after: JSON.stringify(b) })
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const aStr = JSON.stringify(a)
      const bStr = JSON.stringify(b)
      if (aStr !== bStr) {
        diffs.push({ path, before: aStr, after: bStr })
      }
      return
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>
      const bObj = b as Record<string, unknown>
      const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)])
      for (const key of allKeys) {
        compare(aObj[key], bObj[key], path ? `${path}.${key}` : key)
      }
      return
    }
    diffs.push({ path, before: String(a), after: String(b) })
  }

  // Compare everything except meta (meta is managed separately)
  compare(before.identity, after.identity, 'identity')
  compare(before.preferences, after.preferences, 'preferences')
  compare(before.values, after.values, 'values')
  compare(before.context, after.context, 'context')

  return diffs
}
