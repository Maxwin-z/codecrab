// SOUL types — User persona model and evolution data structures

export interface SoulDocument {
  identity: {
    name: string
    role: string
    expertise: string[]
  }
  preferences: {
    communicationStyle: string   // "简洁直接" | "详细解释" | ...
    decisionStyle: string        // "数据驱动" | "直觉导向" | ...
    riskTolerance: string        // "保守" | "激进" | ...
  }
  values: Record<string, string>
  context: {
    activeGoals: string[]
    domain: string
    constraints: string[]
  }
  meta: {
    version: number
    lastUpdated: string
    evolutionLog: EvolutionEntry[]
  }
}

export interface EvolutionEntry {
  timestamp: string
  changes: SoulDiff[]
  reasoning: string
}

export interface SoulDiff {
  path: string       // e.g. "preferences.communicationStyle"
  before: string
  after: string
}
