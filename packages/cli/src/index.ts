#!/usr/bin/env node

const VERSION = '0.1.0'

const HELP = `
  codecrab v${VERSION} — AI-powered coding engine

  Usage:
    codecrab init              Initialize: generate token, start server, open browser
    codecrab start             Start the server
    codecrab start --open      Start the server and open browser
    codecrab token             Show the current access token
    codecrab token refresh     Generate a new access token
    codecrab --help            Show this help message
    codecrab --version         Show version
`

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'init': {
      const { init } = await import('./commands/init.js')
      await init()
      break
    }

    case 'start': {
      const { start } = await import('./commands/start.js')
      await start({ open: args.includes('--open') })
      break
    }

    case 'token': {
      const { token } = await import('./commands/token.js')
      await token({ refresh: args[1] === 'refresh' })
      break
    }

    case '--version':
    case '-v':
      console.log(VERSION)
      break

    case '--help':
    case '-h':
    case undefined:
      console.log(HELP)
      break

    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
