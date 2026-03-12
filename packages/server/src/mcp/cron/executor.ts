// Cron Executor — dispatches cron job execution via WebSocket callback

import type { CronJob, CronJobRun, CronExecutionRequest, CronExecutionResult } from './types.js'
import { appendRun } from './store.js'

export interface ExecutorOptions {
  mainAppUrl: string
  configDir: string
  onExecuteRequest?: (request: CronExecutionRequest) => Promise<CronExecutionResult>
}

export class CronExecutor {
  private options: ExecutorOptions
  private activeRuns = new Map<string, AbortController>()

  constructor(options: ExecutorOptions) {
    this.options = options
  }

  setExecuteCallback(
    callback: (request: CronExecutionRequest) => Promise<CronExecutionResult>,
  ): void {
    this.options.onExecuteRequest = callback
  }

  async execute(job: CronJob, runId: string): Promise<void> {
    console.log(`[Executor] Starting job: ${job.id} (${job.name}), runId=${runId}`)

    const controller = new AbortController()
    this.activeRuns.set(runId, controller)

    const startTime = Date.now()

    try {
      const executionRequest: CronExecutionRequest = {
        jobId: job.id,
        runId,
        name: job.name,
        prompt: job.prompt,
        context: {
          projectId: job.context?.projectId,
          clientId: job.context?.clientId,
          sessionId: job.context?.sessionId,
          workspace: job.context?.workspace,
        },
        timestamp: new Date().toISOString(),
      }

      let result: CronExecutionResult
      if (this.options.onExecuteRequest) {
        result = await this.options.onExecuteRequest(executionRequest)
      } else {
        result = await this.executeViaHttp(executionRequest)
      }

      if (!result.success) {
        throw new Error(result.error || 'Execution failed')
      }

      const duration = Date.now() - startTime

      const run: CronJobRun = {
        id: runId,
        jobId: job.id,
        startedAt: new Date(startTime).toISOString(),
        endedAt: new Date().toISOString(),
        status: 'completed',
        output: result.output || 'Task executed successfully',
        durationMs: duration,
      }
      appendRun(job.id, run)

      console.log(`[Executor] Job ${job.id} completed in ${duration}ms`)
    } catch (err) {
      const error = String(err)
      console.error(`[Executor] Job ${job.id} failed: ${error}`)

      appendRun(job.id, {
        id: runId,
        jobId: job.id,
        startedAt: new Date(startTime).toISOString(),
        endedAt: new Date().toISOString(),
        status: 'failed',
        error,
        durationMs: Date.now() - startTime,
      })

      throw err
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  private async executeViaHttp(
    request: CronExecutionRequest,
  ): Promise<CronExecutionResult> {
    const response = await fetch(`${this.options.mainAppUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return (await response.json()) as CronExecutionResult
  }

  cancel(runId: string): boolean {
    const controller = this.activeRuns.get(runId)
    if (controller) {
      controller.abort()
      this.activeRuns.delete(runId)
      return true
    }
    return false
  }
}
