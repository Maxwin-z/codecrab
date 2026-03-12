// Cron MCP — Scheduled task management
//
// Components:
//   types.ts      — Type definitions
//   store.ts      — JSON file persistence (~/.codeclaws/cron/)
//   scheduler.ts  — node-cron task scheduling
//   executor.ts   — WebSocket-based execution dispatch
//   tools.ts      — MCP tool definitions for Claude Agent SDK
//   routes.ts     — REST endpoints (/api/cron/*)

import { CronScheduler } from './scheduler.js'
import { CronExecutor } from './executor.js'
import { initializeCronTools, cronTools } from './tools.js'
import type { CronJob } from './types.js'
import type { CronExecutionRequest, CronExecutionResult } from './types.js'

export interface CronSystemOptions {
  configDir: string
  mainAppUrl: string
}

export class CronSystem {
  public scheduler: CronScheduler
  public executor: CronExecutor
  public isRunning = false

  constructor(options: CronSystemOptions) {
    this.executor = new CronExecutor({
      configDir: options.configDir,
      mainAppUrl: options.mainAppUrl,
    })

    this.scheduler = new CronScheduler(async (job: CronJob, runId: string) => {
      await this.executor.execute(job, runId)
    })

    initializeCronTools(this.scheduler)
  }

  start(): void {
    if (this.isRunning) return
    this.scheduler.start()
    this.isRunning = true
    console.log('[CronSystem] Started')
  }

  stop(): void {
    if (!this.isRunning) return
    this.scheduler.stop()
    this.isRunning = false
    console.log('[CronSystem] Stopped')
  }

  setExecuteCallback(
    callback: (request: CronExecutionRequest) => Promise<CronExecutionResult>,
  ): void {
    this.executor.setExecuteCallback(callback)
  }
}

// Singleton
let cronSystem: CronSystem | null = null

export function initCronSystem(options: CronSystemOptions): CronSystem {
  if (cronSystem) {
    return cronSystem
  }

  cronSystem = new CronSystem(options)
  cronSystem.start()
  return cronSystem
}

export function getCronSystem(): CronSystem | null {
  return cronSystem
}

export function stopCronSystem(): void {
  cronSystem?.stop()
  cronSystem = null
}

export { cronTools, setCurrentQueryContext as setCronQueryContext } from './tools.js'
export { default as cronRouter } from './routes.js'
export type { CronExecutionRequest, CronExecutionResult } from './types.js'
