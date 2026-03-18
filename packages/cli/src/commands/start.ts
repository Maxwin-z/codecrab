import { getToken } from '@codecrab/server/auth'
import { startServer } from '@codecrab/server'
import { openBrowser, waitForServer, log } from '../util.js'

export interface StartOptions {
  open?: boolean
}

export async function start(options: StartOptions = {}) {
  const token = await getToken()
  if (!token) {
    log.error('Not initialized. Run `codecrab init` first.')
    process.exit(1)
  }

  log.info('Starting CodeCrab server...')
  const { port } = await startServer()

  await waitForServer(port)
  log.success(`Server running at http://localhost:${port}`)

  if (options.open) {
    const url = `http://localhost:${port}?token=${token}`
    await openBrowser(url)
    log.success('Browser opened.')
  }

  log.info('Press Ctrl+C to stop the server.')
}
