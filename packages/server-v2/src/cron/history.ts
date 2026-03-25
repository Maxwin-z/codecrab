import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CronExecution } from '../types/index.js'

const HISTORY_DIR = join(homedir(), '.codecrab', 'cron', 'history')

export class CronHistory {
  constructor(private historyDir: string = HISTORY_DIR) {}

  async log(execution: CronExecution): Promise<void> {
    try {
      await mkdir(this.historyDir, { recursive: true })
      const file = join(this.historyDir, `${execution.jobId}.jsonl`)
      await appendFile(file, JSON.stringify(execution) + '\n')
    } catch {
      // Ignore logging errors
    }
  }

  async getForJob(jobId: string, limit = 50): Promise<CronExecution[]> {
    try {
      const data = await readFile(join(this.historyDir, `${jobId}.jsonl`), 'utf-8')
      const lines = data.trim().split('\n').filter(Boolean)
      const executions: CronExecution[] = []
      for (const line of lines) {
        try {
          executions.push(JSON.parse(line))
        } catch {
          // Skip corrupted lines
        }
      }
      // Return most recent first, limited
      return executions.reverse().slice(0, limit)
    } catch {
      return []
    }
  }
}
