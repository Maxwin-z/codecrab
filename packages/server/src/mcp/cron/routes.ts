// Cron REST API routes — execution dispatch and health check

import { Router } from 'express'
import type { CronExecutionResult } from './types.js'
import { getCronSystem } from './index.js'
import { getJob } from './store.js'

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
