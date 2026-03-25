import { ClaudeAgent } from './agent/index.js'
import { CoreEngine } from './core/index.js'
import { setupGateway } from './gateway/index.js'
import { initSoul } from './soul/agent.js'
import { initCronScheduler } from './cron/scheduler.js'
import { ensureToken } from './gateway/auth.js'

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
  initSoul(core)
  const cronScheduler = initCronScheduler(core)

  // 4. Create Gateway (pass in Core)
  const { server, broadcaster, heartbeat } = setupGateway(core)

  // 5. Ensure auth token
  const token = await ensureToken()
  console.log(`[CodeCrab v2] Auth token ready`)

  // 6. Start server
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[CodeCrab v2] Server listening on http://0.0.0.0:${PORT}`)
    console.log(`[CodeCrab v2] Access token: ${token}`)
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[CodeCrab v2] Shutting down...')
    heartbeat.destroy()
    cronScheduler.destroy()
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
