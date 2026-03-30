/**
 * Integration test: Inter-Agent Communication Flow
 *
 * Simulates the full multi-agent collaboration scenario from the design doc:
 *   1. Agent A sends message to Agent B → thread created, B auto-resumed
 *   2. Agent B processes and replies → A auto-resumed
 *   3. Fan-out: A sends to B and C via sub-threads → both auto-resumed
 *   4. Thread completion and stall scenarios
 *
 * Tests the complete data flow through:
 *   ThreadManager → MessageRouter → submitTurn (auto-resume) → events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { ThreadManager } from '../thread.js'
import { SessionManager } from '../session.js'
import { MessageRouter } from '../message-router.js'
import type { ProjectConfig, PermissionMode } from '../../types/index.js'

// ── Helpers ─────────────────────────────────────────────────────────────

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

function createMockAgentManager() {
  const agents = new Map<string, { id: string; name: string; emoji: string; createdAt: number; updatedAt: number }>()
  return {
    agents,
    get: (id: string) => agents.get(id) ?? null,
    findByName: (name: string) => {
      for (const a of agents.values()) if (a.name === name) return a
      return null
    },
    getProjectId: (agentId: string) => `__agent-${agentId}`,
    ensureAgentProject: async (agentId: string): Promise<ProjectConfig> =>
      makeProject({ id: `__agent-${agentId}`, name: agents.get(agentId)?.name || agentId }),
  }
}

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

// ── Tests ───────────────────────────────────────────────────────────────

describe('Inter-Agent Communication Flow', () => {
  let threads: ThreadManager
  let sessions: SessionManager
  let agents: ReturnType<typeof createMockAgentManager>
  let core: ReturnType<typeof createMockCore>
  let router: MessageRouter
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'inter-agent-test-'))
    threads = new ThreadManager(join(tempDir, 'threads'))
    await threads.load()
    sessions = new SessionManager(join(tempDir, 'sessions'))
    agents = createMockAgentManager()
    core = createMockCore()
    router = new MessageRouter(threads, sessions, agents as any, core as any)
  })

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 50))
    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Bidirectional mailbox communication ────────────────────────────

  describe('Bidirectional Mailbox', () => {
    beforeEach(() => {
      agents.agents.set('aigc', { id: 'aigc', name: 'AIGC抓取', emoji: '📰', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('boss', { id: 'boss', name: '张总', emoji: '👔', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should complete full A→B→A communication cycle', async () => {
      // Step 1: Create session for AIGC agent (simulates user-initiated turn)
      const projectA = makeProject({ id: '__agent-aigc' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-aigc-1', metaA)

      // Step 2: AIGC sends message to 张总
      const r1 = await router.handleSendMessage('aigc', 'session-aigc-1', {
        to: '@张总',
        content: '以下是今天的10条AIGC热门资讯，请选择Top 3',
      })

      expect(r1.status).toBe('delivered')
      expect(r1.threadId).toMatch(/^thread-/)

      // Verify: thread created with AIGC as participant
      const thread = threads.get(r1.threadId)!
      expect(thread.status).toBe('active')
      expect(thread.participants.find(p => p.agentId === 'aigc')).toBeDefined()

      // Verify: 张总's session was created via lazy creation
      const bossParticipant = thread.participants.find(p => p.agentId === 'boss')
      expect(bossParticipant).toBeDefined()
      expect(bossParticipant!.sessionId).toMatch(/^pending-thread-/)

      // Verify: submitTurn called to auto-resume 张总
      expect(core.submitTurn).toHaveBeenCalledTimes(1)
      const resumeCall = core.submitTurn.mock.calls[0][0]
      expect(resumeCall.type).toBe('agent')
      expect(resumeCall.projectId).toBe('__agent-boss')
      expect(resumeCall.prompt).toContain('@AIGC抓取')
      expect(resumeCall.prompt).toContain('10条AIGC热门资讯')

      // Verify: events emitted
      expect(core.emitted.find(e => e.event === 'thread:created')).toBeDefined()
      expect(core.emitted.find(e => e.event === 'message:sent')).toBeDefined()
      expect(core.emitted.find(e => e.event === 'message:delivered')).toBeDefined()
      const autoResumeEvent = core.emitted.find(e => e.event === 'agent:auto_resume')
      expect(autoResumeEvent).toBeDefined()
      expect(autoResumeEvent!.data.agentName).toBe('张总')
      expect(autoResumeEvent!.data.triggeredBy.agentName).toBe('AIGC抓取')

      // Step 3: 张总 replies (simulates 张总's auto-resumed session)
      // 张总's session was created by the router — use the session ID from the participant
      const bossSessionId = bossParticipant!.sessionId

      core.emitted.length = 0 // reset events
      core.submitTurn.mockClear()

      const r2 = await router.handleSendMessage('boss', bossSessionId, {
        to: '@AIGC抓取',
        content: '选择: 1. Anthropic法律纠纷 2. DeerFlow 2.0 3. GPT-5传闻',
      })

      expect(r2.status).toBe('delivered')
      expect(r2.threadId).toBe(r1.threadId) // Same thread!

      // Verify: submitTurn called to auto-resume AIGC
      expect(core.submitTurn).toHaveBeenCalledTimes(1)
      const resumeCallA = core.submitTurn.mock.calls[0][0]
      expect(resumeCallA.type).toBe('agent')
      expect(resumeCallA.projectId).toBe('__agent-aigc')
      expect(resumeCallA.prompt).toContain('@张总')
      expect(resumeCallA.prompt).toContain('选择')

      // Verify: AIGC auto_resume event
      const autoResumeA = core.emitted.find(e => e.event === 'agent:auto_resume')
      expect(autoResumeA!.data.agentName).toBe('AIGC抓取')
      expect(autoResumeA!.data.triggeredBy.agentName).toBe('张总')

      // Step 4: Verify full message history
      const messages = threads.getMessages(r1.threadId)
      expect(messages).toHaveLength(2)
      expect(messages[0].from.agentName).toBe('AIGC抓取')
      expect(messages[1].from.agentName).toBe('张总')
    })

    it('should include thread context in auto-resume prompt', async () => {
      const projectA = makeProject({ id: '__agent-aigc' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-aigc-1', metaA)

      await router.handleSendMessage('aigc', 'session-aigc-1', {
        to: '@张总',
        content: 'Hello boss',
      })

      // Check systemPromptAppend in submitTurn call
      const call = core.submitTurn.mock.calls[0][0]
      expect(call.metadata.systemPromptAppend).toContain('Collaboration Thread')
      expect(call.metadata.systemPromptAppend).toContain('Participants')
      expect(call.metadata.threadId).toMatch(/^thread-/)
    })

    it('should track auto-resume count on session', async () => {
      const projectA = makeProject({ id: '__agent-aigc' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-aigc-1', metaA)

      const r1 = await router.handleSendMessage('aigc', 'session-aigc-1', {
        to: '@张总',
        content: 'First message',
      })

      const thread = threads.get(r1.threadId)!
      const bossSessionId = thread.participants.find(p => p.agentId === 'boss')!.sessionId

      // Check boss's auto-resume count
      const bossMeta = sessions.getMeta(bossSessionId)
      expect(bossMeta?.autoResumeCount).toBe(1)

      // Send another message — auto-resume count should increment
      await router.handleSendMessage('aigc', 'session-aigc-1', {
        to: '@张总',
        content: 'Second message',
      })

      const bossMetaAfter = sessions.getMeta(bossSessionId)
      expect(bossMetaAfter?.autoResumeCount).toBe(2)
    })
  })

  // ── Fan-out (sub-threads) ─────────────────────────────────────────

  describe('Fan-out with Sub-Threads', () => {
    beforeEach(() => {
      agents.agents.set('master', { id: 'master', name: 'Master', emoji: '👑', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('worker-a', { id: 'worker-a', name: 'WorkerA', emoji: '🔧', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('worker-b', { id: 'worker-b', name: 'WorkerB', emoji: '🔩', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should create independent sub-threads for parallel tasks', async () => {
      const projectM = makeProject({ id: '__agent-master' })
      const metaM = sessions.create(projectM.id, projectM)
      sessions.register('session-m1', metaM)

      // Master creates root thread context
      const r0 = await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerA',
        content: 'Root context',
      })
      const rootThreadId = r0.threadId

      // Master fans out to WorkerA with sub-thread
      const r1 = await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerA',
        content: 'Task 1: Research Sora',
        new_thread: true,
        thread_title: 'Sora Research',
      })

      // Master fans out to WorkerB with another sub-thread
      const r2 = await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerB',
        content: 'Task 2: Research GPT-5',
        new_thread: true,
        thread_title: 'GPT-5 Research',
      })

      // Verify: two separate sub-threads created
      expect(r1.threadId).not.toBe(r2.threadId)
      expect(r1.threadId).not.toBe(rootThreadId)
      expect(r2.threadId).not.toBe(rootThreadId)

      // Verify: both sub-threads have correct parent
      const thread1 = threads.get(r1.threadId)!
      const thread2 = threads.get(r2.threadId)!
      expect(thread1.parentThreadId).toBe(rootThreadId)
      expect(thread2.parentThreadId).toBe(rootThreadId)
      expect(thread1.title).toBe('Sora Research')
      expect(thread2.title).toBe('GPT-5 Research')

      // Verify: separate sessions created for each worker
      expect(core.submitTurn).toHaveBeenCalledTimes(3) // root + 2 sub-threads
      const calls = core.submitTurn.mock.calls
      // Last two calls should be for WorkerA and WorkerB
      expect(calls[1][0].projectId).toBe('__agent-worker-a')
      expect(calls[2][0].projectId).toBe('__agent-worker-b')

      // Verify: Master is NOT a participant in sub-threads (lazy session)
      expect(thread1.participants.find(p => p.agentId === 'master')).toBeUndefined()
      expect(thread2.participants.find(p => p.agentId === 'master')).toBeUndefined()
    })

    it('should create lazy session for master when worker replies to sub-thread', async () => {
      const projectM = makeProject({ id: '__agent-master' })
      const metaM = sessions.create(projectM.id, projectM)
      sessions.register('session-m1', metaM)

      // Master sends to WorkerA via sub-thread
      const r1 = await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerA',
        content: 'Do task 1',
        new_thread: true,
        thread_title: 'Task 1',
      })

      const subThread = threads.get(r1.threadId)!
      // Master is NOT in sub-thread yet (lazy)
      expect(subThread.participants.find(p => p.agentId === 'master')).toBeUndefined()

      // WorkerA replies to Master in the sub-thread
      const workerSessionId = subThread.participants.find(p => p.agentId === 'worker-a')!.sessionId

      core.submitTurn.mockClear()
      core.emitted.length = 0

      const r2 = await router.handleSendMessage('worker-a', workerSessionId, {
        to: '@Master',
        content: 'Task 1 complete, here is my work',
      })

      // Now Master should have a lazy session created in the sub-thread
      const updatedSubThread = threads.get(r1.threadId)!
      const masterInSubThread = updatedSubThread.participants.find(p => p.agentId === 'master')
      expect(masterInSubThread).toBeDefined()
      expect(masterInSubThread!.sessionId).toMatch(/^pending-thread-/)

      // submitTurn should be called for Master's auto-resume in sub-thread
      expect(core.submitTurn).toHaveBeenCalledTimes(1)
      const call = core.submitTurn.mock.calls[0][0]
      expect(call.projectId).toBe('__agent-master')
      expect(call.prompt).toContain('@WorkerA')
      expect(call.prompt).toContain('Task 1 complete')
    })

    it('should get child threads', async () => {
      const projectM = makeProject({ id: '__agent-master' })
      const metaM = sessions.create(projectM.id, projectM)
      sessions.register('session-m1', metaM)

      // Create root
      const r0 = await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerA',
        content: 'Root',
      })

      // Create two sub-threads
      await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerA',
        content: 'Sub 1',
        new_thread: true,
        thread_title: 'Sub Thread 1',
      })

      await router.handleSendMessage('master', 'session-m1', {
        to: '@WorkerB',
        content: 'Sub 2',
        new_thread: true,
        thread_title: 'Sub Thread 2',
      })

      const children = threads.getChildThreads(r0.threadId)
      expect(children).toHaveLength(2)
    })
  })

  // ── Artifact sharing ──────────────────────────────────────────────

  describe('Artifact Sharing', () => {
    beforeEach(() => {
      agents.agents.set('writer', { id: 'writer', name: 'Writer', emoji: '✍️', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('reviewer', { id: 'reviewer', name: 'Reviewer', emoji: '🔍', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should share artifacts across agents via thread', async () => {
      const projectW = makeProject({ id: '__agent-writer' })
      const metaW = sessions.create(projectW.id, projectW)
      sessions.register('session-w1', metaW)

      // Writer creates thread + sends initial message
      const r1 = await router.handleSendMessage('writer', 'session-w1', {
        to: '@Reviewer',
        content: 'Starting work',
      })

      // Writer saves an artifact
      const art = await router.handleSaveArtifact('writer', 'session-w1', {
        name: 'draft-v1.md',
        content: '# Draft\n\nThis is the first draft.',
      })

      expect(art.artifactId).toMatch(/^artifact-/)
      expect(art.path).toContain('draft-v1.md')

      // Writer sends with artifact reference
      core.submitTurn.mockClear()

      const r2 = await router.handleSendMessage('writer', 'session-w1', {
        to: '@Reviewer',
        content: 'Please review this draft',
        artifacts: [art.artifactId],
      })

      expect(r2.status).toBe('delivered')

      // Verify: resume prompt includes artifact path
      const resumeCall = core.submitTurn.mock.calls[0][0]
      expect(resumeCall.prompt).toContain('draft-v1.md')
      expect(resumeCall.prompt).toContain('Attachments')

      // Verify: artifacts listed in thread
      const artifacts = threads.listArtifacts(r1.threadId)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].name).toBe('draft-v1.md')
    })
  })

  // ── Thread lifecycle ──────────────────────────────────────────────

  describe('Thread Lifecycle', () => {
    beforeEach(() => {
      agents.agents.set('agent-a', { id: 'agent-a', name: 'AgentA', emoji: '🅰️', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('agent-b', { id: 'agent-b', name: 'AgentB', emoji: '🅱️', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should complete thread via complete_thread', async () => {
      const projectA = makeProject({ id: '__agent-agent-a' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-a1', metaA)

      const r = await router.handleSendMessage('agent-a', 'session-a1', {
        to: '@AgentB',
        content: 'Start collaboration',
      })

      const result = await router.handleCompleteThread('session-a1', {
        summary: 'Work completed successfully',
      })

      expect(result.status).toBe('completed')
      expect(threads.get(r.threadId)!.status).toBe('completed')

      // Check summary saved as system message
      const msgs = threads.getMessages(r.threadId)
      const systemMsg = msgs.find(m => m.from.agentId === '__system')
      expect(systemMsg).toBeDefined()
      expect(systemMsg!.content).toContain('Work completed successfully')

      // Check thread:completed event
      expect(core.emitted.find(e => e.event === 'thread:completed')).toBeDefined()
    })

    it('should stall thread after maxTurns exceeded', async () => {
      const projectA = makeProject({ id: '__agent-agent-a' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-a1', metaA)

      // Create thread with low maxTurns
      const r1 = await router.handleSendMessage('agent-a', 'session-a1', {
        to: '@AgentB',
        content: 'Start',
      })

      // Set maxTurns to 2 and simulate reaching the limit
      threads.updateConfig(r1.threadId, { maxTurns: 2 })
      threads.incrementTurnCount(r1.threadId) // Now at 2 (1 from send + 1 manual)

      const r2 = await router.handleSendMessage('agent-a', 'session-a1', {
        to: '@AgentB',
        content: 'This should trigger stall',
      })

      expect(r2.status).toBe('thread_stalled')
      expect(threads.get(r1.threadId)!.status).toBe('stalled')

      // Check stall event
      const stallEvent = core.emitted.find(e => e.event === 'thread:stalled')
      expect(stallEvent).toBeDefined()
      expect(stallEvent!.data.reason).toContain('limit')
    })

    it('should increment thread turn count per delivery', async () => {
      const projectA = makeProject({ id: '__agent-agent-a' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-a1', metaA)

      const r1 = await router.handleSendMessage('agent-a', 'session-a1', {
        to: '@AgentB',
        content: 'Message 1',
      })

      expect(threads.getTurnCount(r1.threadId)).toBe(1)

      // Reply from B
      const thread = threads.get(r1.threadId)!
      const bSessionId = thread.participants.find(p => p.agentId === 'agent-b')!.sessionId

      await router.handleSendMessage('agent-b', bSessionId, {
        to: '@AgentA',
        content: 'Reply 1',
      })

      expect(threads.getTurnCount(r1.threadId)).toBe(2)
    })
  })

  // ── Broadcast ─────────────────────────────────────────────────────

  describe('Broadcast Messages', () => {
    beforeEach(() => {
      agents.agents.set('coordinator', { id: 'coordinator', name: 'Coordinator', emoji: '📋', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('worker-1', { id: 'worker-1', name: 'Worker1', emoji: '🔧', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('worker-2', { id: 'worker-2', name: 'Worker2', emoji: '🔩', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should deliver broadcast to all thread participants except sender', async () => {
      const projectC = makeProject({ id: '__agent-coordinator' })
      const metaC = sessions.create(projectC.id, projectC)
      sessions.register('session-c1', metaC)

      // First add participants by sending individual messages
      await router.handleSendMessage('coordinator', 'session-c1', {
        to: '@Worker1',
        content: 'Join the thread',
      })

      // Worker1's session is now in the thread
      // Manually add Worker2 to the thread
      const threadId = sessions.getMeta('session-c1')!.threadId!
      const projectW2 = makeProject({ id: '__agent-worker-2' })
      const metaW2 = sessions.create(projectW2.id, projectW2)
      sessions.register('session-w2', metaW2)
      sessions.update('session-w2', { threadId })
      threads.addParticipant(threadId, 'worker-2', 'Worker2', 'session-w2')

      core.submitTurn.mockClear()
      core.emitted.length = 0

      // Coordinator broadcasts
      const r = await router.handleSendMessage('coordinator', 'session-c1', {
        to: 'broadcast',
        content: 'Attention everyone: deadline moved to Friday',
      })

      expect(r.status).toBe('delivered')

      // submitTurn should be called twice — once for Worker1, once for Worker2
      expect(core.submitTurn).toHaveBeenCalledTimes(2)

      const projectIds = core.submitTurn.mock.calls.map(c => c[0].projectId)
      expect(projectIds).toContain('__agent-worker-1')
      expect(projectIds).toContain('__agent-worker-2')
    })
  })

  // ── Event emission completeness ───────────────────────────────────

  describe('Event Emission', () => {
    beforeEach(() => {
      agents.agents.set('sender', { id: 'sender', name: 'Sender', emoji: '📤', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('receiver', { id: 'receiver', name: 'Receiver', emoji: '📥', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should emit all required events for a complete flow', async () => {
      const projectS = makeProject({ id: '__agent-sender' })
      const metaS = sessions.create(projectS.id, projectS)
      sessions.register('session-s1', metaS)

      await router.handleSendMessage('sender', 'session-s1', {
        to: '@Receiver',
        content: 'Test events',
      })

      const eventTypes = core.emitted.map(e => e.event)

      // All required events should be emitted
      expect(eventTypes).toContain('thread:created')
      expect(eventTypes).toContain('message:sent')
      expect(eventTypes).toContain('message:delivered')
      expect(eventTypes).toContain('agent:auto_resume')
      expect(eventTypes).toContain('session:created')

      // Verify event data shapes
      const threadCreated = core.emitted.find(e => e.event === 'thread:created')!
      expect(threadCreated.data.thread.id).toMatch(/^thread-/)
      expect(threadCreated.data.thread.status).toBe('active')

      const messageSent = core.emitted.find(e => e.event === 'message:sent')!
      expect(messageSent.data.message.from.agentName).toBe('Sender')
      expect(messageSent.data.threadId).toBe(threadCreated.data.thread.id)

      const autoResume = core.emitted.find(e => e.event === 'agent:auto_resume')!
      expect(autoResume.data.agentId).toBe('receiver')
      expect(autoResume.data.agentName).toBe('Receiver')
      expect(autoResume.data.threadId).toBe(threadCreated.data.thread.id)
      expect(autoResume.data.triggeredBy.agentName).toBe('Sender')
    })
  })

  // ── Resume prompt construction ────────────────────────────────────

  describe('Resume Prompt Construction', () => {
    beforeEach(() => {
      agents.agents.set('alice', { id: 'alice', name: 'Alice', emoji: '👩', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('bob', { id: 'bob', name: 'Bob', emoji: '👨', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should construct proper resume prompt with message content', async () => {
      const projectA = makeProject({ id: '__agent-alice' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-alice', metaA)

      await router.handleSendMessage('alice', 'session-alice', {
        to: '@Bob',
        content: 'Hello Bob, please help me with this task',
      })

      const call = core.submitTurn.mock.calls[0][0]
      expect(call.prompt).toContain('[Message from @Alice]')
      expect(call.prompt).toContain('Thread:')
      expect(call.prompt).toContain('Hello Bob, please help me with this task')
    })

    it('should include artifacts in resume prompt', async () => {
      const projectA = makeProject({ id: '__agent-alice' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-alice', metaA)

      // Create thread
      await router.handleSendMessage('alice', 'session-alice', {
        to: '@Bob',
        content: 'Initial message',
      })

      // Save artifact
      const art = await router.handleSaveArtifact('alice', 'session-alice', {
        name: 'analysis.md',
        content: '# Analysis results',
      })

      core.submitTurn.mockClear()

      // Send with artifact
      await router.handleSendMessage('alice', 'session-alice', {
        to: '@Bob',
        content: 'Check the analysis',
        artifacts: [art.artifactId],
      })

      const call = core.submitTurn.mock.calls[0][0]
      expect(call.prompt).toContain('Attachments:')
      expect(call.prompt).toContain('analysis.md')
    })

    it('should include message history in thread context for new participants', async () => {
      const projectA = makeProject({ id: '__agent-alice' })
      const metaA = sessions.create(projectA.id, projectA)
      sessions.register('session-alice', metaA)

      await router.handleSendMessage('alice', 'session-alice', {
        to: '@Bob',
        content: 'First message to Bob',
      })

      const call = core.submitTurn.mock.calls[0][0]
      // systemPromptAppend should contain thread context
      expect(call.metadata.systemPromptAppend).toContain('Current Collaboration Thread')
      expect(call.metadata.systemPromptAppend).toContain('@Alice')
    })
  })

  // ── Session binding ───────────────────────────────────────────────

  describe('Session-Thread Binding', () => {
    beforeEach(() => {
      agents.agents.set('agent-x', { id: 'agent-x', name: 'AgentX', emoji: '❌', createdAt: Date.now(), updatedAt: Date.now() })
      agents.agents.set('agent-y', { id: 'agent-y', name: 'AgentY', emoji: '✅', createdAt: Date.now(), updatedAt: Date.now() })
    })

    it('should bind sender session to thread on first send', async () => {
      const projectX = makeProject({ id: '__agent-agent-x' })
      const metaX = sessions.create(projectX.id, projectX)
      sessions.register('session-x1', metaX)

      // Session has no threadId initially
      expect(sessions.getMeta('session-x1')!.threadId).toBeUndefined()

      await router.handleSendMessage('agent-x', 'session-x1', {
        to: '@AgentY',
        content: 'Hello',
      })

      // Session should now be bound to the thread
      expect(sessions.getMeta('session-x1')!.threadId).toMatch(/^thread-/)
    })

    it('should bind target session to thread on lazy creation', async () => {
      const projectX = makeProject({ id: '__agent-agent-x' })
      const metaX = sessions.create(projectX.id, projectX)
      sessions.register('session-x1', metaX)

      const r = await router.handleSendMessage('agent-x', 'session-x1', {
        to: '@AgentY',
        content: 'Hello',
      })

      const thread = threads.get(r.threadId)!
      const yParticipant = thread.participants.find(p => p.agentId === 'agent-y')!
      const yMeta = sessions.getMeta(yParticipant.sessionId)

      expect(yMeta).not.toBeNull()
      expect(yMeta!.threadId).toBe(r.threadId)
      expect(yMeta!.permissionMode).toBe('bypassPermissions')
    })
  })
})
