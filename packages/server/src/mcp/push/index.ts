// Push MCP — Apple Push Notification service (APNs)
//
// Components:
//   apns.ts   — HTTP/2 client for direct APNs communication (JWT auth)
//   store.ts  — Device token persistence (~/.codeclaws/push-devices.json)
//   tools.ts  — MCP tool definitions (push_send)
//   routes.ts — REST endpoints (/api/push/*)

import fs from 'fs'
import path from 'path'
import os from 'os'
import { initApns, isApnsConfigured, broadcastPush } from './apns.js'
import { getDeviceTokens } from './store.js'

const PROJECTS_FILE = path.join(os.homedir(), '.codeclaws', 'projects.json')

/** Initialize APNs. Call once at server startup. */
export function initPush(): boolean {
  return initApns()
}

/** Look up project display name (icon + name) from projects.json */
function getProjectDisplayName(projectId: string): string {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf-8')
    const projects: { id: string; name: string; icon?: string }[] = JSON.parse(data)
    const project = projects.find((p) => p.id === projectId)
    if (project) {
      return project.icon ? `${project.icon} ${project.name}` : project.name
    }
  } catch {}
  return 'CodeClaws'
}

/** Send push notification when a query completes with a summary.
 *  Best-effort — never throws. */
export async function sendQueryCompletionPush(summary: string, projectId: string, sessionId: string): Promise<void> {
  if (!isApnsConfigured()) return
  const tokens = getDeviceTokens()
  if (tokens.length === 0) return

  try {
    const title = getProjectDisplayName(projectId)
    console.log(`[Push] Sending completion push — title="${title}" projectId=${projectId} sessionId=${sessionId} devices=${tokens.length}`)
    const results = await broadcastPush(tokens, title, summary, { projectId, sessionId })
    const succeeded = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success)
    console.log(`[Push] Broadcast done — ${succeeded}/${results.length} succeeded`)
    if (failed.length > 0) {
      failed.forEach(r => console.log(`[Push]   failed: ${r.token.slice(0, 8)}... reason=${r.reason}`))
    }
  } catch (err: any) {
    console.error(`[Push] Failed to send completion push: ${err.message}`)
  }
}

export { pushTools } from './tools.js'
export { default as pushRouter } from './routes.js'
