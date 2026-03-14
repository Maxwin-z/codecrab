// QueryQueueBar — shows running + queued queries above the input bar
import type { QueueItem } from '@/hooks/useWebSocket'

interface QueryQueueBarProps {
  items: QueueItem[]
  currentSessionId: string
  onAbort: () => void
  onDequeue: (queryId: string) => void
  isAborting?: boolean
}

export function QueryQueueBar({ items, currentSessionId, onAbort, onDequeue, isAborting }: QueryQueueBarProps) {
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

              {/* Action button */}
              {isRunning ? (
                <button
                  onClick={onAbort}
                  disabled={isAborting}
                  className="shrink-0 px-2 py-0.5 text-xs rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                  title={isAborting ? 'Stopping...' : 'Stop running query'}
                >
                  {isAborting ? 'Stopping...' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={() => onDequeue(item.queryId)}
                  className="shrink-0 px-2 py-0.5 text-xs rounded bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Remove from queue"
                >
                  Remove
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
