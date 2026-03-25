import type { CoreEngine } from '../core/index.js'
import type { Broadcaster } from './broadcaster.js'

const HEARTBEAT_THROTTLE_MS = 10_000
const PERIODIC_HEARTBEAT_INTERVAL_MS = 10_000

export class HeartbeatManager {
  private lastBroadcast = new Map<string, number>()  // queryId -> last broadcast time
  private projectActivity = new Map<string, { activityType: string; toolName?: string; textSnippet?: string; lastUpdate: number }>()
  private activityBroadcastTimer: ReturnType<typeof setInterval> | null = null

  private static readonly PROJECT_ACTIVITY_THROTTLE_MS = 2_000

  constructor(private core: CoreEngine, private broadcaster: Broadcaster) {
    this.subscribe()
    this.startPeriodicBroadcast()
  }

  private subscribe(): void {
    this.core.on('turn:activity', (e) => {
      // Throttle heartbeat per query
      const lastTime = this.lastBroadcast.get(e.queryId) || 0
      const now = Date.now()
      if (now - lastTime >= HEARTBEAT_THROTTLE_MS) {
        this.lastBroadcast.set(e.queryId, now)
        this.broadcaster.broadcastToProject(e.projectId, {
          type: 'activity_heartbeat',
          projectId: e.projectId,
          sessionId: e.sessionId,
          queryId: e.queryId,
          elapsedMs: e.elapsedMs,
          lastActivityType: e.activityType,
          lastToolName: e.toolName,
          textSnippet: e.textSnippet,
          paused: e.paused,
        })
      }

      // Track project activity (throttled separately)
      const pa = this.projectActivity.get(e.projectId)
      if (!pa || now - pa.lastUpdate >= HeartbeatManager.PROJECT_ACTIVITY_THROTTLE_MS) {
        this.projectActivity.set(e.projectId, {
          activityType: e.activityType,
          toolName: e.toolName,
          textSnippet: e.textSnippet,
          lastUpdate: now,
        })
        this.broadcaster.broadcastGlobal({
          type: 'project_activity',
          projectId: e.projectId,
          activityType: this.mapActivityType(e.activityType),
          toolName: e.toolName,
          textSnippet: e.textSnippet,
        })
      }
    })

    // Clean up when turn closes
    this.core.on('turn:close', (e) => {
      // Remove activity tracking for completed queries
      this.projectActivity.delete(e.projectId)
      this.broadcaster.broadcastGlobal({
        type: 'project_activity',
        projectId: e.projectId,
        activityType: 'idle',
      })
    })
  }

  private mapActivityType(type: string): 'thinking' | 'text' | 'tool_use' | 'idle' {
    if (type === 'thinking_delta') return 'thinking'
    if (type === 'text_delta') return 'text'
    if (type === 'tool_use' || type === 'tool_result') return 'tool_use'
    return 'idle'
  }

  private startPeriodicBroadcast(): void {
    // Periodic timer for cleanup of stale entries
    this.activityBroadcastTimer = setInterval(() => {
      const now = Date.now()
      for (const [queryId, lastTime] of this.lastBroadcast.entries()) {
        if (now - lastTime > 60_000) {
          this.lastBroadcast.delete(queryId)
        }
      }
    }, PERIODIC_HEARTBEAT_INTERVAL_MS)
  }

  destroy(): void {
    if (this.activityBroadcastTimer) {
      clearInterval(this.activityBroadcastTimer)
      this.activityBroadcastTimer = null
    }
    this.lastBroadcast.clear()
    this.projectActivity.clear()
  }
}
