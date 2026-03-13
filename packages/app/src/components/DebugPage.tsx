import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionInfo } from '@codeclaws/shared'

interface ProjectSummary {
  project: {
    id: string
    name: string
    path: string
    icon: string
  }
  sessions: SessionInfo[]
}

function StatusDot({ status, isActive }: { status?: string; isActive?: boolean }) {
  if (status === 'processing') {
    return <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" title="processing" />
  }
  if (status === 'error') {
    return <span className="w-2 h-2 rounded-full bg-red-500" title="error" />
  }
  if (isActive) {
    return <span className="w-2 h-2 rounded-full bg-green-500" title="idle (active)" />
  }
  return <span className="w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-600" title="idle" />
}

function StatusBadge({ status, isActive }: { status?: string; isActive?: boolean }) {
  if (status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/20 text-yellow-600 dark:text-yellow-400">
        <span className="w-1 h-1 rounded-full bg-yellow-500 animate-pulse" />
        processing
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-600 dark:text-red-400">
        error
      </span>
    )
  }
  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/20 text-green-600 dark:text-green-400">
        active
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-500/10 text-muted-foreground">
      idle
    </span>
  )
}

function timeAgo(ts: number, now: number): string {
  const diff = now - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function DebugPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/debug/sessions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      // Auto-expand projects that have active/processing sessions
      const autoExpand = new Set<string>()
      for (const group of json as ProjectSummary[]) {
        if (group.sessions.some((s: SessionInfo) => s.status === 'processing' || s.isActive)) {
          autoExpand.add(group.project.id)
        }
      }
      setExpanded((prev) => new Set([...prev, ...autoExpand]))
    } catch (err: any) {
      setError(err.message || 'Failed to fetch')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchData(false), 5000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Update relative times every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(interval)
  }, [])

  const toggleExpand = (projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  // Stats
  const totalSessions = data.reduce((sum, g) => sum + g.sessions.length, 0)
  const activeSessions = data.reduce((sum, g) => sum + g.sessions.filter((s) => s.isActive).length, 0)
  const processingSessions = data.reduce((sum, g) => sum + g.sessions.filter((s) => s.status === 'processing').length, 0)
  const errorSessions = data.reduce((sum, g) => sum + g.sessions.filter((s) => s.status === 'error').length, 0)

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold tracking-tight">Debug</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => fetchData(true)} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </header>

      {/* Stats bar */}
      <div className="flex items-center gap-4 px-4 py-2.5 border-b bg-muted/30 text-xs">
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{data.length}</span> projects
        </span>
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{totalSessions}</span> sessions
        </span>
        {activeSessions > 0 && (
          <span className="text-green-600 dark:text-green-400">
            <span className="font-medium">{activeSessions}</span> active
          </span>
        )}
        {processingSessions > 0 && (
          <span className="text-yellow-600 dark:text-yellow-400">
            <span className="font-medium">{processingSessions}</span> processing
          </span>
        )}
        {errorSessions > 0 && (
          <span className="text-red-600 dark:text-red-400">
            <span className="font-medium">{errorSessions}</span> errors
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {loading && data.length === 0 && (
          <p className="text-sm text-muted-foreground p-4">Loading...</p>
        )}

        {!loading && data.length === 0 && !error && (
          <p className="text-sm text-muted-foreground p-4">No projects found.</p>
        )}

        <div className="divide-y">
          {data.map((group) => {
            const isExpanded = expanded.has(group.project.id)
            const hasProcessing = group.sessions.some((s) => s.status === 'processing')
            const hasError = group.sessions.some((s) => s.status === 'error')
            const hasActive = group.sessions.some((s) => s.isActive)

            return (
              <div key={group.project.id}>
                {/* Project header */}
                <button
                  onClick={() => toggleExpand(group.project.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors text-left"
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  }
                  <span className="text-base shrink-0">{group.project.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{group.project.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {group.sessions.length} session{group.sessions.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {group.project.path && (
                      <p className="text-xs text-muted-foreground/60 font-mono truncate">{group.project.path}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {hasProcessing && <StatusDot status="processing" />}
                    {hasError && <StatusDot status="error" />}
                    {hasActive && !hasProcessing && <StatusDot isActive />}
                  </div>
                </button>

                {/* Session list */}
                {isExpanded && (
                  <div className="bg-muted/20 border-t">
                    {group.sessions.length === 0 && (
                      <p className="text-xs text-muted-foreground px-4 py-3 pl-11">No sessions</p>
                    )}
                    {group.sessions.map((session) => (
                      <div
                        key={session.sessionId}
                        className="flex items-start gap-3 px-4 py-2.5 pl-11 border-b border-border/50 last:border-b-0 hover:bg-accent/30 transition-colors"
                      >
                        <StatusDot status={session.status} isActive={session.isActive} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">
                            {session.summary || session.firstPrompt || 'Untitled session'}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            <span className="text-[11px] font-mono text-muted-foreground/50">{session.sessionId}</span>
                            <StatusBadge status={session.status} isActive={session.isActive} />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-muted-foreground">{timeAgo(session.lastModified, now)}</span>
                            <span className="text-muted-foreground/30">·</span>
                            <span className="text-[11px] text-muted-foreground/60">{formatTime(session.lastModified)}</span>
                          </div>
                          {session.cwd && (
                            <p className="text-[11px] text-muted-foreground/40 font-mono truncate mt-0.5">{session.cwd}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
