import express from 'express'
import { createServer, type Server } from 'node:http'
import type { CoreEngine } from '../core/index.js'
import type { CronScheduler } from '../cron/scheduler.js'
import { Broadcaster } from './broadcaster.js'
import { HeartbeatManager } from './heartbeat.js'
import { setupWebSocket } from './ws.js'
import { createRouter } from './http.js'

export interface GatewayOptions {
  cronScheduler?: CronScheduler
}

export interface GatewayComponents {
  app: express.Application
  server: Server
  broadcaster: Broadcaster
  heartbeat: HeartbeatManager
}

export function setupGateway(core: CoreEngine, opts?: GatewayOptions): GatewayComponents {
  const app = express()

  // Middleware
  app.use(express.json({ limit: '50mb' }))

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // Routes
  const router = createRouter(core, { cronScheduler: opts?.cronScheduler })
  app.use(router)

  // HTTP server
  const server = createServer(app)

  // Broadcaster
  const broadcaster = new Broadcaster(core)

  // WebSocket
  setupWebSocket(server, core, broadcaster)

  // Heartbeat
  const heartbeat = new HeartbeatManager(core, broadcaster)

  return { app, server, broadcaster, heartbeat }
}
