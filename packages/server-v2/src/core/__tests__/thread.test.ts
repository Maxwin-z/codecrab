import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ThreadManager } from '../thread.js'

describe('ThreadManager', () => {
  let manager: ThreadManager
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'thread-test-'))
    manager = new ThreadManager(tempDir)
    await manager.load()
  })

  afterEach(async () => {
    // Wait for fire-and-forget persists to complete
    await new Promise(r => setTimeout(r, 50))
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('create', () => {
    it('should create a thread with default config', () => {
      const thread = manager.create('Test Thread')
      expect(thread.id).toMatch(/^thread-/)
      expect(thread.title).toBe('Test Thread')
      expect(thread.status).toBe('active')
      expect(thread.parentThreadId).toBeNull()
      expect(thread.participants).toEqual([])
      expect(thread.config.maxTurns).toBe(10)
      expect(thread.turnCount).toBe(0)
    })

    it('should create a child thread with parent reference', () => {
      const parent = manager.create('Parent')
      const child = manager.create('Child', parent.id)
      expect(child.parentThreadId).toBe(parent.id)
    })

    it('should allow custom maxTurns', () => {
      const thread = manager.create('Custom', undefined, { maxTurns: 5 })
      expect(thread.config.maxTurns).toBe(5)
    })
  })

  describe('get and list', () => {
    it('should retrieve a thread by ID', () => {
      const created = manager.create('Test')
      const retrieved = manager.get(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.title).toBe('Test')
    })

    it('should return null for unknown ID', () => {
      expect(manager.get('nonexistent')).toBeNull()
    })

    it('should list all threads', () => {
      manager.create('Thread A')
      manager.create('Thread B')
      const all = manager.list()
      expect(all).toHaveLength(2)
    })

    it('should filter by status', () => {
      const t1 = manager.create('Active')
      const t2 = manager.create('Done')
      manager.complete(t2.id)

      expect(manager.list({ status: 'active' })).toHaveLength(1)
      expect(manager.list({ status: 'completed' })).toHaveLength(1)
    })

    it('should filter by agentId', () => {
      const t = manager.create('Test')
      manager.addParticipant(t.id, 'agent-1', 'Bot', 'session-1')

      expect(manager.list({ agentId: 'agent-1' })).toHaveLength(1)
      expect(manager.list({ agentId: 'agent-2' })).toHaveLength(0)
    })
  })

  describe('participants', () => {
    it('should add a participant', () => {
      const t = manager.create('Test')
      manager.addParticipant(t.id, 'agent-1', 'Bot', 'session-1')

      const thread = manager.get(t.id)!
      expect(thread.participants).toHaveLength(1)
      expect(thread.participants[0].agentId).toBe('agent-1')
      expect(thread.participants[0].agentName).toBe('Bot')
      expect(thread.participants[0].sessionId).toBe('session-1')
    })

    it('should not add duplicate participant', () => {
      const t = manager.create('Test')
      manager.addParticipant(t.id, 'agent-1', 'Bot', 'session-1')
      manager.addParticipant(t.id, 'agent-1', 'Bot', 'session-2')

      expect(manager.get(t.id)!.participants).toHaveLength(1)
    })

    it('should find participant session', () => {
      const t = manager.create('Test')
      manager.addParticipant(t.id, 'agent-1', 'Bot', 'session-1')

      expect(manager.getParticipantSession(t.id, 'agent-1')).toBe('session-1')
      expect(manager.getParticipantSession(t.id, 'agent-2')).toBeNull()
    })
  })

  describe('status management', () => {
    it('should mark thread as completed', () => {
      const t = manager.create('Test')
      manager.complete(t.id)
      expect(manager.get(t.id)!.status).toBe('completed')
    })

    it('should mark thread as stalled', () => {
      const t = manager.create('Test')
      manager.stall(t.id, 'max turns reached')
      expect(manager.get(t.id)!.status).toBe('stalled')
    })

    it('should update config', () => {
      const t = manager.create('Test')
      const updated = manager.updateConfig(t.id, { maxTurns: 20 })
      expect(updated!.config.maxTurns).toBe(20)
    })
  })

  describe('messages', () => {
    it('should save and retrieve messages', async () => {
      const t = manager.create('Test')
      await manager.saveMessage({
        id: 'msg-1',
        threadId: t.id,
        from: { agentId: 'a1', agentName: 'Bot A' },
        to: { agentId: 'a2', agentName: 'Bot B' },
        content: 'Hello',
        artifacts: [],
        status: 'delivered',
        createdAt: Date.now(),
      })

      const msgs = manager.getMessages(t.id)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('Hello')
    })

    it('should limit messages', async () => {
      const t = manager.create('Test')
      for (let i = 0; i < 5; i++) {
        await manager.saveMessage({
          id: `msg-${i}`,
          threadId: t.id,
          from: { agentId: 'a1', agentName: 'Bot' },
          to: 'broadcast',
          content: `Message ${i}`,
          artifacts: [],
          status: 'delivered',
          createdAt: Date.now() + i,
        })
      }

      const msgs = manager.getMessages(t.id, 3)
      expect(msgs).toHaveLength(3)
      // Should return the last 3
      expect(msgs[0].content).toBe('Message 2')
    })

    it('should persist message to disk', async () => {
      const t = manager.create('Test')
      const msg = {
        id: 'msg-1',
        threadId: t.id,
        from: { agentId: 'a1', agentName: 'Bot' },
        to: 'broadcast' as const,
        content: 'Test message',
        artifacts: [],
        status: 'delivered' as const,
        createdAt: Date.now(),
      }
      await manager.saveMessage(msg)

      const messagesDir = join(tempDir, t.id, 'messages')
      const files = await readdir(messagesDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/\.json$/)

      const content = JSON.parse(await readFile(join(messagesDir, files[0]), 'utf-8'))
      expect(content.content).toBe('Test message')
    })
  })

  describe('turn count', () => {
    it('should track turn count', () => {
      const t = manager.create('Test')
      expect(manager.getTurnCount(t.id)).toBe(0)

      manager.incrementTurnCount(t.id)
      expect(manager.getTurnCount(t.id)).toBe(1)

      manager.incrementTurnCount(t.id)
      expect(manager.getTurnCount(t.id)).toBe(2)
    })
  })

  describe('artifacts', () => {
    it('should save and list artifacts', async () => {
      const t = manager.create('Test')
      const art = await manager.saveArtifact(
        t.id,
        'report.md',
        '# Report\n\nContent here.',
        { agentId: 'a1', agentName: 'Bot' },
      )

      expect(art.id).toMatch(/^artifact-/)
      expect(art.name).toBe('report.md')
      expect(art.mimeType).toBe('text/markdown')
      expect(art.size).toBeGreaterThan(0)

      const listed = manager.listArtifacts(t.id)
      expect(listed).toHaveLength(1)
      expect(listed[0].name).toBe('report.md')

      // Verify file exists on disk
      const content = await readFile(art.path, 'utf-8')
      expect(content).toBe('# Report\n\nContent here.')
    })

    it('should replace artifact with same name', async () => {
      const t = manager.create('Test')
      await manager.saveArtifact(t.id, 'report.md', 'v1', { agentId: 'a1', agentName: 'Bot' })
      await manager.saveArtifact(t.id, 'report.md', 'v2', { agentId: 'a1', agentName: 'Bot' })

      const listed = manager.listArtifacts(t.id)
      expect(listed).toHaveLength(1)

      const content = await readFile(listed[0].path, 'utf-8')
      expect(content).toBe('v2')
    })

    it('should find artifact by ID', async () => {
      const t = manager.create('Test')
      const art = await manager.saveArtifact(
        t.id,
        'data.json',
        '{}',
        { agentId: 'a1', agentName: 'Bot' },
      )

      const found = manager.getArtifactById(art.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('data.json')

      expect(manager.getArtifactById('nonexistent')).toBeNull()
    })
  })

  describe('child threads', () => {
    it('should find child threads', () => {
      const parent = manager.create('Parent')
      manager.create('Child 1', parent.id)
      manager.create('Child 2', parent.id)
      manager.create('Other')

      const children = manager.getChildThreads(parent.id)
      expect(children).toHaveLength(2)
    })
  })

  describe('persistence', () => {
    it('should persist and reload threads', async () => {
      const t = manager.create('Persistent')
      manager.addParticipant(t.id, 'a1', 'Bot', 's1')
      await manager.saveMessage({
        id: 'msg-1',
        threadId: t.id,
        from: { agentId: 'a1', agentName: 'Bot' },
        to: 'broadcast',
        content: 'Hello',
        artifacts: [],
        status: 'delivered',
        createdAt: Date.now(),
      })

      // Wait for async persist
      await new Promise(r => setTimeout(r, 100))

      // Reload in a new manager
      const manager2 = new ThreadManager(tempDir)
      await manager2.load()

      const loaded = manager2.get(t.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.title).toBe('Persistent')
      expect(loaded!.participants).toHaveLength(1)

      const msgs = manager2.getMessages(t.id)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('Hello')
    })
  })
})
