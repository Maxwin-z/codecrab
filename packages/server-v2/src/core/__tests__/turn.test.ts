import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { TurnManager } from '../turn.js'
import { SessionManager } from '../session.js'
import type { CoreEngine } from '../index.js'
import type { AgentInterface, AgentStreamEvent, AgentQueryOptions, ProjectConfig, PermissionMode } from '../../types/index.js'

// Helper: create a mock agent that yields controlled stream events
function createMockAgent(events: AgentStreamEvent[] = []): AgentInterface & {
  queryMock: ReturnType<typeof vi.fn>
  abortMock: ReturnType<typeof vi.fn>
  resolvePermissionMock: ReturnType<typeof vi.fn>
  resolveQuestionMock: ReturnType<typeof vi.fn>
  denyQuestionMock: ReturnType<typeof vi.fn>
} {
  const queryMock = vi.fn()
  const abortMock = vi.fn()
  const probeMock = vi.fn()
  const resolvePermissionMock = vi.fn()
  const resolveQuestionMock = vi.fn()

  queryMock.mockImplementation(async function* () {
    for (const event of events) {
      yield event
    }
  })

  const denyQuestionMock = vi.fn()

  return {
    query: queryMock,
    abort: abortMock,
    probe: probeMock,
    resolvePermission: resolvePermissionMock,
    resolveQuestion: resolveQuestionMock,
    denyQuestion: denyQuestionMock,
    queryMock,
    abortMock,
    resolvePermissionMock,
    resolveQuestionMock,
    denyQuestionMock,
  }
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/tmp/test-project',
    icon: '',
    defaultProviderId: 'claude-sonnet-4-6',
    defaultPermissionMode: 'default' as PermissionMode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// Create a mock CoreEngine (extends EventEmitter, with projects stub)
function createMockCore(): CoreEngine {
  const core = new EventEmitter() as any
  core.setMaxListeners(50)
  core.projects = {
    getPath: vi.fn().mockReturnValue('/tmp/test-project'),
    get: vi.fn().mockReturnValue(makeProject()),
    list: vi.fn().mockReturnValue([]),
    getDefaultProvider: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    resolveProviderConfig: vi.fn().mockReturnValue(null),
    buildProviderEnv: vi.fn().mockReturnValue({}),
    load: vi.fn(),
  }
  // Use the typed emit/on from CoreEngine
  return core as CoreEngine
}

describe('TurnManager', () => {
  let agent: ReturnType<typeof createMockAgent>
  let sessions: SessionManager
  let core: CoreEngine
  let turnManager: TurnManager
  let emittedEvents: Array<{ event: string; data: any }>

  beforeEach(async () => {
    vi.useFakeTimers()
    agent = createMockAgent()
    sessions = new SessionManager() // No disk dir needed, just in-memory
    core = createMockCore()
    turnManager = new TurnManager(agent, sessions, core)

    emittedEvents = []
    const originalEmit = EventEmitter.prototype.emit.bind(core)
    vi.spyOn(core, 'emit').mockImplementation(((event: string, data: any) => {
      emittedEvents.push({ event, data })
      return originalEmit(event, data)
    }) as any)
  })

  afterEach(() => {
    turnManager.destroy()
    vi.useRealTimers()
  })

  function setupSession(sessionId: string = 'sess-1', projectId: string = 'proj-1'): void {
    const project = makeProject({ id: projectId })
    const meta = sessions.create(projectId, project)
    sessions.register(sessionId, meta)
  }

  describe('submit', () => {
    it('should enqueue a turn and return a queryId', () => {
      setupSession()
      const queryId = turnManager.submit({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        prompt: 'hello',
        type: 'user',
      })
      expect(queryId).toMatch(/^query-/)
    })
  })

  describe('execute — stream event translation', () => {
    it('should translate text_delta to turn:delta', async () => {
      const events: AgentStreamEvent[] = [{ type: 'text_delta', text: 'Hello world' }]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'hi', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const deltaEvents = emittedEvents.filter((e) => e.event === 'turn:delta')
      expect(deltaEvents.length).toBeGreaterThanOrEqual(1)
      expect(deltaEvents[0].data.deltaType).toBe('text')
      expect(deltaEvents[0].data.text).toBe('Hello world')
    })

    it('should translate thinking_delta to turn:delta with thinking type', async () => {
      const events: AgentStreamEvent[] = [{ type: 'thinking_delta', text: 'Let me think...' }]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'think', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const deltaEvents = emittedEvents.filter((e) => e.event === 'turn:delta')
      expect(deltaEvents.length).toBeGreaterThanOrEqual(1)
      expect(deltaEvents[0].data.deltaType).toBe('thinking')
    })

    it('should translate tool_use to turn:tool_use', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'tool_use', toolName: 'Read', toolId: 'tool-1', input: { path: '/foo' }, summary: 'Reading file' },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'read', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const toolUseEvents = emittedEvents.filter((e) => e.event === 'turn:tool_use')
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(1)
      expect(toolUseEvents[0].data.toolName).toBe('Read')
      expect(toolUseEvents[0].data.toolId).toBe('tool-1')
    })

    it('should translate tool_result to turn:tool_result', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'tool_result', toolId: 'tool-1', content: 'file contents', isError: false, totalLength: 100 },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'read', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const resultEvents = emittedEvents.filter((e) => e.event === 'turn:tool_result')
      expect(resultEvents.length).toBeGreaterThanOrEqual(1)
      expect(resultEvents[0].data.content).toBe('file contents')
    })

    it('should translate result to turn:close and update session usage', async () => {
      const events: AgentStreamEvent[] = [
        {
          type: 'result',
          result: 'Done!',
          isError: false,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreateTokens: 5, contextWindowUsed: 500, contextWindowMax: 200000 },
          costUsd: 0.01,
          durationMs: 1000,
        },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'do it', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const closeEvents = emittedEvents.filter((e) => e.event === 'turn:close')
      expect(closeEvents.length).toBeGreaterThanOrEqual(1)
      expect(closeEvents[0].data.result).toBe('Done!')
      expect(closeEvents[0].data.costUsd).toBe(0.01)

      // Check session usage was updated
      const meta = sessions.getMeta('sess-1')!
      expect(meta.usage.totalInputTokens).toBe(100)
      expect(meta.usage.queryCount).toBe(1)
    })

    it('should translate permission_request and set session pending', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'permission_request', requestId: 'req-1', toolName: 'Write', input: { path: '/foo' }, reason: 'needs write' },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'write', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const permEvents = emittedEvents.filter((e) => e.event === 'interaction:permission_request')
      expect(permEvents.length).toBeGreaterThanOrEqual(1)
      expect(permEvents[0].data.requestId).toBe('req-1')

      const meta = sessions.getMeta('sess-1')!
      expect(meta.pendingPermissionRequest).toEqual({
        requestId: 'req-1',
        toolName: 'Write',
        input: { path: '/foo' },
        reason: 'needs write',
      })
    })

    it('should translate ask_user_question and set session pending', async () => {
      const questions = [{ question: 'Which file?', options: [] }]
      const events: AgentStreamEvent[] = [
        { type: 'ask_user_question', toolId: 'tool-ask', questions },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'ask', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const askEvents = emittedEvents.filter((e) => e.event === 'interaction:ask_question')
      expect(askEvents.length).toBeGreaterThanOrEqual(1)
      expect(askEvents[0].data.toolId).toBe('tool-ask')

      const meta = sessions.getMeta('sess-1')!
      expect(meta.pendingQuestion).toEqual({ toolId: 'tool-ask', questions })
    })

    it('should translate session_init and register session', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'session_init', sdkSessionId: 'sdk-new-id', tools: ['Read', 'Write'] },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'init', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const createdEvents = emittedEvents.filter((e) => e.event === 'session:created')
      expect(createdEvents.length).toBeGreaterThanOrEqual(1)
      expect(createdEvents[0].data.sessionId).toBe('sdk-new-id')
    })

    it('should translate assistant_text event', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'assistant_text', text: 'Full response text', parentToolUseId: null },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const textEvents = emittedEvents.filter((e) => e.event === 'turn:assistant_text')
      expect(textEvents.length).toBeGreaterThanOrEqual(1)
      expect(textEvents[0].data.text).toBe('Full response text')
    })

    it('should translate thinking_complete event', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'thinking_complete', thinking: 'I thought about it carefully' },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'think', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const thinkEvents = emittedEvents.filter((e) => e.event === 'turn:thinking_complete')
      expect(thinkEvents.length).toBeGreaterThanOrEqual(1)
      expect(thinkEvents[0].data.thinking).toBe('I thought about it carefully')
    })

    it('should translate query_summary event', async () => {
      const events: AgentStreamEvent[] = [{ type: 'query_summary', summary: 'Did stuff' }]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const summaryEvents = emittedEvents.filter((e) => e.event === 'turn:summary')
      expect(summaryEvents.length).toBeGreaterThanOrEqual(1)
      expect(summaryEvents[0].data.summary).toBe('Did stuff')
    })

    it('should translate query_suggestions event', async () => {
      const events: AgentStreamEvent[] = [{ type: 'query_suggestions', suggestions: ['Try this', 'Try that'] }]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const sugEvents = emittedEvents.filter((e) => e.event === 'turn:suggestions')
      expect(sugEvents.length).toBeGreaterThanOrEqual(1)
      expect(sugEvents[0].data.suggestions).toEqual(['Try this', 'Try that'])
    })

    it('should translate background_task_update event', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'background_task_update', taskId: 'bg-1', status: 'started', description: 'Running tests' },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const bgEvents = emittedEvents.filter((e) => e.event === 'turn:background_task')
      expect(bgEvents.length).toBeGreaterThanOrEqual(1)
      expect(bgEvents[0].data.taskId).toBe('bg-1')
      expect(bgEvents[0].data.status).toBe('started')
    })

    it('should emit turn:activity for text/thinking/tool events', async () => {
      const events: AgentStreamEvent[] = [
        { type: 'text_delta', text: 'hi' },
        { type: 'tool_use', toolName: 'Read', toolId: 't1', input: {} },
        { type: 'tool_result', toolId: 't1', content: 'ok', isError: false },
      ]
      agent.queryMock.mockImplementation(async function* () {
        for (const e of events) yield e
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const activityEvents = emittedEvents.filter((e) => e.event === 'turn:activity')
      expect(activityEvents.length).toBe(3)
      expect(activityEvents[0].data.activityType).toBe('text_delta')
      expect(activityEvents[1].data.activityType).toBe('tool_use')
      expect(activityEvents[1].data.toolName).toBe('Read')
      expect(activityEvents[2].data.activityType).toBe('tool_result')
    })
  })

  describe('session status transitions', () => {
    it('should transition: idle -> processing -> idle on success', async () => {
      agent.queryMock.mockImplementation(async function* () {
        // empty stream
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const statusEvents = emittedEvents.filter((e) => e.event === 'session:status_changed')
      const statuses = statusEvents.map((e) => e.data.status)
      expect(statuses).toContain('processing')
      expect(statuses[statuses.length - 1]).toBe('idle')
    })

    it('should transition to error on agent throw', async () => {
      agent.queryMock.mockImplementation(async function* () {
        throw new Error('Agent crashed')
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'crash', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const errorEmits = emittedEvents.filter((e) => e.event === 'turn:error')
      expect(errorEmits.length).toBeGreaterThanOrEqual(1)
      expect(errorEmits[0].data.error).toBe('Agent crashed')

      const statusEvents = emittedEvents.filter((e) => e.event === 'session:status_changed')
      const statuses = statusEvents.map((e) => e.data.status)
      expect(statuses).toContain('error')
    })
  })

  describe('error handling', () => {
    it('should emit turn:error when session not found', async () => {
      // Don't set up session
      turnManager.submit({ projectId: 'proj-1', sessionId: 'non-existent', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const errorEvents = emittedEvents.filter((e) => e.event === 'turn:error')
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)
      expect(errorEvents[0].data.error).toBe('Session not found')
    })

    it('should emit turn:error when project path not found', async () => {
      (core.projects.getPath as any).mockReturnValue(null)
      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const errorEvents = emittedEvents.filter((e) => e.event === 'turn:error')
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)
      expect(errorEvents[0].data.error).toBe('Project path not found')
    })
  })

  describe('abort', () => {
    it('should call agent.abort for the running session', async () => {
      agent.queryMock.mockImplementation(async function* () {
        // Hang forever
        await new Promise(() => {})
      })

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'hang', type: 'user' })
      await vi.advanceTimersByTimeAsync(50)

      turnManager.abort('proj-1')

      expect(agent.abortMock).toHaveBeenCalledWith('sess-1')
    })
  })

  describe('respondPermission', () => {
    it('should clear pending permission and call agent.resolvePermission', () => {
      setupSession()
      const meta = sessions.getMeta('sess-1')!
      sessions.setPendingPermission('sess-1', {
        requestId: 'req-1',
        toolName: 'Write',
        input: {},
      })

      turnManager.respondPermission('sess-1', 'req-1', 'allow')

      expect(meta.pendingPermissionRequest).toBeNull()
      expect(agent.resolvePermissionMock).toHaveBeenCalledWith('req-1', 'allow')
    })
  })

  describe('respondQuestion', () => {
    it('should clear pending question and call agent.resolveQuestion', () => {
      setupSession()
      sessions.setPendingQuestion('sess-1', 'tool-1', [])

      const answers = { q1: 'answer1' }
      turnManager.respondQuestion('sess-1', answers)

      const meta = sessions.getMeta('sess-1')!
      expect(meta.pendingQuestion).toBeNull()
      expect(agent.resolveQuestionMock).toHaveBeenCalledWith('tool-1', answers)
    })
  })

  describe('execute calls agent.query with correct options', () => {
    it('should pass session model, permissionMode, and project path', async () => {
      agent.queryMock.mockImplementation(async function* () {})

      const project = makeProject({ id: 'proj-1', defaultProviderId: 'claude-opus-4' })
      const meta = sessions.create('proj-1', project, { providerId: 'claude-opus-4', permissionMode: 'bypassPermissions' })
      sessions.register('sess-1', meta)

      turnManager.submit({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        prompt: 'do it',
        type: 'user',
        enabledMcps: ['mcp1'],
        disabledSdkServers: ['server1'],
        disabledSkills: ['skill1'],
        soulEnabled: true,
      })
      await vi.advanceTimersByTimeAsync(100)

      expect(agent.queryMock).toHaveBeenCalledTimes(1)
      const callArgs = agent.queryMock.mock.calls[0]
      expect(callArgs[0]).toBe('do it')
      const options = callArgs[1] as AgentQueryOptions
      expect(options.model).toBe('claude-opus-4')
      expect(options.permissionMode).toBe('bypassPermissions')
      expect(options.cwd).toBe('/tmp/test-project')
      expect(options.enabledMcps).toEqual(['mcp1'])
      expect(options.disabledSdkServers).toEqual(['server1'])
      expect(options.disabledSkills).toEqual(['skill1'])
      expect(options.soulEnabled).toBe(true)
    })
  })

  describe('queue methods delegation', () => {
    it('getQueueLength should return 0 for empty project', () => {
      expect(turnManager.getQueueLength('proj-1')).toBe(0)
    })

    it('getQueueSnapshot should return empty state', () => {
      const snapshot = turnManager.getQueueSnapshot('proj-1')
      expect(snapshot.running).toBeNull()
      expect(snapshot.queued).toHaveLength(0)
    })

    it('dequeue should return false for unknown query', () => {
      expect(turnManager.dequeue('non-existent')).toBe(false)
    })
  })

  describe('project status events', () => {
    it('should emit project:status_changed processing then idle', async () => {
      agent.queryMock.mockImplementation(async function* () {})

      setupSession()
      turnManager.submit({ projectId: 'proj-1', sessionId: 'sess-1', prompt: 'go', type: 'user' })
      await vi.advanceTimersByTimeAsync(100)

      const projEvents = emittedEvents.filter((e) => e.event === 'project:status_changed')
      const statuses = projEvents.map((e) => e.data.status)
      expect(statuses).toContain('processing')
      expect(statuses[statuses.length - 1]).toBe('idle')
    })
  })
})
