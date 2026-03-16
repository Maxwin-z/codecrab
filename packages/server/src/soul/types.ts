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

export interface EvolutionEvidence {
  source: 'conversation' | 'feedback' | 'behavior'
  timestamp: string
  content: string
  signal: string
  confidence: number  // 0-1
}

export interface EvolutionEntry {
  timestamp: string
  strategyUsed: string
  changes: SoulDiff[]
  reasoning: string
}

export interface SoulDiff {
  path: string       // e.g. "preferences.communicationStyle"
  before: string
  after: string
}

export interface ConversationChunk {
  timestamp: string
  userMessage: string
  assistantResponse: string
  feedbackSignals?: string[]
}

export function createDefaultSoul(): SoulDocument {
  return {
    identity: {
      name: '',
      role: '',
      expertise: [],
    },
    preferences: {
      communicationStyle: '简洁直接',
      decisionStyle: '数据驱动',
      riskTolerance: '适中',
    },
    values: {},
    context: {
      activeGoals: [],
      domain: '',
      constraints: [],
    },
    meta: {
      version: 1,
      lastUpdated: new Date().toISOString(),
      evolutionLog: [],
    },
  }
}
