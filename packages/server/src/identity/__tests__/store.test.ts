import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { IdentityStore } from '../store.js'
import type { SoulDocument, EvolutionEntry } from '../../soul/types.js'

const SOUL_DIR = path.join(os.homedir(), '.codeclaws', 'soul')
const SOUL_FILE = path.join(SOUL_DIR, 'SOUL.json')
const EVOLUTION_LOG_FILE = path.join(SOUL_DIR, 'evolution-log.jsonl')
const INSIGHTS_DIR = path.join(os.homedir(), '.codeclaws', 'insights')

// Backup and restore real files
let soulBackup: string | null = null
let logBackup: string | null = null

beforeEach(() => {
  if (fs.existsSync(SOUL_FILE)) {
    soulBackup = fs.readFileSync(SOUL_FILE, 'utf-8')
  }
  if (fs.existsSync(EVOLUTION_LOG_FILE)) {
    logBackup = fs.readFileSync(EVOLUTION_LOG_FILE, 'utf-8')
  }
  // Clean for test
  if (fs.existsSync(SOUL_FILE)) fs.unlinkSync(SOUL_FILE)
  if (fs.existsSync(EVOLUTION_LOG_FILE)) fs.unlinkSync(EVOLUTION_LOG_FILE)
})

afterEach(() => {
  // Restore
  if (soulBackup !== null) {
    fs.writeFileSync(SOUL_FILE, soulBackup)
  } else if (fs.existsSync(SOUL_FILE)) {
    fs.unlinkSync(SOUL_FILE)
  }
  if (logBackup !== null) {
    fs.writeFileSync(EVOLUTION_LOG_FILE, logBackup)
  } else if (fs.existsSync(EVOLUTION_LOG_FILE)) {
    fs.unlinkSync(EVOLUTION_LOG_FILE)
  }
  // Clean test insights
  const testInsight = path.join(INSIGHTS_DIR, 'test-topic.md')
  if (fs.existsSync(testInsight)) fs.unlinkSync(testInsight)

  soulBackup = null
  logBackup = null
})

describe('IdentityStore', () => {
  it('should return default SOUL when no file exists', async () => {
    const store = new IdentityStore()
    const soul = await store.loadSoul()

    expect(soul.identity.name).toBe('')
    expect(soul.preferences.communicationStyle).toBe('简洁直接')
    expect(soul.meta.version).toBe(1)
  })

  it('should save and load SOUL', async () => {
    const store = new IdentityStore()

    const soul: SoulDocument = {
      identity: { name: 'Max', role: 'founder', expertise: ['product', 'engineering'] },
      preferences: { communicationStyle: '简洁直接', decisionStyle: '数据驱动', riskTolerance: '激进' },
      values: { speed: '快速迭代' },
      context: { activeGoals: ['launch MVP'], domain: 'AI tools', constraints: [] },
      meta: { version: 2, lastUpdated: '2026-03-16T00:00:00Z', evolutionLog: [] },
    }

    await store.saveSoul(soul)
    const loaded = await store.loadSoul()

    expect(loaded.identity.name).toBe('Max')
    expect(loaded.identity.expertise).toEqual(['product', 'engineering'])
    expect(loaded.preferences.riskTolerance).toBe('激进')
    expect(loaded.meta.version).toBe(2)
  })

  it('should append and read evolution log', async () => {
    const store = new IdentityStore()

    const entry1: EvolutionEntry = {
      timestamp: '2026-03-16T10:00:00Z',
      strategyUsed: 'prompt',
      changes: [{ path: 'preferences.communicationStyle', before: '简洁直接', after: '详细解释' }],
      reasoning: 'User asked for more detailed explanations repeatedly',
    }

    const entry2: EvolutionEntry = {
      timestamp: '2026-03-16T11:00:00Z',
      strategyUsed: 'prompt',
      changes: [{ path: 'identity.expertise', before: '["product"]', after: '["product","engineering"]' }],
      reasoning: 'User demonstrated deep engineering knowledge',
    }

    await store.appendEvolutionLog(entry1)
    await store.appendEvolutionLog(entry2)

    const log = await store.getEvolutionLog()
    expect(log.length).toBe(2)
    expect(log[0].strategyUsed).toBe('prompt')
    expect(log[1].changes[0].path).toBe('identity.expertise')
  })

  it('should respect evolution log limit', async () => {
    const store = new IdentityStore()

    for (let i = 0; i < 10; i++) {
      await store.appendEvolutionLog({
        timestamp: new Date().toISOString(),
        strategyUsed: 'prompt',
        changes: [],
        reasoning: `Entry ${i}`,
      })
    }

    const limited = await store.getEvolutionLog(3)
    expect(limited.length).toBe(3)
    // Should return the last 3 entries
    expect(limited[0].reasoning).toBe('Entry 7')
  })

  it('should save and load insights', async () => {
    const store = new IdentityStore()

    await store.saveInsight('test-topic', '# Market Patterns\n\nKey insight: users want simplicity.')
    const content = await store.loadInsight('test-topic')

    expect(content).toContain('Market Patterns')
    expect(content).toContain('users want simplicity')
  })

  it('should return null for non-existent insight', async () => {
    const store = new IdentityStore()
    const content = await store.loadInsight('non-existent-topic')
    expect(content).toBeNull()
  })

  it('should list insights', async () => {
    const store = new IdentityStore()
    await store.saveInsight('test-topic', 'Content')

    const topics = await store.listInsights()
    expect(topics).toContain('test-topic')
  })

  it('should report status correctly', async () => {
    const store = new IdentityStore()

    // Before any SOUL is saved
    const status1 = await store.getStatus()
    expect(status1.hasSoul).toBe(false)
    expect(status1.soulVersion).toBe(1)  // default version

    // After saving a SOUL
    await store.saveSoul({
      identity: { name: 'Test', role: '', expertise: [] },
      preferences: { communicationStyle: '', decisionStyle: '', riskTolerance: '' },
      values: {},
      context: { activeGoals: [], domain: '', constraints: [] },
      meta: { version: 3, lastUpdated: new Date().toISOString(), evolutionLog: [] },
    })

    const status2 = await store.getStatus()
    expect(status2.hasSoul).toBe(true)
    expect(status2.soulVersion).toBe(3)
  })
})
