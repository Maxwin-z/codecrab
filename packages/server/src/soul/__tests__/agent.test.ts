// SoulAgent integration tests
//
// Tests the full SOUL evolution flow: trigger → internal query → file updates
// These tests require the SDK to be available, so we mock executeInternalQuery.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { triggerSoulEvolution, type ConversationTurn } from '../agent.js'
import { ensureSoulProject, getSoulProjectDir } from '../project.js'

// Mock the internal query executor since it requires the full SDK
vi.mock('../../engine/internal.js', () => ({
  executeInternalQuery: vi.fn(),
}))

import { executeInternalQuery } from '../../engine/internal.js'
const mockExecuteInternalQuery = vi.mocked(executeInternalQuery)

const SOUL_DIR = path.join(os.homedir(), '.codeclaws', 'soul')
const SOUL_JSON = path.join(SOUL_DIR, 'SOUL.json')
const EVOLUTION_LOG = path.join(SOUL_DIR, 'evolution-log.jsonl')

describe('SoulAgent', () => {
  // Backup and restore real SOUL files
  let soulBackup: string | null = null
  let logBackup: string | null = null

  beforeEach(() => {
    try { soulBackup = fs.readFileSync(SOUL_JSON, 'utf-8') } catch { soulBackup = null }
    try { logBackup = fs.readFileSync(EVOLUTION_LOG, 'utf-8') } catch { logBackup = null }
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (soulBackup !== null) {
      fs.writeFileSync(SOUL_JSON, soulBackup, 'utf-8')
    }
    if (logBackup !== null) {
      fs.writeFileSync(EVOLUTION_LOG, logBackup, 'utf-8')
    }
  })

  it('should not trigger with empty conversations', async () => {
    const result = await triggerSoulEvolution([])
    expect(result.triggered).toBe(false)
    expect(mockExecuteInternalQuery).not.toHaveBeenCalled()
  })

  it('should call executeInternalQuery with correct parameters', async () => {
    mockExecuteInternalQuery.mockResolvedValue({
      success: true,
      output: 'No update needed — trivial conversation.',
      costUsd: 0.001,
      durationMs: 500,
    })

    const conversations: ConversationTurn[] = [{
      timestamp: '2026-03-16T10:00:00Z',
      userMessage: '帮我分析一下这个市场的竞争格局',
      assistantResponse: '好的，让我来分析一下这个市场...',
    }]

    const result = await triggerSoulEvolution(conversations)

    expect(result.triggered).toBe(true)
    expect(result.output).toContain('No update needed')
    expect(result.costUsd).toBe(0.001)

    // Verify executeInternalQuery was called correctly
    expect(mockExecuteInternalQuery).toHaveBeenCalledOnce()
    const callArgs = mockExecuteInternalQuery.mock.calls[0][0]
    expect(callArgs.projectId).toBe('__soul__')
    expect(callArgs.cwd).toBe(getSoulProjectDir())
    expect(callArgs.maxTurns).toBe(5)
    expect(callArgs.prompt).toContain('帮我分析一下这个市场的竞争格局')
    expect(callArgs.prompt).toContain('好的，让我来分析一下这个市场')
    expect(callArgs.prompt).toContain('CLAUDE.md')
  })

  it('should handle executeInternalQuery failure gracefully', async () => {
    mockExecuteInternalQuery.mockResolvedValue({
      success: false,
      output: '',
      error: 'No default model configured',
    })

    const result = await triggerSoulEvolution([{
      timestamp: '2026-03-16T10:00:00Z',
      userMessage: '测试消息',
      assistantResponse: '测试回复',
    }])

    expect(result.triggered).toBe(true)
    expect(result.error).toBe('No default model configured')
  })

  it('should include multiple conversations in the prompt', async () => {
    mockExecuteInternalQuery.mockResolvedValue({
      success: true,
      output: 'Updated communicationStyle',
      durationMs: 1000,
    })

    const conversations: ConversationTurn[] = [
      {
        timestamp: '2026-03-16T10:00:00Z',
        userMessage: '简单说一下',
        assistantResponse: '好的，简要来说...',
      },
      {
        timestamp: '2026-03-16T10:05:00Z',
        userMessage: '不要解释太多，直接给结果',
        assistantResponse: '结果如下：...',
      },
    ]

    await triggerSoulEvolution(conversations)

    const prompt = mockExecuteInternalQuery.mock.calls[0][0].prompt
    expect(prompt).toContain('Conversation 1')
    expect(prompt).toContain('Conversation 2')
    expect(prompt).toContain('简单说一下')
    expect(prompt).toContain('不要解释太多')
  })
})

describe('ensureSoulProject', () => {
  it('should create SOUL project directory and files', () => {
    ensureSoulProject()

    expect(fs.existsSync(SOUL_DIR)).toBe(true)
    expect(fs.existsSync(SOUL_JSON)).toBe(true)
    expect(fs.existsSync(EVOLUTION_LOG)).toBe(true)
    expect(fs.existsSync(path.join(SOUL_DIR, 'CLAUDE.md'))).toBe(true)
    expect(fs.existsSync(path.join(SOUL_DIR, 'insights'))).toBe(true)
  })

  it('should write CLAUDE.md with evolution rules', () => {
    ensureSoulProject()
    const content = fs.readFileSync(path.join(SOUL_DIR, 'CLAUDE.md'), 'utf-8')
    expect(content).toContain('SOUL Evolution Agent')
    expect(content).toContain('Conservative updates')
    expect(content).toContain('evolution-log.jsonl')
  })

  it('should not overwrite existing SOUL.json', () => {
    // Write a custom SOUL.json
    ensureSoulProject()
    const customSoul = { identity: { name: 'Test', role: '', expertise: [] }, preferences: { communicationStyle: 'test', decisionStyle: '', riskTolerance: '' }, values: {}, context: { activeGoals: [], domain: '', constraints: [] }, meta: { version: 99, lastUpdated: '', evolutionLog: [] } }
    fs.writeFileSync(SOUL_JSON, JSON.stringify(customSoul, null, 2), 'utf-8')

    // Re-ensure — should NOT overwrite
    ensureSoulProject()
    const loaded = JSON.parse(fs.readFileSync(SOUL_JSON, 'utf-8'))
    expect(loaded.meta.version).toBe(99)
    expect(loaded.identity.name).toBe('Test')
  })

  it('should register __soul__ in projects.json', () => {
    ensureSoulProject()
    const projectsFile = path.join(os.homedir(), '.codeclaws', 'projects.json')
    const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf-8'))
    const soul = projects.find((p: any) => p.id === '__soul__')
    expect(soul).toBeDefined()
    expect(soul.internal).toBe(true)
    expect(soul.path).toBe(SOUL_DIR)
  })
})
