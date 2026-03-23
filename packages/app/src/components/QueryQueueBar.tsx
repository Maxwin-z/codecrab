// QueryQueueBar — floating button that expands to show queue management
import { useState, useRef, useEffect } from 'react'
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
  const [expanded, setExpanded] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmQueryId, setConfirmQueryId] = useState<string | null>(null)
  const [showExecConfirm, setShowExecConfirm] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close panel when clicking outside
  useEffect(() => {
    if (!expanded) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [expanded])

  if (items.length === 0) return null

  const runningCount = items.filter((i) => i.status === 'running').length
  const queuedCount = items.length - runningCount

  return (
    <>
      {/* Floating button — positioned absolutely in the parent's stacking context */}
      <div className="relative shrink-0" ref={panelRef}>
        {/* Expanded panel */}
        {expanded && (
          <div className="absolute bottom-full right-4 mb-2 w-80 max-h-72 overflow-y-auto bg-background border rounded-xl shadow-xl z-40">
            <div className="px-3 py-2 border-b flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Query Queue ({items.length})
              </span>
              <button
                onClick={() => setExpanded(false)}
                className="text-muted-foreground/60 hover:text-foreground transition-colors text-sm leading-none px-1"
              >
                ✕
              </button>
            </div>
            <div className="p-2 flex flex-col gap-1.5">
              {items.map((item) => {
                const isRunning = item.status === 'running'
                const isCron = item.queryType === 'cron'
                const isOtherSession = item.sessionId && item.sessionId !== currentSessionId
                const label = isCron
                  ? `Cron: ${item.cronJobName || 'task'}`
                  : item.prompt.length > 50
                    ? item.prompt.slice(0, 47) + '...'
                    : item.prompt

                return (
                  <div
                    key={item.queryId}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                      isRunning
                        ? 'bg-primary/5 border border-primary/20'
                        : 'bg-muted/50 border border-border'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      isRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40'
                    }`} />

                    <span className="flex-1 min-w-0 truncate text-foreground/80">
                      {label}
                    </span>

                    {isOtherSession && (
                      <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                        {item.sessionId!.slice(-6)}
                      </span>
                    )}

                    {isRunning ? (
                      <button
                        onClick={() => {
                          setConfirmQueryId(isOtherSession ? item.queryId : null)
                          setShowConfirm(true)
                        }}
                        disabled={isAborting}
                        className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                        title={isAborting ? 'Stopping...' : 'Stop running query'}
                      >
                        {isAborting ? '...' : 'Stop'}
                      </button>
                    ) : (
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => setShowExecConfirm(item.queryId)}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          title="Execute in a new session immediately"
                        >
                          Run
                        </button>
                        <button
                          onClick={() => onDequeue(item.queryId)}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          title="Remove from queue"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Floating trigger button */}
        <div className="flex justify-end px-4 py-1.5">
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-md border transition-all ${
              runningCount > 0
                ? 'bg-primary text-primary-foreground border-primary/50 hover:bg-primary/90'
                : 'bg-background text-foreground border-border hover:bg-accent'
            }`}
          >
            {runningCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            )}
            <span>
              {runningCount > 0 && `${runningCount} running`}
              {runningCount > 0 && queuedCount > 0 && ' · '}
              {queuedCount > 0 && `${queuedCount} queued`}
            </span>
          </button>
        </div>
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
    </>
  )
}
