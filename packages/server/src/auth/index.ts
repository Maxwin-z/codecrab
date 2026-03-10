// Auth module — Token-based authentication
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Request, Response, NextFunction } from 'express'

const CONFIG_DIR = path.join(os.homedir(), '.codeclaws')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export interface ServerConfig {
  token?: string
  accessToken?: string
  networkMode?: 'local' | 'lan' | 'public'
}

/** Generate a secure random token */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Read server config from ~/.codeclaws/config.json */
export async function readConfig(): Promise<ServerConfig> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

/** Write server config to ~/.codeclaws/config.json */
export async function writeConfig(config: ServerConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}

/** Ensure a token exists in config, generating one if needed */
export async function ensureToken(): Promise<string> {
  const config = await readConfig()
  if (config.token) {
    return config.token
  }
  // Backward compatibility: check for accessToken
  if (config.accessToken) {
    config.token = config.accessToken
    await writeConfig(config)
    return config.token
  }
  const token = generateToken()
  config.token = token
  await writeConfig(config)
  console.log(`[auth] Generated new token: ${token.slice(0, 8)}...${token.slice(-8)}`)
  return token
}

/** Validate a token against the stored token */
export async function validateToken(token: string): Promise<boolean> {
  const config = await readConfig()
  const validToken = config.token || config.accessToken
  if (!validToken) return false
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(validToken))
  } catch {
    // Different lengths
    return false
  }
}

/** Get the stored token (for server use only) */
export async function getToken(): Promise<string | undefined> {
  const config = await readConfig()
  return config.token || config.accessToken
}

/** Express middleware to validate token from Authorization header */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for public routes
  if (req.path === '/api/auth/login' || req.path === '/api/auth/status') {
    next()
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader) {
    res.status(401).json({ error: 'Unauthorized: Missing Authorization header' })
    return
  }

  // Support "Bearer <token>" format
  const parts = authHeader.split(' ')
  const token = parts.length === 2 && parts[0].toLowerCase() === 'bearer'
    ? parts[1]
    : authHeader

  validateToken(token).then(isValid => {
    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized: Invalid token' })
      return
    }
    next()
  }).catch(() => {
    res.status(401).json({ error: 'Unauthorized: Token validation failed' })
  })
}

/** WebSocket upgrade verification callback */
export async function verifyWebSocketToken(info: { origin?: string; req: Request }): Promise<boolean> {
  const url = new URL(info.req.url || '/', `http://${info.req.headers.host}`)
  const token = url.searchParams.get('token')

  if (!token) {
    return false
  }

  return await validateToken(token)
}
