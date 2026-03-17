// Cron job storage — JSON file based persistence (~/.codecrab/cron/)

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { CronJob, CronJobRun } from './types.js'

let CRON_DIR = path.join(os.homedir(), '.codecrab', 'cron')
let JOBS_FILE = path.join(CRON_DIR, 'jobs.json')
let RUNS_DIR = path.join(CRON_DIR, 'runs')

/** Override the cron data directory (for testing). */
export function setCronDir(dir: string): void {
  CRON_DIR = dir
  JOBS_FILE = path.join(dir, 'jobs.json')
  RUNS_DIR = path.join(dir, 'runs')
}

/** Reset to the default cron data directory. */
export function resetCronDir(): void {
  CRON_DIR = path.join(os.homedir(), '.codecrab', 'cron')
  JOBS_FILE = path.join(CRON_DIR, 'jobs.json')
  RUNS_DIR = path.join(CRON_DIR, 'runs')
}

function ensureDirs() {
  if (!fs.existsSync(CRON_DIR)) {
    fs.mkdirSync(CRON_DIR, { recursive: true })
  }
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, { recursive: true })
  }
}

export function loadJobs(): Map<string, CronJob> {
  ensureDirs()
  try {
    if (!fs.existsSync(JOBS_FILE)) {
      return new Map()
    }
    const data = fs.readFileSync(JOBS_FILE, 'utf-8')
    const jobs: CronJob[] = JSON.parse(data)
    return new Map(jobs.map((j) => [j.id, j]))
  } catch (err) {
    console.error('[CronStore] Failed to load jobs:', err)
    return new Map()
  }
}

export function saveJobs(jobs: Map<string, CronJob>): void {
  ensureDirs()
  const jobsArray = Array.from(jobs.values())
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsArray, null, 2))
}

export function saveJob(job: CronJob): void {
  const jobs = loadJobs()
  jobs.set(job.id, job)
  saveJobs(jobs)
}

export function deleteJob(jobId: string): boolean {
  const jobs = loadJobs()
  const job = jobs.get(jobId)
  if (!job) return false

  job.status = 'deprecated'
  job.deprecatedAt = new Date().toISOString()
  job.updatedAt = new Date().toISOString()
  saveJobs(jobs)
  return true
}

export function getJob(jobId: string): CronJob | undefined {
  const jobs = loadJobs()
  return jobs.get(jobId)
}

export function listJobs(options?: {
  projectId?: string
  status?: string
  includeDeprecated?: boolean
  limit?: number
}): CronJob[] {
  const jobs = loadJobs()
  let result = Array.from(jobs.values())

  // Exclude deprecated tasks by default
  if (!options?.includeDeprecated && options?.status !== 'deprecated') {
    result = result.filter((j) => j.status !== 'deprecated')
  }

  if (options?.projectId) {
    result = result.filter((j) => j.context.projectId === options.projectId)
  }
  if (options?.status) {
    result = result.filter((j) => j.status === options.status)
  }

  result.sort((a, b) => {
    const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity
    const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity
    return aTime - bTime
  })

  if (options?.limit) {
    result = result.slice(0, options.limit)
  }

  return result
}

export function appendRun(jobId: string, run: CronJobRun): void {
  ensureDirs()
  const runFile = path.join(RUNS_DIR, `${jobId}.jsonl`)
  const line = JSON.stringify(run) + '\n'
  fs.appendFileSync(runFile, line)
}

export function getRuns(jobId: string, limit = 50): CronJobRun[] {
  const runFile = path.join(RUNS_DIR, `${jobId}.jsonl`)
  if (!fs.existsSync(runFile)) {
    return []
  }

  const content = fs.readFileSync(runFile, 'utf-8')
  const lines = content
    .split('\n')
    .filter((line) => line.trim())
    .slice(-limit)

  return lines.map((line) => JSON.parse(line))
}

export function generateJobId(): string {
  return `cron-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}
