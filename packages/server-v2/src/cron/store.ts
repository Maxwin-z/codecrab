import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CronJob } from '../types/index.js'

const CRON_DIR = join(homedir(), '.codecrab', 'cron')
const JOBS_DIR = join(CRON_DIR, 'jobs')

export class CronStore {
  constructor(private jobsDir: string = JOBS_DIR) {}

  async loadAll(): Promise<CronJob[]> {
    const jobs: CronJob[] = []
    try {
      await mkdir(this.jobsDir, { recursive: true })
      const files = await readdir(this.jobsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = await readFile(join(this.jobsDir, file), 'utf-8')
          jobs.push(JSON.parse(data))
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return jobs
  }

  async get(jobId: string): Promise<CronJob | null> {
    try {
      const data = await readFile(join(this.jobsDir, `${jobId}.json`), 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async save(job: CronJob): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true })
    job.updatedAt = Date.now()
    await writeFile(join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2))
  }

  async delete(jobId: string): Promise<void> {
    try {
      await unlink(join(this.jobsDir, `${jobId}.json`))
    } catch {
      // File may not exist
    }
  }
}
