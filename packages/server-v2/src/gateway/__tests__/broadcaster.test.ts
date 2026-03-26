import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Broadcaster } from '../broadcaster.js'
import type { CoreEngine } from '../../core/index.js'
import type { Client, ProjectConfig, PermissionMode, SessionMeta } from '../../types/index.js'
import { createEmptyUsage } from '../../types/index.js'
import type { ServerMessage } from '@codecrab/shared'

// ---- Helpers ----

function createMockWs(open = true): any {
  const sent: string[] = []
  return {
    readyState: open ? 1 : 3,  // 1 = OPEN, 3 = CLOSED
    send: vi.fn((data: string) => sent.push(data)),
    _sent: sent,
  }
}

function createMockClient(overrides: Partial<Client> & { subscribedProjectIds?: string[] } = {}): Client {
  const { subscribedProjectIds, ...rest } = overrides
  const subscribedProjects = new Map<string, { sessionId?: string }>()
  if (subscribedProjectIds) {
    for (const id of subscribedProjectIds) {
      subscribedProjects.set(id, {})
    }
  }
  return {
    ws: createMockWs(),
    connectionId: `conn-${Math.random().toString(36).slice(2, 8)}`,
    clientId: `client-${Math.random().toString(36).slice(2, 8)}`,
    subscribedProjects,
    ...rest,
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

function makeSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sdkSessionId: 'sess-1',
    projectId: 'proj-1',
    status: 'idle',
    providerId: 'claude-sonnet-4-6',
    permissionMode: 'default',
    createdAt: Date.now(),
    usage: {
      ...createEmptyUsage(),
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 10,
      totalCacheCreateTokens: 5,
      totalCostUsd: 0.01,
      totalDurationMs: 1000,
      queryCount: 1,
      contextWindowUsed: 500,
      contextWindowMax: 200000,
    },
    ...overrides,
  }
}

function createMockCore(): CoreEngine {
  const core = new EventEmitter() as any
  core.setMaxListeners(50)
  core.projects = {
    list: vi.fn().mockReturnValue([makeProject()]),
    get: vi.fn().mockReturnValue(makeProject()),
    getPath: vi.fn().mockReturnValue('/tmp/test-project'),
    getDefaultProvider: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    load: vi.fn(),
  }
  core.sessions = {
    getMeta: vi.fn().mockReturnValue(makeSessionMeta()),
    list: vi.fn().mockReturnValue([]),
    create: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setStatus: vi.fn(),
    findActive: vi.fn(),
    findLatest: vi.fn(),
    load: vi.fn(),
  }
  core.turns = {
    submit: vi.fn(),
    abort: vi.fn(),
    respondQuestion: vi.fn(),
    respondPermission: vi.fn(),
    getQueueSnapshot: vi.fn().mockReturnValue({ running: null, queued: [] }),
    dequeue: vi.fn(),
    forceExecute: vi.fn(),
    getQueueLength: vi.fn().mockReturnValue(0),
    destroy: vi.fn(),
  }
  return core as CoreEngine
}

function getSentMessages(client: Client): ServerMessage[] {
  return (client.ws as any)._sent.map((s: string) => JSON.parse(s))
}

// ---- Tests ----

describe('Broadcaster', () => {
  let core: CoreEngine
  let broadcaster: Broadcaster

  beforeEach(() => {
    core = createMockCore()
    broadcaster = new Broadcaster(core)
  })

  describe('client management', () => {
    it('should add and retrieve a client', () => {
      const client = createMockClient({ connectionId: 'conn-1' })
      broadcaster.addClient(client)
      expect(broadcaster.getClient('conn-1')).toBe(client)
    })

    it('should remove a client', () => {
      const client = createMockClient({ connectionId: 'conn-1' })
      broadcaster.addClient(client)
      broadcaster.removeClient('conn-1')
      expect(broadcaster.getClient('conn-1')).toBeUndefined()
    })

    it('should return undefined for unknown connectionId', () => {
      expect(broadcaster.getClient('nonexistent')).toBeUndefined()
    })
  })

  describe('getClientsForProject', () => {
    it('should return clients subscribed to the project', () => {
      const client1 = createMockClient({ connectionId: 'c1', subscribedProjectIds: ['proj-1'] })
      const client2 = createMockClient({ connectionId: 'c2', subscribedProjectIds: ['proj-2'] })
      const client3 = createMockClient({ connectionId: 'c3', subscribedProjectIds: ['proj-1', 'proj-2'] })

      broadcaster.addClient(client1)
      broadcaster.addClient(client2)
      broadcaster.addClient(client3)

      const proj1Clients = broadcaster.getClientsForProject('proj-1')
      expect(proj1Clients).toHaveLength(2)
      expect(proj1Clients).toContain(client1)
      expect(proj1Clients).toContain(client3)
      expect(proj1Clients).not.toContain(client2)
    })

    it('should return empty array when no clients subscribed', () => {
      expect(broadcaster.getClientsForProject('proj-99')).toHaveLength(0)
    })
  })

  describe('send', () => {
    it('should send JSON message to client with open WebSocket', () => {
      const client = createMockClient()
      const message: ServerMessage = { type: 'error', message: 'test' }
      broadcaster.send(client, message)

      expect(client.ws.send).toHaveBeenCalledTimes(1)
      const sent = JSON.parse((client.ws.send as any).mock.calls[0][0])
      expect(sent.type).toBe('error')
      expect(sent.message).toBe('test')
    })

    it('should skip sending to closed WebSocket', () => {
      const ws = createMockWs(false)  // closed
      const client = createMockClient({ ws })
      const message: ServerMessage = { type: 'error', message: 'test' }
      broadcaster.send(client, message)

      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe('broadcastToProject', () => {
    it('should send to all clients subscribed to the project', () => {
      const client1 = createMockClient({ connectionId: 'c1', subscribedProjectIds: ['proj-1'] })
      const client2 = createMockClient({ connectionId: 'c2', subscribedProjectIds: ['proj-1'] })
      const client3 = createMockClient({ connectionId: 'c3', subscribedProjectIds: ['proj-2'] })

      broadcaster.addClient(client1)
      broadcaster.addClient(client2)
      broadcaster.addClient(client3)

      broadcaster.broadcastToProject('proj-1', { type: 'error', message: 'hello' })

      expect(client1.ws.send).toHaveBeenCalledTimes(1)
      expect(client2.ws.send).toHaveBeenCalledTimes(1)
      expect(client3.ws.send).not.toHaveBeenCalled()
    })
  })

  describe('broadcastGlobal', () => {
    it('should send to all connected clients', () => {
      const client1 = createMockClient({ connectionId: 'c1' })
      const client2 = createMockClient({ connectionId: 'c2' })

      broadcaster.addClient(client1)
      broadcaster.addClient(client2)

      broadcaster.broadcastGlobal({ type: 'error', message: 'global' })

      expect(client1.ws.send).toHaveBeenCalledTimes(1)
      expect(client2.ws.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('Core event -> client message mapping', () => {
    let client: Client

    beforeEach(() => {
      client = createMockClient({ connectionId: 'c1', subscribedProjectIds: ['proj-1'] })
      broadcaster.addClient(client)
    })

    it('turn:start -> user_message + query_start', () => {
      core.emit('turn:start' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        queryId: 'query-1',
        prompt: 'hello',
        type: 'user',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(2)
      expect(messages[0].type).toBe('user_message')
      expect((messages[0] as any).message.role).toBe('user')
      expect((messages[0] as any).message.content).toBe('hello')
      expect(messages[1].type).toBe('query_start')
      expect((messages[1] as any).queryId).toBe('query-1')
    })

    it('turn:delta -> stream_delta', () => {
      core.emit('turn:delta' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        deltaType: 'text',
        text: 'Hello world',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('stream_delta')
      expect((messages[0] as any).deltaType).toBe('text')
      expect((messages[0] as any).text).toBe('Hello world')
    })

    it('turn:tool_use -> tool_use', () => {
      core.emit('turn:tool_use' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        toolName: 'Read',
        toolId: 'tool-1',
        input: { path: '/foo' },
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('tool_use')
      expect((messages[0] as any).toolName).toBe('Read')
      expect((messages[0] as any).toolId).toBe('tool-1')
      expect((messages[0] as any).input).toEqual({ path: '/foo' })
    })

    it('turn:tool_result -> tool_result', () => {
      core.emit('turn:tool_result' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        toolId: 'tool-1',
        content: 'file contents',
        isError: false,
        totalLength: 100,
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('tool_result')
      expect((messages[0] as any).toolId).toBe('tool-1')
      expect((messages[0] as any).content).toBe('file contents')
      expect((messages[0] as any).isError).toBe(false)
      expect((messages[0] as any).totalLength).toBe(100)
    })

    it('turn:close -> result + query_end + session_usage', () => {
      core.emit('turn:close' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        type: 'user',
        result: 'Done!',
        isError: false,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreateTokens: 5, contextWindowUsed: 500, contextWindowMax: 200000 },
        costUsd: 0.01,
        durationMs: 1000,
        hasBackgroundTasks: true,
        backgroundTaskIds: ['bg-1'],
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(3)

      // result
      expect(messages[0].type).toBe('result')
      expect((messages[0] as any).subtype).toBe('success')
      expect((messages[0] as any).costUsd).toBe(0.01)
      expect((messages[0] as any).result).toBe('Done!')

      // query_end
      expect(messages[1].type).toBe('query_end')
      expect((messages[1] as any).hasBackgroundTasks).toBe(true)
      expect((messages[1] as any).backgroundTaskIds).toEqual(['bg-1'])

      // session_usage
      expect(messages[2].type).toBe('session_usage')
      expect((messages[2] as any).totalInputTokens).toBe(100)
      expect((messages[2] as any).totalCostUsd).toBe(0.01)
      expect((messages[2] as any).queryCount).toBe(1)
    })

    it('turn:close with isError -> result subtype error', () => {
      core.emit('turn:close' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        type: 'user',
        result: 'Failed',
        isError: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextWindowUsed: 0, contextWindowMax: 0 },
        costUsd: 0,
        durationMs: 0,
      })

      const messages = getSentMessages(client)
      expect(messages[0].type).toBe('result')
      expect((messages[0] as any).subtype).toBe('error')
    })

    it('turn:close with no session meta -> result + query_end only (no session_usage)', () => {
      ;(core.sessions.getMeta as any).mockReturnValue(null)

      core.emit('turn:close' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-unknown',
        turnId: 'turn-1',
        type: 'user',
        result: 'Done',
        isError: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextWindowUsed: 0, contextWindowMax: 0 },
        costUsd: 0,
        durationMs: 0,
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(2)  // result + query_end, no session_usage
      expect(messages[0].type).toBe('result')
      expect(messages[1].type).toBe('query_end')
    })

    it('turn:error -> error', () => {
      core.emit('turn:error' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        error: 'Something went wrong',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('error')
      expect((messages[0] as any).message).toBe('Something went wrong')
    })

    it('turn:assistant_text -> assistant_text', () => {
      core.emit('turn:assistant_text' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        text: 'Full response',
        parentToolUseId: 'parent-1',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('assistant_text')
      expect((messages[0] as any).text).toBe('Full response')
      expect((messages[0] as any).parentToolUseId).toBe('parent-1')
    })

    it('turn:thinking_complete -> thinking', () => {
      core.emit('turn:thinking_complete' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        thinking: 'Deep thoughts',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('thinking')
      expect((messages[0] as any).thinking).toBe('Deep thoughts')
    })

    it('turn:summary -> query_summary', () => {
      core.emit('turn:summary' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        summary: 'Did some work',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('query_summary')
      expect((messages[0] as any).summary).toBe('Did some work')
    })

    it('turn:suggestions -> query_suggestions', () => {
      core.emit('turn:suggestions' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        suggestions: ['Try this', 'Try that'],
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('query_suggestions')
      expect((messages[0] as any).suggestions).toEqual(['Try this', 'Try that'])
    })

    it('turn:sdk_event -> sdk_event', () => {
      const sdkEvent = { ts: Date.now(), type: 'tool_use' as const, detail: 'Read' }
      core.emit('turn:sdk_event' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        event: sdkEvent,
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('sdk_event')
      expect((messages[0] as any).event).toEqual(sdkEvent)
    })

    it('turn:background_task -> background_task_update', () => {
      core.emit('turn:background_task' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        taskId: 'bg-1',
        status: 'started',
        description: 'Running tests',
        summary: undefined,
        usage: { totalTokens: 100, toolUses: 5, durationMs: 2000 },
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('background_task_update')
      expect((messages[0] as any).taskId).toBe('bg-1')
      expect((messages[0] as any).status).toBe('started')
      expect((messages[0] as any).description).toBe('Running tests')
      expect((messages[0] as any).usage).toEqual({ totalTokens: 100, toolUses: 5, durationMs: 2000 })
    })

    it('interaction:ask_question -> ask_user_question', () => {
      const questions = [{ question: 'Which file?', options: [{ label: 'foo.ts' }] }]
      core.emit('interaction:ask_question' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        toolId: 'tool-ask',
        questions,
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('ask_user_question')
      expect((messages[0] as any).toolId).toBe('tool-ask')
      expect((messages[0] as any).questions).toEqual(questions)
    })

    it('interaction:permission_request -> permission_request', () => {
      core.emit('interaction:permission_request' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        requestId: 'req-1',
        toolName: 'Write',
        input: { path: '/foo' },
        reason: 'needs write access',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('permission_request')
      expect((messages[0] as any).requestId).toBe('req-1')
      expect((messages[0] as any).toolName).toBe('Write')
      expect((messages[0] as any).reason).toBe('needs write access')
    })

    it('interaction:permission_request with no reason -> empty string', () => {
      core.emit('interaction:permission_request' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        requestId: 'req-1',
        toolName: 'Write',
        input: {},
      })

      const messages = getSentMessages(client)
      expect((messages[0] as any).reason).toBe('')
    })

    it('session:created -> session_created', () => {
      core.emit('session:created' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-new',
        parentSessionId: 'sess-parent',
        cronJobId: 'cron-1',
        cronJobName: 'Daily check',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('session_created')
      expect((messages[0] as any).sessionId).toBe('sess-new')
      expect((messages[0] as any).parentSessionId).toBe('sess-parent')
      expect((messages[0] as any).cronJobId).toBe('cron-1')
      expect((messages[0] as any).cronJobName).toBe('Daily check')
    })

    it('session:resumed -> session_resumed', () => {
      core.emit('session:resumed' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('session_resumed')
      expect((messages[0] as any).sessionId).toBe('sess-1')
    })

    it('session:status_changed -> session_status_changed', () => {
      core.emit('session:status_changed' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        status: 'processing',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('session_status_changed')
      expect((messages[0] as any).status).toBe('processing')
    })

    it('project:status_changed -> project_statuses (global broadcast)', () => {
      // Add a second client not subscribed to proj-1
      const client2 = createMockClient({ connectionId: 'c2' })
      broadcaster.addClient(client2)

      core.emit('project:status_changed' as any, {
        projectId: 'proj-1',
        status: 'processing',
        sessionId: 'sess-1',
      })

      // Both clients should receive (global broadcast)
      const messages1 = getSentMessages(client)
      const messages2 = getSentMessages(client2)
      expect(messages1).toHaveLength(1)
      expect(messages2).toHaveLength(1)
      expect(messages1[0].type).toBe('project_statuses')
      expect((messages1[0] as any).statuses).toBeInstanceOf(Array)
    })

    it('queue:status -> query_queue_status', () => {
      core.emit('queue:status' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        status: 'queued',
        position: 0,
        queueLength: 1,
        prompt: 'do something',
        queryType: 'user',
      })

      const messages = getSentMessages(client)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('query_queue_status')
      expect((messages[0] as any).queryId).toBe('query-1')
      expect((messages[0] as any).status).toBe('queued')
      expect((messages[0] as any).position).toBe(0)
      expect((messages[0] as any).queueLength).toBe(1)
    })
  })

  describe('routing correctness', () => {
    it('should not send project-scoped events to clients not subscribed to that project', () => {
      const client1 = createMockClient({ connectionId: 'c1', subscribedProjectIds: ['proj-1'] })
      const client2 = createMockClient({ connectionId: 'c2', subscribedProjectIds: ['proj-2'] })

      broadcaster.addClient(client1)
      broadcaster.addClient(client2)

      core.emit('turn:delta' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        deltaType: 'text',
        text: 'Hello',
      })

      expect(client1.ws.send).toHaveBeenCalledTimes(1)
      expect(client2.ws.send).not.toHaveBeenCalled()
    })
  })
})
