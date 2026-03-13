// Push MCP — Apple Push Notification service (APNs)
//
// Components:
//   apns.ts   — HTTP/2 client for direct APNs communication (JWT auth)
//   store.ts  — Device token persistence (~/.codeclaws/push-devices.json)
//   tools.ts  — MCP tool definitions (push_send)
//   routes.ts — REST endpoints (/api/push/*)

import { initApns, isApnsConfigured, broadcastPush } from './apns.js'
import { getDeviceTokens } from './store.js'

/** Initialize APNs. Call once at server startup. */
export function initPush(): boolean {
  return initApns()
}

/** Send push notification when a query completes with a summary.
 *  Best-effort — never throws. */
export async function sendQueryCompletionPush(summary: string, projectName?: string): Promise<void> {
  if (!isApnsConfigured()) return
  const tokens = getDeviceTokens()
  if (tokens.length === 0) return

  try {
    const title = projectName ? `${projectName}` : 'CodeClaws'
    await broadcastPush(tokens, title, summary)
  } catch (err: any) {
    console.error(`[Push] Failed to send completion push: ${err.message}`)
  }
}

export { pushTools } from './tools.js'
export { default as pushRouter } from './routes.js'
