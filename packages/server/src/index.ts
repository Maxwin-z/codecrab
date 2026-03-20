import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

// Load .env from project root (two levels up from packages/server/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../..', '.env') })

import express from 'express'
import { createServer } from 'http'
import setupRouter from './api/setup.js'
import filesRouter from './api/files.js'
import projectsRouter from './api/projects.js'
import authRouter from './api/auth.js'
import sessionsRouter from './api/sessions.js'
import { chromeRouter } from './mcp/chrome/index.js'
import { cronRouter, initCronSystem } from './mcp/cron/index.js'
import { pushRouter, initPush } from './mcp/push/index.js'
import soulRouter from './api/soul.js'
import imagesRouter from './api/images.js'
import { ensureSoulProject } from './soul/project.js'
import { getAvailableMcps } from './mcp/index.js'
import debugRouter from './api/debug.js'
import { ensureToken, authMiddleware } from './auth/index.js'
import { setupWebSocket, executePromptInSession, broadcastToProject, queryQueue } from './ws/index.js'
import {
  createClientState,
  executeQuery,
  handleQuestionResponse,
  handlePermissionResponse,
  getOrCreateProjectState,
  storeAssistantMessage,
  generateSessionId,
} from './engine/claude.js'
import { ChannelManager, createChannelRouter, createWebhookRouter } from '@codecrab/channels'
import type { ChannelEngineContext } from '@codecrab/channels'
import os from 'os'

export interface StartServerOptions {
  port?: number
}

/**
 * Create and start the CodeCrab server.
 * Returns a promise that resolves with the port once the server is listening.
 */
export async function startServer(options: StartServerOptions = {}): Promise<{ port: number }> {
  const PORT = options.port || Number(process.env.PORT) || 4200

  const app = express()
  const server = createServer(app)

  app.use(express.json())

  // CORS — allow cross-origin requests (needed when web app connects to a different server)
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

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

  // Service discovery endpoint (no auth required, used by LAN scanner)
  app.get('/api/discovery', (_req, res) => {
    res.json({ service: 'CodeCrab', version: '0.1.0' })
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

  // Public debug endpoints (no auth required, for troubleshooting)
  app.use('/api/debug', debugRouter)

  // Public image serving (content-addressed, hash-based filenames — no auth needed)
  app.use('/api/images', imagesRouter)

  // Channel system — create manager with engine context (DI to avoid circular deps)
  const PROJECTS_FILE = path.join(os.homedir(), '.codecrab', 'projects.json')
  const channelEngineContext: ChannelEngineContext = {
    queryQueue,
    createClientState,
    executeQuery,
    handleQuestionResponse,
    handlePermissionResponse,
    broadcastToProject,
    getOrCreateProjectState,
    storeAssistantMessage,
    generateSessionId,
    listProjects: async () => {
      try {
        const data = fs.readFileSync(PROJECTS_FILE, 'utf-8')
        return JSON.parse(data)
      } catch {
        return []
      }
    },
  }
  const channelManager = new ChannelManager(channelEngineContext)

  // Public channel webhook route (before auth — external platforms call this)
  app.use('/api/channels/webhook', createWebhookRouter(channelManager))

  // Serve the web app static files (before auth — the app handles its own auth via API calls)
  const appDistCandidates = [
    path.resolve(__dirname, '../../app/dist'),       // from packages/server/src (dev with tsx)
    path.resolve(__dirname, '../../../app/dist'),     // from packages/server/dist (compiled)
  ]
  const appDistDir = appDistCandidates.find(dir => fs.existsSync(path.join(dir, 'index.html')))
  if (appDistDir) {
    app.use(express.static(appDistDir))
    // SPA fallback for non-API routes — serve index.html so client-side routing works
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
        res.sendFile(path.join(appDistDir, 'index.html'))
        return
      }
      next()
    })
    console.log(`[server] Serving web app from ${appDistDir}`)
  }

  // Auth middleware — validates token on all subsequent routes
  app.use(authMiddleware)

  // Protected routes (require valid token)
  app.use('/api/setup', setupRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/projects', projectsRouter)
  app.use('/api/sessions', sessionsRouter)
  app.use('/api/chrome', chromeRouter)
  app.use('/api/cron', cronRouter)
  app.use('/api/push', pushRouter)
  app.use('/api/soul', soulRouter)
  app.use('/api/channels', createChannelRouter(channelManager))

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
  await ensureToken()

  // Initialize push notifications (APNs)
  initPush()

  // Initialize SOUL project (creates directory, CLAUDE.md, registers in projects.json)
  try {
    ensureSoulProject()
    console.log('[server] SOUL project initialized')
  } catch (err) {
    console.error('[server] Failed to initialize SOUL project:', err)
  }

  // Setup WebSocket server
  const wss = setupWebSocket(server)

  // Initialize cron system
  const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
  const cronSystem = initCronSystem({
    configDir: CONFIG_DIR,
    mainAppUrl: `http://localhost:${PORT}/api/cron`,
  })

  // Set up cron execution callback to run prompt in the original session
  cronSystem.setExecuteCallback(async (request) => {
    const { parentSessionId, projectId } = request.context

    console.log(`[CronExecute] Job: ${request.name} (${request.jobId}), parentSession=${parentSessionId}, project=${projectId}`)

    // Execute the prompt via the query queue
    const result = await executePromptInSession(parentSessionId, projectId, request.prompt, request.name, {
      cronJobId: request.jobId,
      cronRunId: request.runId,
    })

    console.log(`[CronExecute] Job ${request.jobId} result: success=${result.success}`)
    return result
  })

  // Restore enabled channel instances from disk
  try {
    await channelManager.restoreChannels()
  } catch (err) {
    console.error('[server] Failed to restore channel instances:', err)
  }

  return new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on http://0.0.0.0:${PORT}`)
      resolve({ port: PORT })
    })

    // Graceful shutdown — close server and WebSocket on termination signals
    const shutdown = (signal: string) => {
      console.log(`[server] ${signal} received, shutting down...`)
      wss.close()
      cronSystem.stop()
      channelManager.stopAll().catch(() => {})
      server.close(() => {
        console.log(`[server] closed`)
        process.exit(0)
      })
      // Force exit if graceful shutdown takes too long
      setTimeout(() => process.exit(1), 3000)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  })
}

// Auto-start when run directly (not imported as a module)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('/server/src/index.ts') ||
  process.argv[1].endsWith('/server/dist/index.js')
)
if (isDirectRun) {
  startServer()
}
