// Tests for cron job context injection — ensures projectId/parentSessionId
// are reliably stored in cron jobs even when updateToolInput is unavailable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { cronTools, initializeCronTools, setCurrentQueryContext } from '../tools.js'
import { CronScheduler } from '../scheduler.js'
import { CronExecutor } from '../executor.js'
import { loadJobs, setCronDir, resetCronDir } from '../store.js'
import type { CronJob, CronExecutionRequest, CronExecutionResult } from '../types.js'

// Helper to execute a tool by name
async function executeTool(name: string, input: Record<string, unknown>) {
  const t = cronTools.find((t: any) => t.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  const handler = (t as any).handler || (t as any).execute || (t as any).fn
  if (handler) return handler(input)
  throw new Error(`Cannot find handler for tool: ${name}`)
}

let tmpDir: string
let scheduler: CronScheduler

beforeEach(() => {
  // Use a temporary directory so tests never touch real user data
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-context-test-'))
  setCronDir(tmpDir)

  // Create scheduler with no-op executor
  scheduler = new CronScheduler(vi.fn().mockResolvedValue(undefined))
  initializeCronTools(scheduler)
})

afterEach(() => {
  scheduler.stop()
  setCurrentQueryContext({})
  resetCronDir()
  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('cron_create context injection via setCurrentQueryContext', () => {
  it('should use module-level query context when tool input has no context fields', async () => {
    // Simulate: claude.ts sets query context before SDK query
    setCurrentQueryContext({
      projectId: 'proj-abc',
      clientId: 'client-xyz',
      sessionId: 'sess-123',
    })

    // AI calls cron_create WITHOUT context fields (updateToolInput failed)
    const result = await executeTool('cron_create', {
      name: '10秒提醒',
      when: '10 seconds from now',
      prompt: 'Send a push notification: 时间到了！',
    })

    expect(result.isError).toBeFalsy()

    // Verify the persisted job has the context
    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === '10秒提醒')
    expect(job).toBeDefined()
    expect(job!.context.projectId).toBe('proj-abc')
    expect(job!.context.clientId).toBe('client-xyz')
    expect(job!.context.parentSessionId).toBe('sess-123')
    expect(job!.delivery?.target).toBe('sess-123')
  })

  it('should prefer tool input context over module-level context', async () => {
    // Module-level context set (older values)
    setCurrentQueryContext({
      projectId: 'proj-old',
      clientId: 'client-old',
      sessionId: 'sess-old',
    })

    // AI calls cron_create WITH context (updateToolInput worked)
    const result = await executeTool('cron_create', {
      name: 'Reminder with explicit context',
      when: '30 seconds from now',
      prompt: 'Check something',
      projectId: 'proj-new',
      clientId: 'client-new',
      sessionId: 'sess-new',
    })

    expect(result.isError).toBeFalsy()

    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === 'Reminder with explicit context')
    expect(job).toBeDefined()
    // Tool input should take priority
    expect(job!.context.projectId).toBe('proj-new')
    expect(job!.context.clientId).toBe('client-new')
    expect(job!.context.parentSessionId).toBe('sess-new')
  })

  it('should handle case where neither tool input nor module context has sessionId', async () => {
    // Simulate: new session, sessionId not yet captured from init message
    setCurrentQueryContext({
      projectId: 'proj-abc',
      clientId: 'client-xyz',
      // sessionId not set yet
    })

    const result = await executeTool('cron_create', {
      name: 'Reminder no session',
      when: '1 minute from now',
      prompt: 'Do something',
    })

    expect(result.isError).toBeFalsy()

    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === 'Reminder no session')
    expect(job).toBeDefined()
    // projectId should still be set even without parentSessionId
    expect(job!.context.projectId).toBe('proj-abc')
    expect(job!.context.parentSessionId).toBeUndefined()
  })

  it('should handle completely empty context gracefully', async () => {
    // No module context set, no tool input context
    setCurrentQueryContext({})

    const result = await executeTool('cron_create', {
      name: 'Orphan reminder',
      when: '2 minutes from now',
      prompt: 'Orphan task',
    })

    expect(result.isError).toBeFalsy()

    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === 'Orphan reminder')
    expect(job).toBeDefined()
    expect(job!.context.projectId).toBeUndefined()
    expect(job!.context.parentSessionId).toBeUndefined()
  })
})

describe('cron job execution with missing parentSessionId', () => {
  it('executor should pass context to execute callback correctly', async () => {
    let capturedRequest: CronExecutionRequest | null = null

    const executor = new CronExecutor({
      mainAppUrl: 'http://localhost:4200/api/cron',
      configDir: '/tmp/test-codeclaws',
    })

    executor.setExecuteCallback(async (req) => {
      capturedRequest = req
      return { success: true, output: 'Reminder sent' }
    })

    // Simulate a job that was created WITH projectId but WITHOUT parentSessionId
    // (the scenario that was failing)
    const job: CronJob = {
      id: 'cron-test-123',
      name: '10秒提醒',
      schedule: { kind: 'at', at: new Date(Date.now() + 10000).toISOString() },
      prompt: 'Send push notification: 时间到了',
      context: {
        projectId: 'proj-abc',
        clientId: 'client-xyz',
        // parentSessionId is undefined — this was causing the bug
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      deleteAfterRun: true,
    }

    await executor.execute(job, 'run-test-1')

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.context.projectId).toBe('proj-abc')
    expect(capturedRequest!.context.parentSessionId).toBeUndefined()
    // The callback should be able to handle this — executePromptInSession
    // creates a new cron parent session when parentSessionId is missing
  })

  it('executor should fail with clear error when callback returns failure', async () => {
    const executor = new CronExecutor({
      mainAppUrl: 'http://localhost:4200/api/cron',
      configDir: '/tmp/test-codeclaws',
    })

    executor.setExecuteCallback(async (req) => {
      // Simulate: executePromptInSession can't find project
      if (!req.context.parentSessionId && !req.context.projectId) {
        return { success: false, error: 'No session or project ID provided for cron job' }
      }
      return { success: true }
    })

    const jobNoContext: CronJob = {
      id: 'cron-orphan',
      name: 'Orphan job',
      schedule: { kind: 'at', at: new Date(Date.now() + 10000).toISOString() },
      prompt: 'Should fail',
      context: {},
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
    }

    await expect(executor.execute(jobNoContext, 'run-orphan')).rejects.toThrow(
      'No session or project ID provided for cron job',
    )

    // But a job with projectId (no parentSessionId) should succeed
    const jobWithProject: CronJob = {
      ...jobNoContext,
      id: 'cron-with-proj',
      context: { projectId: 'proj-abc' },
    }

    await expect(executor.execute(jobWithProject, 'run-with-proj')).resolves.not.toThrow()
  })
})

describe('end-to-end: cron create → schedule → execute', () => {
  it('should create, schedule, and execute a reminder with context', async () => {
    vi.useFakeTimers()

    let executedRequest: CronExecutionRequest | null = null

    // Real executor callback
    const executorFn = vi.fn(async (job: CronJob, runId: string) => {
      // Simulate what CronExecutor.execute + callback would do
      executedRequest = {
        jobId: job.id,
        runId,
        name: job.name,
        prompt: job.prompt,
        context: {
          projectId: job.context?.projectId,
          clientId: job.context?.clientId,
          parentSessionId: job.context?.parentSessionId,
          workspace: job.context?.workspace,
        },
        timestamp: new Date().toISOString(),
      }
    })

    const testScheduler = new CronScheduler(executorFn)
    initializeCronTools(testScheduler)

    // 1. Set query context (simulates claude.ts before query)
    setCurrentQueryContext({
      projectId: 'proj-reminder',
      clientId: 'client-ios',
      sessionId: 'sess-active',
    })

    // 2. AI creates the cron job (simulates cron_create tool call)
    const createResult = await executeTool('cron_create', {
      name: '10秒提醒',
      when: '10 seconds from now',
      prompt: 'Use push_send to notify user: 时间到了！',
    })

    expect(createResult.isError).toBeFalsy()
    const createText = createResult.content[0].text
    expect(createText).toContain('10秒提醒')

    // 3. Verify the job was persisted with correct context
    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === '10秒提醒')
    expect(job).toBeDefined()
    expect(job!.context.projectId).toBe('proj-reminder')
    expect(job!.context.parentSessionId).toBe('sess-active')

    // 4. Advance time to trigger the job
    await vi.advanceTimersByTimeAsync(11000)

    // 5. Verify the executor was called with correct context
    expect(executorFn).toHaveBeenCalledOnce()
    expect(executedRequest).not.toBeNull()
    expect(executedRequest!.context.projectId).toBe('proj-reminder')
    expect(executedRequest!.context.parentSessionId).toBe('sess-active')
    expect(executedRequest!.prompt).toContain('push_send')

    testScheduler.stop()
    vi.useRealTimers()
  })

  it('should handle reminder created before sessionId is available', async () => {
    vi.useFakeTimers()

    const executorFn = vi.fn().mockResolvedValue(undefined)
    const testScheduler = new CronScheduler(executorFn)
    initializeCronTools(testScheduler)

    // 1. Session not yet initialized — only projectId known
    setCurrentQueryContext({
      projectId: 'proj-new',
      clientId: 'client-new',
      // sessionId will come later from init message
    })

    // 2. Create the job
    await executeTool('cron_create', {
      name: 'Early reminder',
      when: '30 seconds from now',
      prompt: 'Notify user',
    })

    // 3. Verify job has projectId even without parentSessionId
    const jobs = loadJobs()
    const job = Array.from(jobs.values()).find(j => j.name === 'Early reminder')
    expect(job).toBeDefined()
    expect(job!.context.projectId).toBe('proj-new')
    expect(job!.context.parentSessionId).toBeUndefined()
    // executePromptInSession will create a new cron parent session via projectId

    testScheduler.stop()
    vi.useRealTimers()
  })
})
