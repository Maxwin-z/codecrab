import { readConfig, writeConfig, generateToken, getToken } from '@codecrab/server/auth'
import { log } from '../util.js'

export interface TokenOptions {
  refresh?: boolean
}

export async function token(options: TokenOptions = {}) {
  if (options.refresh) {
    const config = await readConfig()
    const newToken = generateToken()
    await writeConfig({ ...config, token: newToken })
    log.success(`Token refreshed: ${newToken.slice(0, 8)}...${newToken.slice(-8)}`)
    log.warn('All existing sessions will need to re-authenticate with the new token.')
    return
  }

  // Show current token
  const currentToken = await getToken()
  if (!currentToken) {
    log.error('No token found. Run `codecrab init` first.')
    process.exit(1)
  }

  console.log(currentToken)
}
