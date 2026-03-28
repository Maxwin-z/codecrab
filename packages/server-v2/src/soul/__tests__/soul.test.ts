import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initSoul, _resetForTest } from '../agent.js'
import type { CoreEngine } from '../../core/index.js'
import type { TurnCloseEvent, TurnStartEvent } from '../../types/index.js'

// Mock dependencies
vi.mock('../settings.js', () => ({
  isSoulEnabled: vi.fn().mockReturnValue(false),
}))

vi.mock('../state.js', () => ({
  loadSoulState: vi.fn().mockResolvedValue({ sessions: {} }),
  saveSoulState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../project.js', () => ({
  ensureSoulProject: vi.fn().mockResolvedValue('/mock/.codecrab/soul'),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'result', result: 'done' }
    },
  }),
}))

import { isSoulEnabled } from '../settings.js'
import { loadSoulState, saveSoulState } from '../state.js'

function createMockCore(): CoreEngine {
  const core = new EventEmitter() as any
  core.setMaxListeners(50)
  core.submitTurn = vi.fn()
  core.projects = {
    get: vi.fn(),
    getPath: vi.fn().mockReturnValue('/mock/project'),
    list: vi.fn(),
    getDefaultProvider: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    resolveProviderConfig: vi.fn().mockReturnValue(null),
    buildProviderEnv: vi.fn(),
  }
  core.sessions = {
    getMeta: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([
      { id: 'msg-1', role: 'user', content: 'Help me with this code', timestamp: 1 },
      { id: 'msg-2', role: 'assistant', content: 'Sure, I can help you refactor this module.', timestamp: 2 },
    ]),
  }
  core.turns = { destroy: vi.fn() }
  return core as CoreEngine
}

function makeTurnCloseEvent(overrides: Partial<TurnCloseEvent> = {}): TurnCloseEvent {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    type: 'user',
    result: 'This is a sufficiently long response for testing the soul system',
    isError: false,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      contextWindowUsed: 500,
      contextWindowMax: 200000,
    },
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
  }
}

function makeTurnStartEvent(overrides: Partial<TurnStartEvent> = {}): TurnStartEvent {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    queryId: 'query-1',
    prompt: 'test',
    type: 'user',
    ...overrides,
  }
}

describe('Soul subscriber', () => {
  let core: CoreEngine

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    _resetForTest()
    core = createMockCore()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(isSoulEnabled).mockReturnValue(false)
    vi.mocked(loadSoulState).mockResolvedValue({ sessions: {} })
    vi.mocked(saveSoulState).mockResolvedValue(undefined)
  })

  afterEach(() => {
    _resetForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('should subscribe to turn:close and turn:start events', () => {
    const onSpy = vi.spyOn(core, 'on')
    initSoul(core)

    expect(onSpy).toHaveBeenCalledWith('turn:start', expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith('turn:close', expect.any(Function))
  })

  it('should not set timer when soul is disabled', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(false)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent())

    // No timers should be pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('should set idle timer when soul is enabled and user turn closes', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent())

    // An idle timer should be pending
    expect(vi.getTimerCount()).toBe(1)
  })

  it('should not set timer for cron turns', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent({ type: 'cron' }))

    expect(vi.getTimerCount()).toBe(0)
  })

  it('should not set timer for channel turns', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent({ type: 'channel' }))

    expect(vi.getTimerCount()).toBe(0)
  })

  it('should cancel idle timer when user starts a new turn', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    // Turn closes → timer starts
    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-1' }))
    expect(vi.getTimerCount()).toBe(1)

    // New turn starts → timer should be cancelled
    core.emit('turn:start', makeTurnStartEvent({ sessionId: 'sess-1' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('should only cancel timer for the matching session', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    // Two sessions go idle
    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-1' }))
    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-2' }))
    expect(vi.getTimerCount()).toBe(2)

    // Only sess-1 becomes active again
    core.emit('turn:start', makeTurnStartEvent({ sessionId: 'sess-1' }))
    expect(vi.getTimerCount()).toBe(1)
  })

  it('should reset timer on subsequent turn closes', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-1' }))
    expect(vi.getTimerCount()).toBe(1)

    // Another turn closes for same session → timer resets (still 1)
    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-1' }))
    expect(vi.getTimerCount()).toBe(1)
  })

  it('should trigger evolution after 5 minutes of inactivity', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent())

    // Advance time by 5 minutes
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    // Evolution should have been triggered: saveSoulState called
    expect(saveSoulState).toHaveBeenCalled()
  })

  it('should not trigger evolution if disabled when timer fires', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent())

    // Disable soul before timer fires
    vi.mocked(isSoulEnabled).mockReturnValue(false)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(saveSoulState).not.toHaveBeenCalled()
  })

  it('should process only incremental messages', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    // Simulate that 1 message was already processed
    vi.mocked(loadSoulState).mockResolvedValue({
      sessions: { 'sess-1': { lastEvolvedMessageCount: 1 } },
    })
    ;(core.sessions as any).getHistory.mockResolvedValue([
      { id: 'msg-1', role: 'user', content: 'Old message', timestamp: 1 },
      { id: 'msg-2', role: 'assistant', content: 'Old response', timestamp: 2 },
      { id: 'msg-3', role: 'user', content: 'New message', timestamp: 3 },
    ])

    initSoul(core)
    core.emit('turn:close', makeTurnCloseEvent())
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    // Should save with total message count (3)
    expect(saveSoulState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: expect.objectContaining({
          'sess-1': { lastEvolvedMessageCount: 3 },
        }),
      }),
    )
  })

  it('should skip evolution if no new messages', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    vi.mocked(loadSoulState).mockResolvedValue({
      sessions: { 'sess-1': { lastEvolvedMessageCount: 2 } },
    })
    ;(core.sessions as any).getHistory.mockResolvedValue([
      { id: 'msg-1', role: 'user', content: 'Old message', timestamp: 1 },
      { id: 'msg-2', role: 'assistant', content: 'Old response', timestamp: 2 },
    ])

    initSoul(core)
    core.emit('turn:close', makeTurnCloseEvent())
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(saveSoulState).not.toHaveBeenCalled()
  })

  it('should clean up timers on destroy', () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    const consumer = initSoul(core)

    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-1' }))
    core.emit('turn:close', makeTurnCloseEvent({ sessionId: 'sess-2' }))
    expect(vi.getTimerCount()).toBe(2)

    consumer.destroy()
    expect(vi.getTimerCount()).toBe(0)
  })
})
