import express from 'express'
import { createServer } from 'http'
import setupRouter from './api/setup.js'
import filesRouter from './api/files.js'
import projectsRouter from './api/projects.js'
import authRouter from './api/auth.js'
import sessionsRouter from './api/sessions.js'
import { chromeRouter } from './mcp/chrome/index.js'
import { cronRouter, initCronSystem } from './mcp/cron/index.js'
import { getAvailableMcps } from './mcp/index.js'
import { ensureToken, authMiddleware } from './auth/index.js'
import { setupWebSocket } from './ws/index.js'
import path from 'path'
import os from 'os'

const app = express()
const server = createServer(app)
const PORT = 4200

app.use(express.json())

// Request logging
app.use((req, res, next) => {
  const start = Date.now()
  const end = res.end
  res.end = function (this: typeof res, ...args: Parameters<typeof end>) {
    const code = res.statusCode
    const color = code < 300 ? '\x1b[32m' : code < 400 ? '\x1b[36m' : code < 500 ? '\x1b[33m' : '\x1b[31m'
    console.log(`${req.method} ${req.originalUrl} ${color}${code}\x1b[0m ${Date.now() - start}ms`)
    return end.apply(this, args)
  } as typeof end
  next()
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

// Public routes (no token required)
app.use('/api/auth', authRouter)

// Public setup detection endpoints (needed before initialization)
app.get('/api/setup/detect', async (_req, res) => {
  const { detectHandler } = await import('./api/setup-detect.js')
  detectHandler(_req, res)
})
app.get('/api/setup/detect/probe', async (_req, res) => {
  const { probeHandler } = await import('./api/setup-detect.js')
  probeHandler(_req, res)
})

// Auth middleware — validates token on all subsequent routes
app.use(authMiddleware)

// Protected routes (require valid token)
app.use('/api/setup', setupRouter)
app.use('/api/files', filesRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/sessions', sessionsRouter)
app.use('/api/chrome', chromeRouter)
app.use('/api/cron', cronRouter)

// MCP registry — list available MCP servers
app.get('/api/mcps', (_req, res) => {
  res.json(getAvailableMcps())
})

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[error] ${_req.method} ${_req.originalUrl}:`, err.message)
  res.status(500).json({ error: err.message })
})

// Initialize token, setup WebSocket, and start server
ensureToken().then(() => {
  // Setup WebSocket server
  const wss = setupWebSocket(server)

  // Initialize cron system
  const CONFIG_DIR = path.join(os.homedir(), '.codeclaws')
  const cronSystem = initCronSystem({
    configDir: CONFIG_DIR,
    mainAppUrl: `http://localhost:${PORT}/api/cron`,
  })

  // Set up cron execution callback to dispatch via WebSocket
  cronSystem.setExecuteCallback(async (request) => {
    const { clientId, projectId } = request.context

    console.log(`[CronExecute] Job: ${request.name} (${request.jobId}), target: client=${clientId}, project=${projectId}`)

    // Find target WebSocket client
    let targetWs: import('ws').WebSocket | null = null

    for (const ws of wss.clients) {
      const info = (ws as any).clientInfo as { clientId?: string; projectId?: string } | undefined
      if (!info) continue
      if (clientId && info.clientId === clientId) {
        targetWs = ws
        break
      }
      if (projectId && info.projectId === projectId) {
        targetWs = ws
      }
    }

    if (!targetWs || targetWs.readyState !== 1 /* WebSocket.OPEN */) {
      console.error('[CronExecute] No connected client found')
      return { success: false, error: 'No connected client found to execute the task' }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error('[CronExecute] Execution timeout')
        resolve({ success: false, error: 'Execution timeout - client did not respond within 60 seconds' })
      }, 60000)

      // Store resolver for when client reports back
      const resolvers: Map<string, (result: any) => void> =
        (globalThis as any).__cronExecutionResolvers ??= new Map()
      resolvers.set(request.runId, (result: any) => {
        clearTimeout(timeout)
        resolve(result)
      })

      // Send execution request to client
      targetWs!.send(JSON.stringify({ type: 'cron_execution_request', ...request }))
      console.log(`[CronExecute] Request sent to client`)
    })
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`)
  })
})
