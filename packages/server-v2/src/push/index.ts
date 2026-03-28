// Push notification consumer — subscribes to core events and sends APNs notifications
//
// Components:
//   apns.ts   — HTTP/2 client for direct APNs communication (JWT auth)
//   store.ts  — Device token persistence (~/.codecrab/push-devices.json)

import fs from 'fs'
import path from 'path'
import os from 'os'
import { initApns, isApnsConfigured, broadcastPush, closeApns } from './apns.js'
import { getDeviceTokens } from './store.js'
import type { CoreEngine } from '../core/index.js'

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

/** Best-effort push to all registered devices — never throws */
async function sendPush(title: string, body: string, data?: Record<string, string>): Promise<void> {
  if (!isApnsConfigured()) return
  const tokens = getDeviceTokens()
  if (tokens.length === 0) return

  try {
    const results = await broadcastPush(tokens, title, body, data)
    for (let i = 0; i < results.length; i++) {
      const token = tokens[i]
      if (results[i]?.success) {
        console.log(`[Push] Sent to ${token.slice(0, 8)}...`)
      } else {
        console.log(`[Push] Failed for ${token.slice(0, 8)}... reason=${results[i]?.reason}`)
      }
    }
  } catch (err: any) {
    console.error(`[Push] Failed: ${err.message}`)
  }
}

/** Subscribe to core events and send push notifications */
export function initPushConsumer(core: CoreEngine): void {
  initPush()

  // Push on query summary (normal query completion)
  core.on('turn:summary', (e) => {
    const title = getProjectDisplayName(e.projectId)
    sendPush(title, e.summary, { projectId: e.projectId, sessionId: e.sessionId })
  })

  // Push on background task completion/failure
  core.on('turn:background_task', (e) => {
    if (e.status === 'completed' || e.status === 'failed') {
      const title = getProjectDisplayName(e.projectId)
      const body = e.status === 'completed'
        ? `Background task done: ${e.summary || e.taskId}`
        : `Background task failed: ${e.summary || e.taskId}`
      sendPush(title, body, { projectId: e.projectId, sessionId: e.sessionId })
    }
  })

  // Push on ask_user_question (so user sees it even if app is backgrounded)
  core.on('interaction:ask_question', (e) => {
    const title = getProjectDisplayName(e.projectId)
    const body = e.questions?.length > 0 ? e.questions[0].question : 'A question needs your answer'
    sendPush(title, body, { projectId: e.projectId, sessionId: e.sessionId })
  })
}

export { closeApns } from './apns.js'
export { registerDevice, unregisterDevice, getDevices } from './store.js'
export { isApnsConfigured } from './apns.js'
