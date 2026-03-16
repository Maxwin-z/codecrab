// PromptEvolution — Default SOUL evolution strategy
//
// Uses a direct LLM call (lightweight, no Agent SDK) to analyze evidence
// and produce incremental updates to the SOUL document.

import Anthropic from '@anthropic-ai/sdk'
import type { SoulDocument, EvolutionEvidence } from '../types.js'
import type { EvolutionStrategy, EvolutionResult } from './types.js'

const SYSTEM_PROMPT = `You are a SOUL evolution engine. Your job is to analyze conversation evidence and update a user's SOUL document — a structured persona that captures who they are, how they prefer to collaborate, and what they value.

Rules:
1. Only update fields where evidence provides clear signal. Do not guess or hallucinate.
2. Preserve existing values unless contradicted by new evidence.
3. Be conservative — small incremental changes are better than dramatic rewrites.
4. The SOUL describes the USER, not the AI assistant.
5. Return ONLY valid JSON matching the SoulDocument schema. No markdown, no explanation outside the JSON.

SoulDocument schema:
{
  "identity": { "name": string, "role": string, "expertise": string[] },
  "preferences": { "communicationStyle": string, "decisionStyle": string, "riskTolerance": string },
  "values": { [key: string]: string },
  "context": { "activeGoals": string[], "domain": string, "constraints": string[] },
  "meta": { "version": number, "lastUpdated": string, "evolutionLog": [] }
}`

export class PromptEvolution implements EvolutionStrategy {
  id = 'prompt'
  name = 'Prompt-based Evolution'

  private apiKey: string
  private model: string

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey
    this.model = opts.model || 'claude-haiku-4-5-20251001'
  }

  async evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<EvolutionResult> {
    if (evidence.length === 0) {
      return { updatedSoul: current, reasoning: 'No evidence provided, no changes made.' }
    }

    const client = new Anthropic({ apiKey: this.apiKey })

    const evidenceText = evidence
      .map((e, i) => `[${i + 1}] (${e.source}, confidence=${e.confidence})\n  Signal: ${e.signal}\n  Content: ${e.content}`)
      .join('\n\n')

    const userPrompt = `Current SOUL:
${JSON.stringify(current, null, 2)}

New evidence (${evidence.length} items):
${evidenceText}

Analyze the evidence and return the updated SOUL document. Increment meta.version by 1 and set meta.lastUpdated to "${new Date().toISOString()}". Keep meta.evolutionLog as an empty array (it will be populated externally).

Also explain your reasoning in a separate "reasoning" field.

Return JSON in this exact format:
{
  "updatedSoul": { ...the full updated SoulDocument... },
  "reasoning": "Brief explanation of what changed and why"
}`

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    try {
      const parsed = JSON.parse(text) as EvolutionResult
      // Ensure meta.evolutionLog is preserved (not overwritten by LLM)
      parsed.updatedSoul.meta.evolutionLog = current.meta.evolutionLog
      return parsed
    } catch {
      console.error('[PromptEvolution] Failed to parse LLM response:', text.slice(0, 200))
      return { updatedSoul: current, reasoning: 'Failed to parse evolution result, no changes made.' }
    }
  }
}
