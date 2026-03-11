import express from 'express'
import { createServer } from 'http'
import setupRouter from './api/setup.js'
import filesRouter from './api/files.js'
import projectsRouter from './api/projects.js'
import authRouter from './api/auth.js'
import sessionsRouter from './api/sessions.js'
import { chromeRouter } from './mcp/chrome/index.js'
import { getAvailableMcps } from './mcp/index.js'
import { ensureToken, authMiddleware } from './auth/index.js'
import { setupWebSocket } from './ws/index.js'

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
  setupWebSocket(server)

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`)
  })
})
