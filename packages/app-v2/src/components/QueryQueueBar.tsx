import { Button } from '@/components/ui/button'
import { ListOrdered, Play, X } from 'lucide-react'
import type { QueueItem } from '@/store/types'

export function QueryQueueBar({
  items,
  onDequeue,
  onExecuteNow,
}: {
  items: QueueItem[]
  onDequeue: (queryId: string) => void
  onExecuteNow: (queryId: string) => void
}) {
  const queued = items.filter(q => q.status === 'queued')
  if (queued.length === 0) return null

  return (
    <div className="mx-4 mb-2 p-2 rounded-lg border border-border bg-card/50">
      <div className="flex items-center gap-2 mb-1.5">
        <ListOrdered className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          {queued.length} queued {queued.length === 1 ? 'query' : 'queries'}
        </span>
      </div>

      <div className="space-y-1">
        {queued.slice(0, 3).map(q => (
          <div
            key={q.queryId}
            className="flex items-center gap-2 text-xs"
          >
            <span className="text-muted-foreground shrink-0">#{q.position}</span>
            <span className="truncate flex-1">{q.prompt}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={() => onExecuteNow(q.queryId)}
              title="Execute now"
            >
              <Play className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-destructive"
              onClick={() => onDequeue(q.queryId)}
              title="Remove"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
        {queued.length > 3 && (
          <p className="text-xs text-muted-foreground">+{queued.length - 3} more</p>
        )}
      </div>
    </div>
  )
}
