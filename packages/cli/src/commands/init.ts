import { readConfig, writeConfig, generateToken, ensureToken } from '@codecrab/server/auth'
import { startServer } from '@codecrab/server'
import { openBrowser, waitForServer, log } from '../util.js'

export async function init() {
  log.info('Initializing CodeCrab...')

  // Check if already initialized
  const existingConfig = await readConfig()
  if (existingConfig.token) {
    log.warn('Already initialized. Generating a new token...')
  }

  // Generate and save token
  const token = generateToken()
  await writeConfig({ ...existingConfig, token })
  log.success(`Token generated: ${token.slice(0, 8)}...${token.slice(-8)}`)

  // Start server
  log.info('Starting server...')
  const { port } = await startServer()

  // Wait for server to be ready
  await waitForServer(port)
  log.success(`Server running at http://localhost:${port}`)

  // Open browser with token for auto-login → setup page
  const url = `http://localhost:${port}/setup?token=${token}`
  log.info('Opening browser for setup...')
  await openBrowser(url)
  log.success('Browser opened. Complete model configuration in the web UI.')
  log.info('Press Ctrl+C to stop the server.')
}
