// Cron REST API routes — execution dispatch and health check

import { Router } from 'express'
import type { CronExecutionResult } from './types.js'
import { getCronSystem } from './index.js'
import { getJob, listJobs } from './store.js'

const cronRouter: Router = Router()

// Pending executions waiting for client results
const pendingExecutions = new Map<
  string,
  {
    resolve: (result: CronExecutionResult) => void
    timeout: NodeJS.Timeout
  }
>()

// POST /api/cron/execute — called when a cron job triggers
cronRouter.post('/execute', async (_req, res) => {
  const request = _req.body
  console.log(`[Cron API] Execution request: job=${request.jobId}, run=${request.runId}`)

  try {
    const cronSystem = getCronSystem()
    if (!cronSystem) {
      res.status(503).json({ success: false, error: 'Cron system not initialized' })
      return
    }

    res.json({ success: true, message: 'Execution dispatched' })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/cron/result/:runId — client reports execution result
cronRouter.post('/result/:runId', (_req, res) => {
  const runId = _req.params.runId as string
  const result: CronExecutionResult = _req.body

  const pending = pendingExecutions.get(runId)
  if (pending) {
    pending.resolve(result)
    clearTimeout(pending.timeout)
    pendingExecutions.delete(runId)
    res.json({ received: true })
  } else {
    res.status(404).json({ error: 'No pending execution found' })
  }
})

// POST /api/cron/schedule/:jobId — schedule a job
cronRouter.post('/schedule/:jobId', (_req, res) => {
  const jobId = _req.params.jobId as string
  const job = getJob(jobId)

  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }

  const cronSystem = getCronSystem()
  if (!cronSystem) {
    res.status(503).json({ error: 'Cron system not initialized' })
    return
  }

  const scheduled = cronSystem.scheduler.scheduleJob(job)
  res.json({ scheduled, jobId })
})

// GET /api/cron/jobs — list all cron jobs
cronRouter.get('/jobs', (_req, res) => {
  const projectId = _req.query.projectId as string | undefined
  const status = _req.query.status as string | undefined
  const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : undefined
  const includeDeprecated = _req.query.includeDeprecated === 'true'

  const jobs = listJobs({ projectId, status, limit, includeDeprecated })
  res.json(jobs)
})

// GET /api/cron/summary — dashboard summary (active count + next job)
cronRouter.get('/summary', (_req, res) => {
  // Include deprecated so we can show accurate total and history counts
  const allJobs = listJobs({ includeDeprecated: true })
  const nonDeprecated = allJobs.filter((j) => j.status !== 'deprecated')

  const activeJobs = nonDeprecated.filter((j) => j.status === 'pending' || j.status === 'running')
  const disabledJobs = nonDeprecated.filter((j) => j.status === 'disabled')
  const failedJobs = nonDeprecated.filter((j) => j.status === 'failed')
  const completedJobs = nonDeprecated.filter((j) => j.status === 'completed')
  const deprecatedJobs = allJobs.filter((j) => j.status === 'deprecated')

  // Find next upcoming job (already sorted by nextRunAt from listJobs)
  const nextJob = activeJobs.find((j) => j.nextRunAt) || null

  res.json({
    totalActive: activeJobs.length,
    totalAll: allJobs.length,
    statusCounts: {
      pending: activeJobs.filter((j) => j.status === 'pending').length,
      running: activeJobs.filter((j) => j.status === 'running').length,
      disabled: disabledJobs.length,
      failed: failedJobs.length,
      completed: completedJobs.length,
      deprecated: deprecatedJobs.length,
    },
    nextJob: nextJob
      ? { id: nextJob.id, name: nextJob.name, nextRunAt: nextJob.nextRunAt, status: nextJob.status }
      : null,
  })
})

// GET /api/cron/health — health check
cronRouter.get('/health', (_req, res) => {
  const cronSystem = getCronSystem()
  res.json({
    status: 'ok',
    pendingExecutions: pendingExecutions.size,
    schedulerInitialized: !!cronSystem,
  })
})

export default cronRouter
