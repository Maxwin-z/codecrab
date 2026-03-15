// Cron job types and interfaces

export type CronSchedule =
  | { kind: 'at'; at: string } // ISO 8601 timestamp
  | { kind: 'every'; everyMs: number } // milliseconds
  | { kind: 'cron'; expr: string; tz?: string } // cron expression with optional timezone

export type CronJobStatus =
  | 'pending' // waiting to execute
  | 'running' // currently executing
  | 'completed' // executed successfully
  | 'failed' // execution failed
  | 'disabled' // manually disabled
  | 'deprecated' // soft-deleted (retained for debugging)

export interface CronJobContext {
  projectId?: string
  clientId?: string
  sessionId?: string
  workspace?: string
  [key: string]: unknown
}

export interface CronJob {
  id: string
  name: string
  description?: string
  schedule: CronSchedule
  prompt: string
  context: CronJobContext
  status: CronJobStatus
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  runCount: number
  maxRuns?: number
  deleteAfterRun?: boolean
  delivery?: {
    mode: 'websocket' | 'none'
    target?: string
  }
  deprecatedAt?: string
}

export interface CronJobRun {
  id: string
  jobId: string
  startedAt: string
  endedAt?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  output?: string
  error?: string
  durationMs?: number
}

export interface CronCreateParams {
  name: string
  when: string
  prompt: string
  recurring?: boolean
  cronExpression?: string
  timezone?: string
  description?: string
  deleteAfterRun?: boolean
}

export interface CronListParams {
  status?: CronJobStatus
  limit?: number
}

export interface CronDeleteParams {
  jobId: string
}

export interface CronUpdateParams {
  jobId: string
  name?: string
  prompt?: string
  description?: string
  when?: string
  recurring?: boolean
  cronExpression?: string
  timezone?: string
  deleteAfterRun?: boolean
  maxRuns?: number
}

export interface CronExecutionRequest {
  jobId: string
  runId: string
  name: string
  prompt: string
  context: CronJobContext
  timestamp: string
}

export interface CronExecutionResult {
  success: boolean
  output?: string
  error?: string
  durationMs?: number
}
