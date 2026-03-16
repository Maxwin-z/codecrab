// CronCard — Dashboard card showing scheduled tasks summary

import { useNavigate } from 'react-router'
import { Clock, ChevronRight, Play, AlertTriangle } from 'lucide-react'
import type { CronSummary } from '@/hooks/useCron'

interface CronCardProps {
  summary: CronSummary | null
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) return 'overdue'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'in <1m'
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

export function CronCard({ summary }: CronCardProps) {
  const navigate = useNavigate()

  // Empty state — no cron jobs at all
  if (!summary || summary.totalAll === 0) {
    return (
      <div
        onClick={() => navigate('/cron')}
        className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Scheduled Tasks</h3>
              <p className="text-xs text-muted-foreground">Automated workflows</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          No scheduled tasks yet. Create tasks in chat to automate recurring workflows.
        </p>
      </div>
    )
  }

  const { totalActive, totalAll, statusCounts, nextJob } = summary

  return (
    <div
      onClick={() => navigate('/cron')}
      className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
            <Clock className="h-4 w-4 text-blue-500" />
          </div>
          <div>
            <h3 className="text-sm font-medium">Scheduled Tasks</h3>
            <p className="text-xs text-muted-foreground">
              {totalActive} active · {totalAll} total
            </p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
      </div>

      {/* Status badges */}
      <div className="flex flex-wrap gap-1.5">
        {statusCounts.running > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md bg-orange-500/15 px-2 py-0.5 text-xs text-orange-600 dark:text-orange-400">
            <Play className="h-2.5 w-2.5" />
            {statusCounts.running} running
          </span>
        )}
        {statusCounts.pending > 0 && (
          <span className="inline-flex items-center rounded-md bg-blue-500/15 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
            {statusCounts.pending} pending
          </span>
        )}
        {statusCounts.failed > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            {statusCounts.failed} failed
          </span>
        )}
        {statusCounts.disabled > 0 && (
          <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
            {statusCounts.disabled} paused
          </span>
        )}
      </div>

      {/* Next upcoming job */}
      {nextJob && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3 mt-0.5 shrink-0 text-blue-500" />
          <div className="min-w-0">
            <span className="line-clamp-1">{nextJob.name}</span>
            {nextJob.nextRunAt && (
              <span className="text-muted-foreground/50 ml-1">{timeUntil(nextJob.nextRunAt)}</span>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      {statusCounts.completed > 0 && (
        <div className="flex items-center text-xs text-muted-foreground/50 pt-1 border-t">
          <span>{statusCounts.completed} completed</span>
        </div>
      )}
    </div>
  )
}
