import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as http from 'http'

const CHROME_DEBUG_PORT = 9222
const USER_DATA_DIR = path.join(os.homedir(), '.codeclaws', 'chrome-profile')

let chromeProcess: ChildProcess | null = null

function findChromePath(): string {
  const platform = process.platform
  if (platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
    for (const p of paths) {
      if (fs.existsSync(p)) return p
    }
  } else if (platform === 'linux') {
    const paths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ]
    for (const p of paths) {
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('Chrome not found. Please install Google Chrome.')
}

async function isChromeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`,
      (res) => {
        resolve(res.statusCode === 200)
        res.resume()
      },
    )
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForChrome(
  maxRetries = 15,
  interval = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await isChromeRunning()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

/**
 * Lazily ensure Chrome is running. Called by MCP before connecting.
 * If Chrome is already running, returns immediately.
 */
export async function ensureChromeRunning(): Promise<void> {
  if (await isChromeRunning()) return

  fs.mkdirSync(USER_DATA_DIR, { recursive: true })

  const chromePath = findChromePath()
  console.log(`[Chrome] Lazy starting: ${chromePath}`)

  chromeProcess = spawn(
    chromePath,
    [
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  )

  chromeProcess.unref()

  chromeProcess.on('error', (err) => {
    console.error('[Chrome] Failed to start:', err.message)
    chromeProcess = null
  })

  chromeProcess.on('exit', (code) => {
    console.log(`[Chrome] Exited with code ${code}`)
    chromeProcess = null
  })

  const ready = await waitForChrome()
  if (ready) {
    console.log(`[Chrome] Ready on port ${CHROME_DEBUG_PORT}`)
  } else {
    throw new Error('Chrome failed to start within timeout')
  }
}

export function getChromeDebugUrl(): string {
  return `http://127.0.0.1:${CHROME_DEBUG_PORT}`
}

export { isChromeRunning }

export async function stopChrome(): Promise<void> {
  // Try graceful shutdown via DevTools protocol
  if (await isChromeRunning()) {
    try {
      await new Promise<void>((resolve) => {
        const closeReq = http.request(
          `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/close`,
          { method: 'GET' },
          () => resolve(),
        )
        closeReq.on('error', () => resolve())
        closeReq.end()
      })
    } catch {
      // ignore
    }
  }

  if (chromeProcess) {
    chromeProcess.kill()
    chromeProcess = null
  }
  console.log('[Chrome] Stopped')
}
