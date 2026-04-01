import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '../session.js'
import type { ProjectConfig, PermissionMode } from '../../types/index.js'

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

describe('SessionManager', () => {
  let manager: SessionManager
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-test-'))
    manager = new SessionManager(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('create', () => {
    it('should create a session meta with the project default provider', () => {
      const project = makeProject({ defaultProviderId: 'claude-opus-4' })
      const meta = manager.create('proj-1', project)

      expect(meta.sdkSessionId).toBe('')
      expect(meta.projectId).toBe('proj-1')
      expect(meta.status).toBe('idle')
      expect(meta.providerId).toBe('claude-opus-4')
      expect(meta.permissionMode).toBe('default')
      expect(meta.usage.queryCount).toBe(0)
    })

    it('should lock the provider at creation time via overrides', () => {
      const project = makeProject()
      const meta = manager.create('proj-1', project, { providerId: 'claude-opus-4' })
      expect(meta.providerId).toBe('claude-opus-4')
    })

    it('should accept cron job overrides', () => {
      const project = makeProject()
      const meta = manager.create('proj-1', project, {
        cronJobId: 'cron-1',
        cronJobName: 'Daily Report',
      })
      expect(meta.cronJobId).toBe('cron-1')
      expect(meta.cronJobName).toBe('Daily Report')
    })

    it('should accept permission mode override', () => {
      const project = makeProject()
      const meta = manager.create('proj-1', project, { permissionMode: 'bypassPermissions' })
      expect(meta.permissionMode).toBe('bypassPermissions')
    })
  })

  describe('register', () => {
    it('should associate sdkSessionId and make retrievable', () => {
      const project = makeProject()
      const meta = manager.create('proj-1', project)
      manager.register('sdk-abc', meta)

      expect(meta.sdkSessionId).toBe('sdk-abc')
      expect(manager.getMeta('sdk-abc')).toBe(meta)
    })
  })

  describe('getMeta', () => {
    it('should return null for unknown session', () => {
      expect(manager.getMeta('non-existent')).toBeNull()
    })

    it('should return the registered meta', () => {
      const project = makeProject()
      const meta = manager.create('proj-1', project)
      manager.register('sdk-123', meta)
      expect(manager.getMeta('sdk-123')).toBe(meta)
    })
  })

  describe('list', () => {
    it('should return all sessions', () => {
      const project = makeProject()
      const m1 = manager.create('proj-1', project)
      const m2 = manager.create('proj-2', makeProject({ id: 'proj-2' }))
      manager.register('s1', m1)
      manager.register('s2', m2)

      expect(manager.list()).toHaveLength(2)
    })

    it('should filter by projectId', () => {
      const m1 = manager.create('proj-1', makeProject())
      const m2 = manager.create('proj-2', makeProject({ id: 'proj-2' }))
      manager.register('s1', m1)
      manager.register('s2', m2)

      const filtered = manager.list('proj-1')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projectId).toBe('proj-1')
    })

    it('should return empty array for unknown project', () => {
      expect(manager.list('unknown')).toHaveLength(0)
    })
  })

  describe('update', () => {
    it('should modify fields on the meta', () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.update('s1', { status: 'processing' })
      expect(meta.status).toBe('processing')
    })

    it('should do nothing for unknown session', () => {
      // Should not throw
      manager.update('unknown', { status: 'error' })
    })
  })

  describe('setStatus', () => {
    it('should set session status', () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)

      manager.setStatus('s1', 'processing')
      expect(meta.status).toBe('processing')

      manager.setStatus('s1', 'error')
      expect(meta.status).toBe('error')

      manager.setStatus('s1', 'idle')
      expect(meta.status).toBe('idle')
    })
  })

  describe('waitForIdle', () => {
    it('should resolve immediately when session does not exist', async () => {
      await expect(manager.waitForIdle('non-existent')).resolves.toBeUndefined()
    })

    it('should resolve immediately when session is already idle', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      // Default status is 'idle'
      await expect(manager.waitForIdle('s1')).resolves.toBeUndefined()
    })

    it('should resolve immediately when session is in error state', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'error')
      await expect(manager.waitForIdle('s1')).resolves.toBeUndefined()
    })

    it('should block while processing and resolve when idle', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'processing')

      let resolved = false
      const promise = manager.waitForIdle('s1').then(() => { resolved = true })

      // Flush microtasks — should still be pending
      await Promise.resolve()
      expect(resolved).toBe(false)

      manager.setStatus('s1', 'idle')
      await promise
      expect(resolved).toBe(true)
    })

    it('should fire all registered callbacks when idle', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'processing')

      const fired: number[] = []
      const p1 = manager.waitForIdle('s1').then(() => fired.push(1))
      const p2 = manager.waitForIdle('s1').then(() => fired.push(2))
      const p3 = manager.waitForIdle('s1').then(() => fired.push(3))

      manager.setStatus('s1', 'idle')
      await Promise.all([p1, p2, p3])

      expect(fired).toHaveLength(3)
      expect(fired).toContain(1)
      expect(fired).toContain(2)
      expect(fired).toContain(3)
    })

    it('should clear callbacks after firing so they do not re-fire', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'processing')

      let callCount = 0
      const p1 = manager.waitForIdle('s1').then(() => callCount++)

      manager.setStatus('s1', 'idle')
      await p1
      expect(callCount).toBe(1)

      // Cycle through processing → idle again
      manager.setStatus('s1', 'processing')
      manager.setStatus('s1', 'idle')
      await Promise.resolve()
      // Original callback must not fire again
      expect(callCount).toBe(1)
    })

    it('should support new waitForIdle registrations after callbacks are cleared', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'processing')

      // First wait
      manager.setStatus('s1', 'idle')
      await manager.waitForIdle('s1')

      // Second wait on the same session
      manager.setStatus('s1', 'processing')
      let resolved = false
      const p2 = manager.waitForIdle('s1').then(() => { resolved = true })

      await Promise.resolve()
      expect(resolved).toBe(false)

      manager.setStatus('s1', 'idle')
      await p2
      expect(resolved).toBe(true)
    })

    it('should resolve via remapped session ID (pending-xxx → real SDK ID)', async () => {
      // This simulates the session_init remap in TurnManager:
      // sessions.register(realSdkId, meta) is called mid-turn, then
      // setStatus(realSdkId, 'idle') is called in finally — not the pending ID.
      const meta = manager.create('proj-1', makeProject())
      manager.register('pending-thread-xxx', meta)
      manager.setStatus('pending-thread-xxx', 'processing')

      let resolved = false
      const promise = manager.waitForIdle('pending-thread-xxx').then(() => { resolved = true })

      await Promise.resolve()
      expect(resolved).toBe(false)

      // Simulate session_init: remap to real SDK ID (same meta object)
      manager.register('real-sdk-abc', meta)

      // TurnManager sets idle using the REAL SDK ID in its finally block
      manager.setStatus('real-sdk-abc', 'idle')
      await promise
      expect(resolved).toBe(true)
    })

    it('should not serialize callbacks into persisted JSON', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)
      manager.setStatus('s1', 'processing')

      // Register a callback (don't await — we just need it registered)
      const promise = manager.waitForIdle('s1')

      await manager.persist('s1')
      const fileContent = await readFile(join(tempDir, 's1.json'), 'utf-8')
      const parsed = JSON.parse(fileContent)

      expect(parsed.onIdleCallbacks).toBeUndefined()
      // Parsed JSON should only have the expected SessionMeta fields
      expect(Object.keys(parsed)).not.toContain('onIdleCallbacks')

      // Clean up pending promise
      manager.setStatus('s1', 'idle')
      await promise
    })
  })

  describe('setPendingQuestion / clearPendingQuestion', () => {
    it('should set and clear pending question', () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)

      const questions = [{ id: 'q1', text: 'What?', options: [] }]
      manager.setPendingQuestion('s1', 'tool-1', questions)
      expect(meta.pendingQuestion).toEqual({ toolId: 'tool-1', questions })

      manager.clearPendingQuestion('s1')
      expect(meta.pendingQuestion).toBeNull()
    })
  })

  describe('setPendingPermission / clearPendingPermission', () => {
    it('should set and clear pending permission', () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)

      const request = { requestId: 'req-1', toolName: 'Write', input: { path: '/foo' }, reason: 'needs write' }
      manager.setPendingPermission('s1', request)
      expect(meta.pendingPermissionRequest).toEqual(request)

      manager.clearPendingPermission('s1')
      expect(meta.pendingPermissionRequest).toBeNull()
    })
  })

  describe('addUsage', () => {
    it('should accumulate usage correctly', () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)

      manager.addUsage('s1', {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreateTokens: 5,
        costUsd: 0.01,
        durationMs: 1000,
        contextWindowUsed: 500,
        contextWindowMax: 200000,
      })

      expect(meta.usage.totalInputTokens).toBe(100)
      expect(meta.usage.totalOutputTokens).toBe(50)
      expect(meta.usage.totalCacheReadTokens).toBe(10)
      expect(meta.usage.totalCacheCreateTokens).toBe(5)
      expect(meta.usage.totalCostUsd).toBe(0.01)
      expect(meta.usage.totalDurationMs).toBe(1000)
      expect(meta.usage.queryCount).toBe(1)
      expect(meta.usage.contextWindowUsed).toBe(500)
      expect(meta.usage.contextWindowMax).toBe(200000)

      // Second usage adds up
      manager.addUsage('s1', {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheCreateTokens: 10,
        costUsd: 0.02,
        durationMs: 2000,
        contextWindowUsed: 1000,
        contextWindowMax: 200000,
      })

      expect(meta.usage.totalInputTokens).toBe(300)
      expect(meta.usage.totalOutputTokens).toBe(150)
      expect(meta.usage.queryCount).toBe(2)
      // contextWindowUsed should be overwritten, not summed
      expect(meta.usage.contextWindowUsed).toBe(1000)
    })

    it('should do nothing for unknown session', () => {
      // Should not throw
      manager.addUsage('unknown', {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0,
        durationMs: 0,
        contextWindowUsed: 0,
        contextWindowMax: 0,
      })
    })
  })

  describe('delete', () => {
    it('should remove from memory', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('s1', meta)

      expect(manager.getMeta('s1')).toBe(meta)
      await manager.delete('s1')
      expect(manager.getMeta('s1')).toBeNull()
    })

    it('should not throw for unknown session', async () => {
      await expect(manager.delete('non-existent')).resolves.toBeUndefined()
    })
  })

  describe('persist / load round-trip', () => {
    it('should persist to disk and reload', async () => {
      const meta = manager.create('proj-1', makeProject())
      manager.register('sdk-roundtrip', meta)
      manager.setStatus('sdk-roundtrip', 'processing')
      manager.addUsage('sdk-roundtrip', {
        inputTokens: 500,
        outputTokens: 250,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0.05,
        durationMs: 5000,
        contextWindowUsed: 1000,
        contextWindowMax: 200000,
      })

      await manager.persist('sdk-roundtrip')

      // Verify file exists
      const fileContent = await readFile(join(tempDir, 'sdk-roundtrip.json'), 'utf-8')
      const parsed = JSON.parse(fileContent)
      expect(parsed.sdkSessionId).toBe('sdk-roundtrip')
      expect(parsed.status).toBe('processing')

      // Create a new manager and load
      const manager2 = new SessionManager(tempDir)
      await manager2.load()

      const loaded = manager2.getMeta('sdk-roundtrip')
      expect(loaded).not.toBeNull()
      expect(loaded!.sdkSessionId).toBe('sdk-roundtrip')
      expect(loaded!.projectId).toBe('proj-1')
      expect(loaded!.status).toBe('processing')
      expect(loaded!.usage.totalInputTokens).toBe(500)
      expect(loaded!.usage.queryCount).toBe(1)
    })

    it('should handle empty directory on load', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'session-empty-'))
      const mgr = new SessionManager(emptyDir)
      await mgr.load()
      expect(mgr.list()).toHaveLength(0)
      await rm(emptyDir, { recursive: true, force: true })
    })

    it('should skip corrupted files on load', async () => {
      const { writeFile: wf } = await import('node:fs/promises')
      await wf(join(tempDir, 'bad.json'), 'not json')

      const meta = manager.create('proj-1', makeProject())
      manager.register('good-session', meta)
      await manager.persist('good-session')

      const mgr2 = new SessionManager(tempDir)
      await mgr2.load()
      expect(mgr2.list()).toHaveLength(1)
      expect(mgr2.getMeta('good-session')).not.toBeNull()
    })
  })

  describe('findActive', () => {
    it('should find processing session for project', () => {
      const m1 = manager.create('proj-1', makeProject())
      manager.register('s1', m1)
      manager.setStatus('s1', 'processing')

      const m2 = manager.create('proj-1', makeProject())
      manager.register('s2', m2)

      expect(manager.findActive('proj-1')!.sdkSessionId).toBe('s1')
    })

    it('should return null if no active session', () => {
      const m1 = manager.create('proj-1', makeProject())
      manager.register('s1', m1)

      expect(manager.findActive('proj-1')).toBeNull()
    })
  })

  describe('findLatest', () => {
    it('should find the most recently created session', () => {
      const p = makeProject()

      const m1 = manager.create('proj-1', p)
      m1.createdAt = 1000
      manager.register('s1', m1)

      const m2 = manager.create('proj-1', p)
      m2.createdAt = 3000
      manager.register('s2', m2)

      const m3 = manager.create('proj-1', p)
      m3.createdAt = 2000
      manager.register('s3', m3)

      expect(manager.findLatest('proj-1')!.sdkSessionId).toBe('s2')
    })

    it('should return null if no sessions for project', () => {
      expect(manager.findLatest('proj-1')).toBeNull()
    })
  })
})
