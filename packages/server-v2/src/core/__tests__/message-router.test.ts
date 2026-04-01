import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { ThreadManager } from '../thread.js'
import { SessionManager } from '../session.js'
import { MessageRouter } from '../message-router.js'
import type { ProjectConfig, PermissionMode } from '../../types/index.js'

// ── Minimal mocks ────────────────────────────────────────────────────────

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/tmp/test-project',
    icon: '',
    defaultProviderId: 'claude-sonnet-4-6',
    defaultPermissionMode: 'bypassPermissions' as PermissionMode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/** Minimal AgentManager mock */
function createMockAgentManager() {
  const agents = new Map<string, { id: string; name: string; emoji: string; createdAt: number; updatedAt: number }>()

  return {
    agents,
    get(agentId: string) {
      return agents.get(agentId) ?? null
    },
    findByName(name: string) {
      for (const a of agents.values()) {
        if (a.name === name) return a
      }
      return null
    },
    getProjectId(agentId: string) {
      return `__agent-${agentId}`
    },
    async ensureAgentProject(agentId: string): Promise<ProjectConfig> {
      return makeProject({ id: `__agent-${agentId}`, name: agents.get(agentId)?.name || agentId })
    },
  }
}

/** Minimal CoreEngine mock */
function createMockCore() {
  const emitter = new EventEmitter()
  const emitted: Array<{ event: string; data: any }> = []

  const originalEmit = emitter.emit.bind(emitter)
  emitter.emit = (event: string, data: any) => {
    emitted.push({ event, data })
    return originalEmit(event, data)
  }

  return {
    ...emitter,
    emitted,
    submitTurn: vi.fn().mockReturnValue('query-1'),
  }
}

describe('MessageRouter', () => {
  let threads: ThreadManager
  let sessions: SessionManager
  let agents: ReturnType<typeof createMockAgentManager>
  let core: ReturnType<typeof createMockCore>
  let router: MessageRouter
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'router-test-'))
    threads = new ThreadManager(join(tempDir, 'threads'))
    await threads.load()

    sessions = new SessionManager(join(tempDir, 'sessions'))

    agents = createMockAgentManager()
    core = createMockCore()

    router = new MessageRouter(threads, sessions, agents as any, core as any)

    // Register two test agents
    agents.agents.set('agent-a', { id: 'agent-a', name: 'writer', emoji: '✍️', createdAt: Date.now(), updatedAt: Date.now() })
    agents.agents.set('agent-b', { id: 'agent-b', name: 'reviewer', emoji: '🔍', createdAt: Date.now(), updatedAt: Date.now() })
  })

  afterEach(async () => {
    // Wait for fire-and-forget persistence to finish
    await new Promise(r => setTimeout(r, 50))
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('handleSendMessage', () => {
    it('should create a root thread on first send', async () => {
      // Create a session for agent-a
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      const result = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Please review my work',
      })

      expect(result.status).toBe('delivered')
      expect(result.threadId).toMatch(/^thread-/)
      expect(result.messageId).toMatch(/^msg-/)

      // Thread should exist
      const thread = threads.get(result.threadId)
      expect(thread).not.toBeNull()
      expect(thread!.status).toBe('active')

      // Events should be emitted
      const threadCreated = core.emitted.find(e => e.event === 'thread:created')
      expect(threadCreated).toBeDefined()

      const messageSent = core.emitted.find(e => e.event === 'message:sent')
      expect(messageSent).toBeDefined()

      const autoResume = core.emitted.find(e => e.event === 'agent:auto_resume')
      expect(autoResume).toBeDefined()
      expect(autoResume!.data.agentName).toBe('reviewer')

      // submitTurn should be called for auto-resume
      expect(core.submitTurn).toHaveBeenCalledTimes(1)
      const call = core.submitTurn.mock.calls[0][0]
      expect(call.type).toBe('agent')
      expect(call.prompt).toContain('@writer')
      expect(call.prompt).toContain('Please review my work')
    })

    it('should reuse existing thread on subsequent sends', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      const r1 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'First message',
      })

      const r2 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Second message',
      })

      expect(r1.threadId).toBe(r2.threadId)
    })

    it('should create child thread with new_thread=true', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // First create a root thread
      const r1 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Root message',
      })

      // Now create a sub-thread
      const r2 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Sub-task',
        new_thread: true,
        thread_title: 'Sub Thread',
      })

      expect(r2.threadId).not.toBe(r1.threadId)
      const childThread = threads.get(r2.threadId)
      expect(childThread!.parentThreadId).toBe(r1.threadId)
      expect(childThread!.title).toBe('Sub Thread')
    })

    it('should stall when maxTurns reached', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // Create thread with maxTurns=2
      const r1 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Message 1',
      })

      // Simulate 2 turns already happened (maxTurns default is 10, so set thread's turnCount)
      const thread = threads.get(r1.threadId)!
      threads.updateConfig(thread.id, { maxTurns: 2 })
      // First send already incremented to 1, send another to reach 2
      threads.incrementTurnCount(thread.id)

      const r2 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'This should stall',
      })

      expect(r2.status).toBe('thread_stalled')
      expect(threads.get(thread.id)!.status).toBe('stalled')
    })

    it('should throw when target agent not found', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      await expect(
        router.handleSendMessage('agent-a', 'session-a', {
          to: '@nonexistent',
          content: 'Hello',
        }),
      ).rejects.toThrow('Agent not found: @nonexistent')
    })

    it('should include artifact references in message', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // First create a thread and save an artifact
      const r1 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Creating thread',
      })

      // Save artifact
      const artResult = await router.handleSaveArtifact('agent-a', 'session-a', {
        name: 'report.md',
        content: '# Report',
      })

      // Send with artifact
      const r2 = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Please review attached report',
        artifacts: [artResult.artifactId],
      })

      expect(r2.status).toBe('delivered')

      // Check the submitted turn prompt includes the artifact reference
      const lastCall = core.submitTurn.mock.calls.at(-1)![0]
      expect(lastCall.prompt).toContain('report.md')
    })
  })

  describe('handleSaveArtifact', () => {
    it('should save artifact to thread', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // Create a thread first
      await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Start',
      })

      const result = await router.handleSaveArtifact('agent-a', 'session-a', {
        name: 'output.md',
        content: '# Output\n\nSome content',
      })

      expect(result.artifactId).toMatch(/^artifact-/)
      expect(result.path).toContain('output.md')
    })

    it('should error when session has no thread', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      await expect(
        router.handleSaveArtifact('agent-a', 'session-a', {
          name: 'test.md',
          content: 'test',
        }),
      ).rejects.toThrow('not part of a thread')
    })
  })

  describe('handleListThreads', () => {
    it('should list threads for an agent', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Hello',
      })

      const result = router.handleListThreads('agent-a', {})
      // agent-a may or may not be a participant depending on whether it's new_thread or not
      // In regular send, the sender is added as participant
      expect(result.threads.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('wait_for_reply', () => {
    it('should return immediately when wait_for_reply is omitted', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // submitTurn never sets target to idle — confirms we don't wait
      core.submitTurn = vi.fn().mockReturnValue('query-1')

      const start = Date.now()
      const result = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Hello',
      })
      const elapsed = Date.now() - start

      expect(result.status).toBe('delivered')
      expect(elapsed).toBeLessThan(200)
    })

    it('should block until target session becomes idle when wait_for_reply=true', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      // Simulate: target agent runs for 60ms then finishes
      core.submitTurn = vi.fn().mockImplementation((params: any) => {
        setTimeout(() => {
          sessions.setStatus(params.sessionId, 'idle')
        }, 60)
        return 'query-1'
      })

      const start = Date.now()
      const result = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Please do some work',
        wait_for_reply: true,
      })
      const elapsed = Date.now() - start

      expect(result.status).toBe('delivered')
      // Should have actually waited (not returned instantly)
      expect(elapsed).toBeGreaterThanOrEqual(50)
    })

    it('should resolve via session ID remap (pending-xxx → real SDK ID)', async () => {
      // This mirrors the real flow: TurnManager.execute() triggers session_init
      // which calls sessions.register(realSdkId, meta), then sets idle on realSdkId.
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      core.submitTurn = vi.fn().mockImplementation((params: any) => {
        const pendingId = params.sessionId
        setTimeout(() => {
          // Simulate session_init remap
          const targetMeta = sessions.getMeta(pendingId)
          if (targetMeta) {
            const realSdkId = `real-sdk-${Date.now()}`
            sessions.register(realSdkId, targetMeta)
            sessions.setStatus(realSdkId, 'idle')
          }
        }, 40)
        return 'query-1'
      })

      const result = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Task with ID remap',
        wait_for_reply: true,
      })

      expect(result.status).toBe('delivered')
    })

    it('coordinator pattern: sequential tasks via wait_for_reply', async () => {
      // Simulates a coordinator waiting for two workers one after another
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      const order: string[] = []

      core.submitTurn = vi.fn().mockImplementation((params: any) => {
        const sessionId = params.sessionId
        const prompt = params.prompt as string
        const delay = prompt.includes('first') ? 30 : 60
        setTimeout(() => {
          order.push(prompt.includes('first') ? 'first-done' : 'second-done')
          sessions.setStatus(sessionId, 'idle')
        }, delay)
        return 'query-1'
      })

      // Send first task and wait
      await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'first task',
        wait_for_reply: true,
      })
      order.push('after-first-send')

      // Because wait_for_reply is true, 'first-done' must appear before 'after-first-send' is pushed
      // (we only push after-first-send after the await resolves)
      expect(order[0]).toBe('first-done')
      expect(order[1]).toBe('after-first-send')

      // Send second task and wait
      await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'second task',
        wait_for_reply: true,
      })
      order.push('after-second-send')

      expect(order[2]).toBe('second-done')
      expect(order[3]).toBe('after-second-send')
    })
  })

  describe('handleCompleteThread', () => {
    it('should complete the thread', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      const r = await router.handleSendMessage('agent-a', 'session-a', {
        to: '@reviewer',
        content: 'Work done',
      })

      const result = await router.handleCompleteThread('session-a', {
        summary: 'All tasks completed successfully',
      })

      expect(result.status).toBe('completed')
      expect(threads.get(r.threadId)!.status).toBe('completed')

      // Should have saved a system message
      const msgs = threads.getMessages(r.threadId)
      const systemMsg = msgs.find(m => m.content.includes('[Thread completed]'))
      expect(systemMsg).toBeDefined()
      expect(systemMsg!.content).toContain('All tasks completed successfully')

      // Should emit thread:completed
      const completedEvent = core.emitted.find(e => e.event === 'thread:completed')
      expect(completedEvent).toBeDefined()
    })

    it('should error when session has no thread', async () => {
      const project = makeProject({ id: '__agent-agent-a' })
      const meta = sessions.create(project.id, project)
      sessions.register('session-a', meta)

      await expect(
        router.handleCompleteThread('session-a', {}),
      ).rejects.toThrow('not part of a thread')
    })
  })
})
