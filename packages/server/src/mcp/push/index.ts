// Push MCP — Apple Push Notification service (APNs)
//
// Components:
//   apns.ts   — HTTP/2 client for direct APNs communication (JWT auth)
//   store.ts  — Device token persistence (~/.codecrab/push-devices.json)
//   tools.ts  — MCP tool definitions (push_send)
//   routes.ts — REST endpoints (/api/push/*)

import fs from 'fs'
import path from 'path'
import os from 'os'
import { initApns, isApnsConfigured, broadcastPush } from './apns.js'
import { getLastActiveDeviceToken } from './store.js'

const PROJECTS_FILE = path.join(os.homedir(), '.codecrab', 'projects.json')

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
  return 'CodeCrab'
}

/** Send push notification when a query completes with a summary.
 *  Best-effort — never throws. */
export async function sendQueryCompletionPush(summary: string, projectId: string, sessionId: string): Promise<void> {
  if (!isApnsConfigured()) return
  const token = getLastActiveDeviceToken()
  if (!token) return

  try {
    const title = getProjectDisplayName(projectId)
    console.log(`[Push] Sending completion push — title="${title}" projectId=${projectId} sessionId=${sessionId} device=${token.slice(0, 8)}...`)
    const results = await broadcastPush([token], title, summary, { projectId, sessionId })
    if (results[0]?.success) {
      console.log(`[Push] Push sent to ${token.slice(0, 8)}...`)
    } else {
      console.log(`[Push] Push failed for ${token.slice(0, 8)}... reason=${results[0]?.reason}`)
    }
  } catch (err: any) {
    console.error(`[Push] Failed to send completion push: ${err.message}`)
  }
}

export { pushTools } from './tools.js'
export { default as pushRouter } from './routes.js'
