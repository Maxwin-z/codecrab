// QueryQueueBar — shows running + queued queries above the input bar
import { useState } from 'react'
import type { QueueItem } from '@/hooks/useWebSocket'

interface QueryQueueBarProps {
  items: QueueItem[]
  currentSessionId: string
  onAbort: (queryId?: string) => void
  onDequeue: (queryId: string) => void
  onExecuteNow: (queryId: string) => void
  isAborting?: boolean
}

export function QueryQueueBar({ items, currentSessionId, onAbort, onDequeue, onExecuteNow, isAborting }: QueryQueueBarProps) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmQueryId, setConfirmQueryId] = useState<string | null>(null)
  const [showExecConfirm, setShowExecConfirm] = useState<string | null>(null)

  if (items.length === 0) return null

  return (
    <div className="px-4 py-2 border-t shrink-0">
      <div className="flex flex-col gap-1.5">
        {items.map((item) => {
          const isRunning = item.status === 'running'
          const isCron = item.queryType === 'cron'
          const isOtherSession = item.sessionId && item.sessionId !== currentSessionId
          const label = isCron
            ? `Cron: ${item.cronJobName || 'task'}`
            : item.prompt.length > 60
              ? item.prompt.slice(0, 57) + '...'
              : item.prompt

          return (
            <div
              key={item.queryId}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                isRunning
                  ? 'bg-primary/5 border border-primary/20'
                  : 'bg-muted/50 border border-border'
              }`}
            >
              {/* Status indicator */}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40'
              }`} />

              {/* Prompt text */}
              <span className="flex-1 min-w-0 truncate text-foreground/80">
                {label}
              </span>

              {/* Session badge for cross-session items */}
              {isOtherSession && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                  {item.sessionId!.slice(-6)}
                </span>
              )}

              {/* Action buttons */}
              {isRunning ? (
                <button
                  onClick={() => {
                    setConfirmQueryId(isOtherSession ? item.queryId : null)
                    setShowConfirm(true)
                  }}
                  disabled={isAborting}
                  className="shrink-0 px-2 py-0.5 text-xs rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                  title={isAborting ? 'Stopping...' : 'Stop running query'}
                >
                  {isAborting ? 'Stopping...' : 'Stop'}
                </button>
              ) : (
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => setShowExecConfirm(item.queryId)}
                    className="px-2 py-0.5 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    title="Execute in a new session immediately"
                  >
                    Run Now
                  </button>
                  <button
                    onClick={() => onDequeue(item.queryId)}
                    className="px-2 py-0.5 text-xs rounded bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title="Remove from queue"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Stop confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background border rounded-xl shadow-lg p-5 max-w-sm w-full mx-4">
            <p className="text-sm font-medium mb-1">Stop running query?</p>
            <p className="text-xs text-muted-foreground mb-4">This will abort the currently running query. Any queued queries will remain in the queue.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowConfirm(false); onAbort(confirmQueryId ?? undefined) }}
                className="px-3 py-1.5 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Execute Now confirmation dialog */}
      {showExecConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background border rounded-xl shadow-lg p-5 max-w-sm w-full mx-4">
            <p className="text-sm font-medium mb-1">Execute in new session?</p>
            <p className="text-xs text-muted-foreground mb-4">This query will be removed from the queue and executed immediately in a new parallel session. Permission requests will be auto-approved.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowExecConfirm(null)}
                className="px-3 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onExecuteNow(showExecConfirm); setShowExecConfirm(null) }}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Run Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
