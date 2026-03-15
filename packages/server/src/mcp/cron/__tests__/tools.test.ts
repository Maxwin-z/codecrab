import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { cronTools, initializeCronTools } from '../tools.js'
import { CronScheduler } from '../scheduler.js'
import type { CronJob } from '../types.js'

const CRON_DIR = path.join(os.homedir(), '.codeclaws', 'cron')
const JOBS_FILE = path.join(CRON_DIR, 'jobs.json')

// Helper to execute a tool by name
async function executeTool(name: string, input: Record<string, unknown>) {
  const t = cronTools.find((t: any) => t.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  // The SDK tool() creates objects with an execute method internally,
  // but the actual callable is the tool itself. We need to call it properly.
  // In the SDK, tools are registered and called by the framework.
  // For testing, we access the handler directly.
  const handler = (t as any).handler || (t as any).execute || (t as any).fn
  if (handler) {
    return handler(input)
  }
  // If we can't find the handler, try calling the tool directly
  throw new Error(`Cannot find handler for tool: ${name}`)
}

let backupData: string | null = null
let scheduler: CronScheduler

beforeEach(() => {
  // Backup existing jobs
  if (fs.existsSync(JOBS_FILE)) {
    backupData = fs.readFileSync(JOBS_FILE, 'utf-8')
  }
  if (fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, '[]')
  }

  // Create scheduler with no-op executor
  scheduler = new CronScheduler(vi.fn().mockResolvedValue(undefined))
  initializeCronTools(scheduler)
})

afterEach(() => {
  scheduler.stop()
  if (backupData !== null) {
    fs.writeFileSync(JOBS_FILE, backupData)
  } else if (fs.existsSync(JOBS_FILE)) {
    fs.unlinkSync(JOBS_FILE)
  }
  backupData = null
})

describe('cronTools', () => {
  it('should have 8 tools defined', () => {
    expect(cronTools.length).toBe(8)
  })

  it('should have correct tool names', () => {
    const names = cronTools.map((t: any) => t.name)
    expect(names).toContain('cron_create')
    expect(names).toContain('cron_list')
    expect(names).toContain('cron_delete')
    expect(names).toContain('cron_get')
    expect(names).toContain('cron_pause')
    expect(names).toContain('cron_resume')
    expect(names).toContain('cron_update')
    expect(names).toContain('cron_trigger')
  })

  it('each tool should have a description', () => {
    for (const t of cronTools) {
      expect((t as any).description).toBeTruthy()
    }
  })
})

describe('CronScheduler.parseSchedule integration', () => {
  it('should handle various natural language inputs', () => {
    const cases = [
      { input: '5 minutes from now', expectedKind: 'at' },
      { input: 'tomorrow at 3pm', expectedKind: 'at' },
      { input: 'in 1 hour', expectedKind: 'at' },
    ]

    for (const { input, expectedKind } of cases) {
      const result = CronScheduler.parseSchedule(input)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe(expectedKind)
    }
  })

  it('should handle recurring schedule inputs', () => {
    const cases = [
      { input: '*/5 * * * *', recurring: true, expectedKind: 'cron' },
      { input: 'every 10 minutes', recurring: true, expectedKind: 'every' },
      { input: 'every 1 hour', recurring: true, expectedKind: 'every' },
    ]

    for (const { input, recurring, expectedKind } of cases) {
      const result = CronScheduler.parseSchedule(input, recurring)
      expect(result.isValid).toBe(true)
      expect(result.schedule.kind).toBe(expectedKind)
    }
  })
})
