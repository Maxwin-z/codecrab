import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronExecutor } from '../executor.js'
import type { CronJob, CronExecutionRequest, CronExecutionResult } from '../types.js'

// Mock store to avoid filesystem
vi.mock('../store.js', () => ({
  appendRun: vi.fn(),
}))

function createTestJob(): CronJob {
  return {
    id: 'test-job-1',
    name: 'Test Job',
    schedule: { kind: 'at', at: new Date(Date.now() + 60000).toISOString() },
    prompt: 'Do something',
    context: { projectId: 'proj-1', clientId: 'client-1' },
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
  }
}

describe('CronExecutor', () => {
  let executor: CronExecutor

  beforeEach(() => {
    executor = new CronExecutor({
      mainAppUrl: 'http://localhost:4200/api/cron',
      configDir: '/tmp/test-codecrab',
    })
  })

  it('should execute via callback when set', async () => {
    const callback = vi.fn().mockResolvedValue({
      success: true,
      output: 'Done!',
    } satisfies CronExecutionResult)

    executor.setExecuteCallback(callback)

    const job = createTestJob()
    await executor.execute(job, 'run-1')

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'test-job-1',
        runId: 'run-1',
        prompt: 'Do something',
        context: expect.objectContaining({ projectId: 'proj-1' }),
      }),
    )
  })

  it('should throw when execution fails', async () => {
    const callback = vi.fn().mockResolvedValue({
      success: false,
      error: 'No client connected',
    } satisfies CronExecutionResult)

    executor.setExecuteCallback(callback)

    const job = createTestJob()
    await expect(executor.execute(job, 'run-2')).rejects.toThrow('No client connected')
  })

  it('should cancel active runs', async () => {
    // Start a long-running execution
    const callback = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10000)),
    )

    executor.setExecuteCallback(callback)

    const job = createTestJob()
    const promise = executor.execute(job, 'run-3').catch(() => {})

    // Cancel should return true for active run
    const cancelled = executor.cancel('run-3')
    expect(cancelled).toBe(true)

    // Cancel non-existent should return false
    expect(executor.cancel('non-existent')).toBe(false)
  })

  it('should pass correct execution request fields', async () => {
    let capturedRequest: CronExecutionRequest | null = null

    executor.setExecuteCallback(async (req) => {
      capturedRequest = req
      return { success: true }
    })

    const job = createTestJob()
    job.context.workspace = '/home/user/project'

    await executor.execute(job, 'run-4')

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.jobId).toBe(job.id)
    expect(capturedRequest!.name).toBe(job.name)
    expect(capturedRequest!.prompt).toBe(job.prompt)
    expect(capturedRequest!.context.workspace).toBe('/home/user/project')
    expect(capturedRequest!.timestamp).toBeTruthy()
  })
})
