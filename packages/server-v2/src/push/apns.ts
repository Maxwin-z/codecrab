// APNs HTTP/2 client — direct communication with Apple Push Notification service
//
// Uses token-based authentication (JWT with .p8 key)
// Node.js built-in http2 + crypto, zero external dependencies

import http2 from 'http2'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { unregisterDevice } from './store.js'

// APNs endpoints
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com'
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com'

// JWT cache (APNs tokens valid for 60 min, refresh at 50 min)
const JWT_TTL_MS = 50 * 60 * 1000
let cachedJwt: { token: string; generatedAt: number } | null = null

// HTTP/2 session (reused across requests)
let h2Session: http2.ClientHttp2Session | null = null

// Config
let apnsConfig: {
  keyId: string
  teamId: string
  bundleId: string
  production: boolean
} | null = null

let p8Key: string | null = null

export interface ApnsSendResult {
  token: string
  success: boolean
  status?: number
  reason?: string
}

/** Initialize APNs with environment variables. Returns true if configured.
 *  Supports two ways to provide the key:
 *    - APNS_KEY: the .p8 key content directly (preferred)
 *    - APNS_KEY_PATH: path to the .p8 key file */
export function initApns(): boolean {
  const keyContent = process.env.APNS_KEY
  const keyPath = process.env.APNS_KEY_PATH
  const keyId = process.env.APNS_KEY_ID
  const teamId = process.env.APNS_TEAM_ID
  const bundleId = process.env.APNS_BUNDLE_ID
  const isProduction = process.env.APNS_PRODUCTION === 'false'
    ? false
    : (process.env.APNS_ENVIRONMENT || 'production') === 'production'

  if ((!keyContent && !keyPath) || !keyId || !teamId || !bundleId) {
    console.log('[APNs] Not configured (missing APNS_KEY/APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, or APNS_BUNDLE_ID)')
    return false
  }

  // Load key: prefer APNS_KEY (inline content), fall back to APNS_KEY_PATH (file)
  if (keyContent) {
    p8Key = keyContent.replace(/\\n/g, '\n')
  } else if (keyPath) {
    const resolvedPath = keyPath.startsWith('~')
      ? path.join(process.env.HOME || '', keyPath.slice(1))
      : path.resolve(keyPath)

    if (!fs.existsSync(resolvedPath)) {
      console.error(`[APNs] Key file not found: ${resolvedPath}`)
      return false
    }

    try {
      p8Key = fs.readFileSync(resolvedPath, 'utf-8')
    } catch (err: any) {
      console.error(`[APNs] Failed to read key file: ${err.message}`)
      return false
    }
  }

  apnsConfig = {
    keyId,
    teamId,
    bundleId,
    production: isProduction,
  }

  console.log(`[APNs] Initialized (${isProduction ? 'production' : 'sandbox'}, bundle: ${bundleId})`)
  return true
}

export function isApnsConfigured(): boolean {
  return apnsConfig !== null && p8Key !== null
}

/** Generate or return cached JWT for APNs authentication */
function getJwt(): string {
  if (cachedJwt && Date.now() - cachedJwt.generatedAt < JWT_TTL_MS) {
    return cachedJwt.token
  }

  if (!apnsConfig || !p8Key) {
    throw new Error('APNs not configured')
  }

  const header = { alg: 'ES256', kid: apnsConfig.keyId }
  const payload = { iss: apnsConfig.teamId, iat: Math.floor(Date.now() / 1000) }

  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign('SHA256')
  sign.update(signingInput)
  const signature = sign.sign(p8Key)
  const signatureB64 = base64url(signature)

  const token = `${signingInput}.${signatureB64}`
  cachedJwt = { token, generatedAt: Date.now() }
  return token
}

/** Get or create HTTP/2 session to APNs */
function getH2Session(): http2.ClientHttp2Session {
  if (h2Session && !h2Session.closed && !h2Session.destroyed) {
    return h2Session
  }

  const host = apnsConfig?.production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX
  h2Session = http2.connect(host)

  h2Session.on('error', (err) => {
    console.error(`[APNs] HTTP/2 session error: ${err.message}`)
    h2Session = null
  })

  h2Session.on('close', () => {
    h2Session = null
  })

  return h2Session
}

/** Send a push notification to a single device */
export async function sendPushNotification(
  deviceToken: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<ApnsSendResult> {
  if (!apnsConfig) {
    return { token: deviceToken, success: false, reason: 'APNs not configured' }
  }

  const apnsPayload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      'mutable-content': 1,
    },
    ...data,
  }

  const payloadStr = JSON.stringify(apnsPayload)
  console.log(`[APNs] Sending push to ${deviceToken.slice(0, 8)}... — title="${title}" payload=${payloadStr.length}B env=${apnsConfig.production ? 'production' : 'sandbox'}`)

  return new Promise((resolve) => {
    try {
      const session = getH2Session()
      const jwt = getJwt()

      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': apnsConfig!.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      })

      let responseData = ''
      let statusCode = 0

      req.on('response', (headers) => {
        statusCode = headers[':status'] as number
      })

      req.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      req.on('end', () => {
        if (statusCode === 200) {
          console.log(`[APNs] Push sent to ${deviceToken.slice(0, 8)}...`)
          resolve({ token: deviceToken, success: true, status: 200 })
        } else {
          let reason = `HTTP ${statusCode}`
          try {
            const parsed = JSON.parse(responseData)
            reason = parsed.reason || reason
          } catch {}

          console.error(`[APNs] Push failed for ${deviceToken.slice(0, 8)}... — status=${statusCode} reason=${reason} env=${apnsConfig?.production ? 'production' : 'sandbox'} bundle=${apnsConfig?.bundleId}`)

          // Auto-remove invalid tokens
          if (statusCode === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
            console.log(`[APNs] Removing stale device token: ${deviceToken.slice(0, 8)}...`)
            unregisterDevice(deviceToken)
          }

          resolve({ token: deviceToken, success: false, status: statusCode, reason })
        }
      })

      req.on('error', (err) => {
        resolve({ token: deviceToken, success: false, reason: err.message })
      })

      req.end(payloadStr)
    } catch (err: any) {
      resolve({ token: deviceToken, success: false, reason: err.message })
    }
  })
}

/** Send push notification to multiple devices */
export async function broadcastPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<ApnsSendResult[]> {
  if (tokens.length === 0) return []
  const results = await Promise.allSettled(
    tokens.map((token) => sendPushNotification(token, title, body, data)),
  )
  return results.map((r) =>
    r.status === 'fulfilled' ? r.value : { token: '', success: false, reason: 'Promise rejected' },
  )
}

/** Cleanup: close HTTP/2 session */
export function closeApns(): void {
  if (h2Session) {
    h2Session.close()
    h2Session = null
  }
  cachedJwt = null
}

/** Base64url encode (RFC 7515) */
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
