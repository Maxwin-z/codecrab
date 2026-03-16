// EvolutionStrategy — Pluggable interface for SOUL evolution

import type { SoulDocument, EvolutionEvidence } from '../types.js'

export interface EvolutionStrategy {
  id: string
  name: string
  evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<EvolutionResult>
}

export interface EvolutionResult {
  updatedSoul: SoulDocument
  reasoning: string
}
