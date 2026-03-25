import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

const CONFIG_DIR = join(homedir(), '.codecrab')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface Config {
  token?: string
  networkMode?: string
}

let cachedConfig: Config | null = null

export async function readConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8')
    cachedConfig = JSON.parse(data)
    return cachedConfig!
  } catch {
    return {}
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
  cachedConfig = config
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export async function ensureToken(): Promise<string> {
  const config = await readConfig()
  if (config.token) return config.token
  const token = generateToken()
  await writeConfig({ ...config, token })
  return token
}

export async function getToken(): Promise<string | null> {
  const config = await readConfig()
  return config.token || null
}

export async function validateToken(token: string): Promise<boolean> {
  const config = await readConfig()
  if (!config.token) return false
  try {
    const a = Buffer.from(token)
    const b = Buffer.from(config.token)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Express middleware for token auth */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' })
    return
  }
  const token = authHeader.slice(7)
  validateToken(token).then(valid => {
    if (!valid) {
      res.status(401).json({ error: 'Invalid token' })
      return
    }
    next()
  }).catch(() => {
    res.status(500).json({ error: 'Auth error' })
  })
}

/** Verify WebSocket token from query parameter */
export async function verifyWebSocketToken(token: string | null): Promise<boolean> {
  if (!token) return false
  return validateToken(token)
}
