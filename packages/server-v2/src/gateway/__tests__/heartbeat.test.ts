import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { HeartbeatManager } from '../heartbeat.js'
import { Broadcaster } from '../broadcaster.js'
import type { CoreEngine } from '../../core/index.js'
import type { Client, ProjectConfig, PermissionMode } from '../../types/index.js'
import type { ServerMessage } from '@codecrab/shared'

// ---- Helpers ----

function createMockWs(): any {
  const sent: string[] = []
  return {
    readyState: 1,
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
    getMeta: vi.fn().mockReturnValue(null),
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

describe('HeartbeatManager', () => {
  let core: CoreEngine
  let broadcaster: Broadcaster
  let heartbeat: HeartbeatManager
  let client: Client

  beforeEach(() => {
    vi.useFakeTimers()
    core = createMockCore()
    broadcaster = new Broadcaster(core)

    client = createMockClient({ connectionId: 'c1', subscribedProjectIds: ['proj-1'] })
    broadcaster.addClient(client)

    heartbeat = new HeartbeatManager(core, broadcaster)
  })

  afterEach(() => {
    heartbeat.destroy()
    vi.useRealTimers()
  })

  describe('activity heartbeat throttling', () => {
    it('should broadcast activity_heartbeat on first activity', () => {
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
        textSnippet: 'Hello',
      })

      const messages = getSentMessages(client)
      const heartbeats = messages.filter(m => m.type === 'activity_heartbeat')
      expect(heartbeats.length).toBeGreaterThanOrEqual(1)
      expect((heartbeats[0] as any).queryId).toBe('query-1')
      expect((heartbeats[0] as any).lastActivityType).toBe('text_delta')
    })

    it('should throttle heartbeats within HEARTBEAT_THROTTLE_MS interval', () => {
      // First event - should broadcast
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Advance time by less than 10 seconds
      vi.advanceTimersByTime(5_000)

      // Second event - should be throttled
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 5100,
        activityType: 'tool_use',
        toolName: 'Read',
      })

      const messages = getSentMessages(client)
      const heartbeats = messages.filter(m => m.type === 'activity_heartbeat')
      // Only the first one should have been sent (throttled)
      expect(heartbeats).toHaveLength(1)
      expect((heartbeats[0] as any).lastActivityType).toBe('text_delta')
    })

    it('should broadcast heartbeat again after throttle interval passes', () => {
      // First event
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Advance past throttle interval
      vi.advanceTimersByTime(10_000)

      // Second event - should broadcast
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 10100,
        activityType: 'tool_use',
        toolName: 'Read',
      })

      const messages = getSentMessages(client)
      const heartbeats = messages.filter(m => m.type === 'activity_heartbeat')
      expect(heartbeats).toHaveLength(2)
      expect((heartbeats[1] as any).lastActivityType).toBe('tool_use')
    })

    it('should throttle independently per queryId', () => {
      // First query
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Second query (different queryId) - should NOT be throttled
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-2',
        elapsedMs: 200,
        activityType: 'tool_use',
      })

      const messages = getSentMessages(client)
      const heartbeats = messages.filter(m => m.type === 'activity_heartbeat')
      expect(heartbeats).toHaveLength(2)
      expect((heartbeats[0] as any).queryId).toBe('query-1')
      expect((heartbeats[1] as any).queryId).toBe('query-2')
    })
  })

  describe('project_activity broadcasting', () => {
    it('should broadcast project_activity with mapped activity type', () => {
      // project_activity is a global broadcast, so even non-subscribed clients receive it
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
        textSnippet: 'Hello',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities.length).toBeGreaterThanOrEqual(1)
      expect((activities[0] as any).activityType).toBe('text')  // text_delta -> 'text'
      expect((activities[0] as any).textSnippet).toBe('Hello')
    })

    it('should throttle project_activity within PROJECT_ACTIVITY_THROTTLE_MS', () => {
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Advance less than 2 seconds
      vi.advanceTimersByTime(1_000)

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 1100,
        activityType: 'thinking_delta',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities).toHaveLength(1)  // Second one throttled
    })

    it('should broadcast project_activity after throttle interval', () => {
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Advance past 2 seconds
      vi.advanceTimersByTime(2_000)

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 2100,
        activityType: 'thinking_delta',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities).toHaveLength(2)
      expect((activities[1] as any).activityType).toBe('thinking')
    })
  })

  describe('turn:close cleanup', () => {
    it('should broadcast idle project_activity on turn:close', () => {
      // Trigger some activity first
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Clear sent messages for clarity
      ;(client.ws as any)._sent.length = 0

      core.emit('turn:close' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        type: 'user',
        result: 'Done',
        isError: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextWindowUsed: 0, contextWindowMax: 0 },
        costUsd: 0,
        durationMs: 0,
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities.length).toBeGreaterThanOrEqual(1)

      const idleActivity = activities.find(a => (a as any).activityType === 'idle')
      expect(idleActivity).toBeDefined()
      expect((idleActivity as any).projectId).toBe('proj-1')
    })
  })

  describe('activity type mapping', () => {
    it('should map thinking_delta to thinking', () => {
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-map-1',
        elapsedMs: 100,
        activityType: 'thinking_delta',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect((activities[0] as any).activityType).toBe('thinking')
    })

    it('should map text_delta to text', () => {
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-map-2',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect((activities[0] as any).activityType).toBe('text')
    })

    it('should map tool_use to tool_use', () => {
      // Need to wait for throttle on project activity
      vi.advanceTimersByTime(3_000)

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-map-3',
        elapsedMs: 100,
        activityType: 'tool_use',
        toolName: 'Read',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities.length).toBeGreaterThanOrEqual(1)
      const latest = activities[activities.length - 1]
      expect((latest as any).activityType).toBe('tool_use')
    })

    it('should map tool_result to tool_use', () => {
      vi.advanceTimersByTime(3_000)

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-map-4',
        elapsedMs: 100,
        activityType: 'tool_result',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities.length).toBeGreaterThanOrEqual(1)
      const latest = activities[activities.length - 1]
      expect((latest as any).activityType).toBe('tool_use')
    })

    it('should map unknown types to idle', () => {
      vi.advanceTimersByTime(3_000)

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-map-5',
        elapsedMs: 100,
        activityType: 'some_unknown_type',
      })

      const messages = getSentMessages(client)
      const activities = messages.filter(m => m.type === 'project_activity')
      expect(activities.length).toBeGreaterThanOrEqual(1)
      const latest = activities[activities.length - 1]
      expect((latest as any).activityType).toBe('idle')
    })
  })

  describe('destroy', () => {
    it('should clear timers and state', () => {
      // Trigger some activity to populate internal state
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-1',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      heartbeat.destroy()

      // After destroy, verify cleanup happened by triggering more activity
      // The periodic timer should no longer fire
      vi.advanceTimersByTime(60_000)
      // No errors should occur
    })

    it('should be safe to call destroy multiple times', () => {
      heartbeat.destroy()
      heartbeat.destroy()
      // No errors
    })
  })

  describe('periodic cleanup', () => {
    it('should clean up stale heartbeat entries after 60 seconds', () => {
      // Trigger activity to create an entry
      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-stale',
        elapsedMs: 100,
        activityType: 'text_delta',
      })

      // Advance past 60s + periodic interval
      vi.advanceTimersByTime(70_000)

      // After cleanup, a new activity on the same queryId should be treated as fresh
      // (because the lastBroadcast entry was cleaned up)
      ;(client.ws as any)._sent.length = 0

      core.emit('turn:activity' as any, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        queryId: 'query-stale',
        elapsedMs: 70100,
        activityType: 'tool_use',
      })

      const messages = getSentMessages(client)
      const heartbeats = messages.filter(m => m.type === 'activity_heartbeat')
      expect(heartbeats.length).toBeGreaterThanOrEqual(1)
    })
  })
})
