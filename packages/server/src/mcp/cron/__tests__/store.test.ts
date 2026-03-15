import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  loadJobs,
  saveJob,
  deleteJob,
  getJob,
  listJobs,
  appendRun,
  getRuns,
  generateJobId,
  generateRunId,
} from '../store.js'
import type { CronJob, CronJobRun } from '../types.js'

const CRON_DIR = path.join(os.homedir(), '.codeclaws', 'cron')
const JOBS_FILE = path.join(CRON_DIR, 'jobs.json')
const RUNS_DIR = path.join(CRON_DIR, 'runs')

function createTestJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: generateJobId(),
    name: 'Test Job',
    schedule: { kind: 'at', at: new Date(Date.now() + 60000).toISOString() },
    prompt: 'Test prompt',
    context: { projectId: 'proj-1' },
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  }
}

// Backup and restore real jobs file to avoid clobbering user data
let backupData: string | null = null

beforeEach(() => {
  if (fs.existsSync(JOBS_FILE)) {
    backupData = fs.readFileSync(JOBS_FILE, 'utf-8')
  }
  // Start each test with empty store
  if (fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, '[]')
  }
})

afterEach(() => {
  // Restore original data
  if (backupData !== null) {
    fs.writeFileSync(JOBS_FILE, backupData)
  } else if (fs.existsSync(JOBS_FILE)) {
    fs.unlinkSync(JOBS_FILE)
  }
  backupData = null
})

describe('CronStore', () => {
  it('should save and load a job', () => {
    const job = createTestJob()
    saveJob(job)

    const loaded = getJob(job.id)
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe(job.id)
    expect(loaded!.name).toBe('Test Job')
    expect(loaded!.prompt).toBe('Test prompt')
  })

  it('should list jobs', () => {
    const job1 = createTestJob({ name: 'Job 1' })
    const job2 = createTestJob({ name: 'Job 2' })
    saveJob(job1)
    saveJob(job2)

    const jobs = listJobs()
    expect(jobs.length).toBe(2)
  })

  it('should filter jobs by projectId', () => {
    const job1 = createTestJob({ context: { projectId: 'proj-a' } })
    const job2 = createTestJob({ context: { projectId: 'proj-b' } })
    saveJob(job1)
    saveJob(job2)

    const filtered = listJobs({ projectId: 'proj-a' })
    expect(filtered.length).toBe(1)
    expect(filtered[0].id).toBe(job1.id)
  })

  it('should filter jobs by status', () => {
    const job1 = createTestJob({ status: 'pending' })
    const job2 = createTestJob({ status: 'failed' })
    saveJob(job1)
    saveJob(job2)

    const filtered = listJobs({ status: 'pending' })
    expect(filtered.length).toBe(1)
    expect(filtered[0].id).toBe(job1.id)
  })

  it('should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      saveJob(createTestJob({ name: `Job ${i}` }))
    }

    const limited = listJobs({ limit: 3 })
    expect(limited.length).toBe(3)
  })

  it('should soft-delete a job by marking it as deprecated', () => {
    const job = createTestJob()
    saveJob(job)
    expect(getJob(job.id)).toBeDefined()

    const deleted = deleteJob(job.id)
    expect(deleted).toBe(true)

    // Job still exists but is marked as deprecated
    const deprecatedJob = getJob(job.id)
    expect(deprecatedJob).toBeDefined()
    expect(deprecatedJob!.status).toBe('deprecated')
    expect(deprecatedJob!.deprecatedAt).toBeDefined()
  })

  it('should exclude deprecated jobs from listJobs by default', () => {
    const job1 = createTestJob({ name: 'Active Job' })
    const job2 = createTestJob({ name: 'To Deprecate' })
    saveJob(job1)
    saveJob(job2)

    deleteJob(job2.id)

    const jobs = listJobs()
    expect(jobs.length).toBe(1)
    expect(jobs[0].name).toBe('Active Job')
  })

  it('should include deprecated jobs when explicitly requested', () => {
    const job1 = createTestJob({ name: 'Active Job' })
    const job2 = createTestJob({ name: 'Deprecated Job' })
    saveJob(job1)
    saveJob(job2)

    deleteJob(job2.id)

    const jobs = listJobs({ includeDeprecated: true })
    expect(jobs.length).toBe(2)
  })

  it('should list only deprecated jobs when filtering by status', () => {
    const job1 = createTestJob({ name: 'Active Job' })
    const job2 = createTestJob({ name: 'Deprecated Job' })
    saveJob(job1)
    saveJob(job2)

    deleteJob(job2.id)

    const jobs = listJobs({ status: 'deprecated' })
    expect(jobs.length).toBe(1)
    expect(jobs[0].name).toBe('Deprecated Job')
  })

  it('should return false when deleting non-existent job', () => {
    const deleted = deleteJob('non-existent')
    expect(deleted).toBe(false)
  })

  it('should update an existing job', () => {
    const job = createTestJob()
    saveJob(job)

    job.status = 'running'
    job.runCount = 1
    saveJob(job)

    const loaded = getJob(job.id)
    expect(loaded!.status).toBe('running')
    expect(loaded!.runCount).toBe(1)
  })

  it('should generate unique IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateJobId())
    }
    expect(ids.size).toBe(100)
  })

  it('should append and retrieve runs', () => {
    const jobId = 'test-job-runs'
    const runFile = path.join(RUNS_DIR, `${jobId}.jsonl`)

    // Clean up any existing run file
    if (fs.existsSync(runFile)) {
      fs.unlinkSync(runFile)
    }

    const run1: CronJobRun = {
      id: generateRunId(),
      jobId,
      startedAt: new Date().toISOString(),
      status: 'completed',
      output: 'success',
      durationMs: 100,
    }

    const run2: CronJobRun = {
      id: generateRunId(),
      jobId,
      startedAt: new Date().toISOString(),
      status: 'failed',
      error: 'timeout',
      durationMs: 5000,
    }

    appendRun(jobId, run1)
    appendRun(jobId, run2)

    const runs = getRuns(jobId)
    expect(runs.length).toBe(2)
    expect(runs[0].status).toBe('completed')
    expect(runs[1].status).toBe('failed')

    // Clean up
    if (fs.existsSync(runFile)) {
      fs.unlinkSync(runFile)
    }
  })

  it('should return empty array for non-existent run history', () => {
    const runs = getRuns('non-existent-job')
    expect(runs).toEqual([])
  })

  it('should respect runs limit', () => {
    const jobId = 'test-job-runs-limit'
    const runFile = path.join(RUNS_DIR, `${jobId}.jsonl`)

    if (fs.existsSync(runFile)) {
      fs.unlinkSync(runFile)
    }

    for (let i = 0; i < 10; i++) {
      appendRun(jobId, {
        id: generateRunId(),
        jobId,
        startedAt: new Date().toISOString(),
        status: 'completed',
      })
    }

    const limited = getRuns(jobId, 3)
    expect(limited.length).toBe(3)

    // Clean up
    if (fs.existsSync(runFile)) {
      fs.unlinkSync(runFile)
    }
  })
})
