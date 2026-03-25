import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initSoul } from '../agent.js'
import type { CoreEngine } from '../../core/index.js'
import type { TurnCloseEvent } from '../../types/index.js'

// Mock the settings module
vi.mock('../settings.js', () => ({
  isSoulEnabled: vi.fn().mockReturnValue(false),
}))

import { isSoulEnabled } from '../settings.js'

function createMockCore(): CoreEngine {
  const core = new EventEmitter() as any
  core.setMaxListeners(50)
  core.submitTurn = vi.fn()
  core.projects = { get: vi.fn(), getPath: vi.fn(), list: vi.fn() }
  core.sessions = { getMeta: vi.fn() }
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

describe('Soul subscriber', () => {
  let core: CoreEngine
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    core = createMockCore()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Reset mock
    vi.mocked(isSoulEnabled).mockReturnValue(false)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('should subscribe to turn:close events', () => {
    const onSpy = vi.spyOn(core, 'on')
    initSoul(core)

    expect(onSpy).toHaveBeenCalledWith('turn:close', expect.any(Function))
  })

  it('should only trigger on user type turns', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    // Emit a cron turn close — should NOT trigger evolution
    const cronEvent = makeTurnCloseEvent({ type: 'cron' })
    core.emit('turn:close', cronEvent)

    // Give async a chance to run
    await new Promise(resolve => setTimeout(resolve, 10))

    // Evolution should NOT have been triggered (no log for cron turns)
    const evolutionLogs = consoleSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[Soul] Evolution triggered'),
    )
    expect(evolutionLogs).toHaveLength(0)
  })

  it('should skip short interactions (< MIN_INTERACTION_LENGTH)', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    // Emit a turn close with a very short result
    const shortEvent = makeTurnCloseEvent({ result: 'Hi' })
    core.emit('turn:close', shortEvent)

    await new Promise(resolve => setTimeout(resolve, 10))

    const evolutionLogs = consoleSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[Soul] Evolution triggered'),
    )
    expect(evolutionLogs).toHaveLength(0)
  })

  it('should not trigger when soul is disabled', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(false)
    initSoul(core)

    const event = makeTurnCloseEvent()
    core.emit('turn:close', event)

    await new Promise(resolve => setTimeout(resolve, 10))

    const evolutionLogs = consoleSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[Soul] Evolution triggered'),
    )
    expect(evolutionLogs).toHaveLength(0)
  })

  it('should trigger evolution for valid user turn when soul is enabled', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    const event = makeTurnCloseEvent({
      type: 'user',
      result: 'This is a response long enough to trigger soul evolution',
    })
    core.emit('turn:close', event)

    await new Promise(resolve => setTimeout(resolve, 50))

    const evolutionLogs = consoleSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[Soul] Evolution triggered'),
    )
    expect(evolutionLogs).toHaveLength(1)
  })

  it('should not trigger for channel type turns', async () => {
    vi.mocked(isSoulEnabled).mockReturnValue(true)
    initSoul(core)

    const channelEvent = makeTurnCloseEvent({ type: 'channel' })
    core.emit('turn:close', channelEvent)

    await new Promise(resolve => setTimeout(resolve, 10))

    const evolutionLogs = consoleSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[Soul] Evolution triggered'),
    )
    expect(evolutionLogs).toHaveLength(0)
  })
})
