import { describe, it, expect, vi } from 'vitest'
import { SoulPipeline } from '../soul.js'
import type { EvolutionStrategy, EvolutionResult } from '../../soul/evolution/types.js'
import type { SoulDocument } from '../../soul/types.js'
import { createDefaultSoul } from '../../soul/types.js'
import { IdentityStore } from '../../identity/store.js'

// Mock the Anthropic SDK to avoid real API calls
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: JSON.stringify([
              {
                source: 'conversation',
                signal: 'User prefers concise responses',
                content: 'User said: just give me the answer',
                confidence: 0.8,
              },
            ]),
          }],
        }),
      }
    },
  }
})

// Create a mock EvolutionStrategy that always changes identity.role
function createMockStrategy(overrides?: Partial<EvolutionResult>): EvolutionStrategy {
  return {
    id: 'mock',
    name: 'Mock Strategy',
    evolve: vi.fn().mockImplementation(async (current: SoulDocument) => {
      const updated = structuredClone(current)
      updated.meta.version += 1
      updated.meta.lastUpdated = new Date().toISOString()
      updated.identity.role = 'founder'  // Always set a non-default value
      return {
        updatedSoul: updated,
        reasoning: 'Mock evolution applied',
        ...overrides,
      }
    }),
  }
}

// Create a mock IdentityStore
function createMockStore(soul?: SoulDocument): IdentityStore {
  const currentSoul = soul || createDefaultSoul()
  const store = new IdentityStore()

  // Override methods to avoid filesystem access
  store.loadSoul = vi.fn().mockResolvedValue(currentSoul)
  store.saveSoul = vi.fn().mockResolvedValue(undefined)
  store.appendEvolutionLog = vi.fn().mockResolvedValue(undefined)

  return store
}

describe('SoulPipeline', () => {
  it('should return unchanged SOUL when no conversations', async () => {
    const store = createMockStore()
    const strategy = createMockStrategy()
    const pipeline = new SoulPipeline({
      strategy,
      store,
      apiKey: 'test-key',
    })

    const result = await pipeline.run({ conversations: [] })

    expect(result.changes).toEqual([])
    expect(result.reasoning).toContain('No conversations')
    expect(strategy.evolve).not.toHaveBeenCalled()
  })

  it('should extract evidence and evolve SOUL', async () => {
    const store = createMockStore()
    const strategy = createMockStrategy()
    const pipeline = new SoulPipeline({
      strategy,
      store,
      apiKey: 'test-key',
    })

    const result = await pipeline.run({
      conversations: [
        {
          timestamp: '2026-03-16T10:00:00Z',
          userMessage: 'just give me the answer',
          assistantResponse: 'The answer is 42.',
        },
      ],
    })

    // Strategy should have been called with evidence
    expect(strategy.evolve).toHaveBeenCalledOnce()
    const [, evidence] = (strategy.evolve as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(evidence.length).toBe(1)
    expect(evidence[0].signal).toContain('concise')

    // SOUL should have been saved
    expect(store.saveSoul).toHaveBeenCalledOnce()
    expect(store.appendEvolutionLog).toHaveBeenCalledOnce()
  })

  it('should compute diffs between old and new SOUL', async () => {
    const soul = createDefaultSoul()
    // identity.role defaults to '' — strategy will change it to 'founder'
    const store = createMockStore(soul)
    const strategy = createMockStrategy()

    const pipeline = new SoulPipeline({
      strategy,
      store,
      apiKey: 'test-key',
    })

    const result = await pipeline.run({
      conversations: [{
        timestamp: '2026-03-16T10:00:00Z',
        userMessage: 'I am a startup founder',
        assistantResponse: 'Got it.',
      }],
    })

    expect(result.changes.length).toBeGreaterThan(0)
    const roleChange = result.changes.find((c) => c.path === 'identity.role')
    expect(roleChange).toBeDefined()
    expect(roleChange!.before).toBe('')
    expect(roleChange!.after).toBe('founder')
  })
})
