import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })
import { ClaudeAgent } from './agent/index.js'
import { CoreEngine } from './core/index.js'
import { setupGateway } from './gateway/index.js'
import { initSoul } from './soul/agent.js'
import { initCronScheduler } from './cron/scheduler.js'
import { setCronScheduler } from './agent/extensions/cron/tools.js'
import { setMessageRouter } from './agent/extensions/threads/tools.js'
import { initPushConsumer, closeApns } from './push/index.js'
import { ensureToken } from './gateway/auth.js'

const require = createRequire(import.meta.url)
const qrcode = require('qrcode-terminal')

function getLocalIP(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
}

const PORT = parseInt(process.env.PORT || '4200', 10)

async function main(): Promise<void> {
  console.log('[CodeCrab v2] Starting...')

  // 1. Create Agent layer
  const agent = new ClaudeAgent()

  // 2. Create Core (pass in Agent)
  const core = new CoreEngine(agent)
  await core.init()
  console.log(`[CodeCrab v2] Core initialized — ${core.projects.list().length} projects loaded`)

  // 3. Register consumers
  const soulConsumer = initSoul(core)
  const cronScheduler = initCronScheduler(core)
  setCronScheduler(cronScheduler)
  setMessageRouter(core.router)
  initPushConsumer(core)

  // 4. Create Gateway (pass in Core + Cron)
  const { server, broadcaster, heartbeat } = setupGateway(core, { cronScheduler })

  // 5. Ensure auth token
  const token = await ensureToken()
  console.log(`[CodeCrab v2] Auth token ready`)

  // 6. Start server
  server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP()
    const serverURL = `http://${localIP}:${PORT}`
    const qrContent = `codecrab://login?server=${encodeURIComponent(serverURL)}&token=${token}`

    console.log(`[CodeCrab v2] Server listening on ${serverURL}`)
    console.log('')
    console.log('[CodeCrab v2] Scan QR code to connect:')
    qrcode.generate(qrContent, { small: true })
    console.log(`[CodeCrab v2] Access token: ${token}`)
    console.log('')
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[CodeCrab v2] Shutting down...')
    soulConsumer.destroy()
    heartbeat.destroy()
    cronScheduler.destroy()
    closeApns()
    core.turns.destroy()
    server.close(() => {
      console.log('[CodeCrab v2] Server stopped')
      process.exit(0)
    })
    // Force exit after 3 seconds
    setTimeout(() => process.exit(1), 3000)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('[CodeCrab v2] Fatal error:', err)
  process.exit(1)
})
