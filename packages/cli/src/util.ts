import { exec } from 'child_process'

/** Colored log helpers */
export const log = {
  info: (msg: string) => console.log(`\x1b[36m[codecrab]\x1b[0m ${msg}`),
  success: (msg: string) => console.log(`\x1b[32m[codecrab]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m[codecrab]\x1b[0m ${msg}`),
  error: (msg: string) => console.error(`\x1b[31m[codecrab]\x1b[0m ${msg}`),
}

/** Open a URL in the default browser */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open'

  return new Promise((resolve) => {
    exec(`${cmd} "${url}"`, (err) => {
      if (err) {
        log.warn(`Could not open browser automatically. Open this URL manually:\n  ${url}`)
      }
      resolve()
    })
  })
}

/** Wait for the server health endpoint to respond */
export async function waitForServer(port: number, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`)
      if (res.ok) return
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Server did not start within ${maxRetries * 300 / 1000}s`)
}
