import express from 'express'
import setupRouter from './api/setup.js'
import filesRouter from './api/files.js'
import projectsRouter from './api/projects.js'
import authRouter from './api/auth.js'
import { ensureToken, authMiddleware } from './auth/index.js'

const app = express()
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

// Public auth routes (no token required)
app.use('/api/auth', authRouter)

// Auth middleware — validates token on all subsequent routes
app.use(authMiddleware)

// Protected routes (require valid token)
app.use('/api/setup', setupRouter)
app.use('/api/files', filesRouter)
app.use('/api/projects', projectsRouter)

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[error] ${_req.method} ${_req.originalUrl}:`, err.message)
  res.status(500).json({ error: err.message })
})

// Initialize token and start server
ensureToken().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`)
  })
})
