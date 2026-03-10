// Public setup detection handlers — used before authentication
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'os'
import type { Request, Response } from 'express'
import type { DetectResult } from '@codeclaws/shared'

const execFileAsync = promisify(execFile)

const CLAUDE_DIR = path.join(os.homedir(), '.claude')

// GET /api/setup/detect — quick check: does ~/.claude exist?
export async function detectHandler(_req: Request, res: Response): Promise<void> {
  let claudeCodeInstalled = false
  try {
    await fs.access(CLAUDE_DIR)
    claudeCodeInstalled = true
  } catch {
    // not installed
  }
  res.json({ claudeCodeInstalled })
}

// GET /api/setup/detect/probe — full probe: CLI binary + auth status
export async function probeHandler(_req: Request, res: Response): Promise<void> {
  const result: DetectResult = {
    claudeCodeInstalled: false,
    cliAvailable: false,
    configDir: CLAUDE_DIR,
  }

  // 1. Check if ~/.claude exists
  try {
    await fs.access(CLAUDE_DIR)
    result.claudeCodeInstalled = true
  } catch {
    res.json(result)
    return
  }

  // 2. Check if `claude` binary is available and get version
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 })
    result.cliAvailable = true
    result.cliVersion = stdout.trim().split(' ')[0] // e.g. "2.1.71"
  } catch {
    // CLI not in PATH or not executable
    res.json(result)
    return
  }

  // 3. Check auth status via `claude auth status`
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 5000 })
    const authData = JSON.parse(stdout.trim())
    result.auth = {
      loggedIn: authData.loggedIn ?? false,
      authMethod: authData.authMethod,
      subscriptionType: authData.subscriptionType,
    }
  } catch {
    result.auth = { loggedIn: false }
  }

  res.json(result)
}
