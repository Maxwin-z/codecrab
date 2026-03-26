import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/auth'
import { useStore } from '@/store/store'
import { useShallow } from 'zustand/react/shallow'
import { selectSessionStatuses } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { Clock, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionInfo } from '@codecrab/shared'

export function SessionSidebar({
  projectId,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onUnauthorized,
  providerNames,
}: {
  projectId: string
  currentSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onUnauthorized?: () => void
  providerNames?: Record<string, string>
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const sessionStatuses = useStore(useShallow(selectSessionStatuses(projectId)))

  const loadSessions = useCallback(async () => {
    try {
      const res = await authFetch(`/api/sessions?projectId=${projectId}`, {}, onUnauthorized)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sort((a: SessionInfo, b: SessionInfo) => b.lastModified - a.lastModified))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [projectId, onUnauthorized])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Refresh list when current session changes (e.g., new session created)
  useEffect(() => {
    if (currentSessionId) {
      loadSessions()
    }
  }, [currentSessionId])

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    try {
      await authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }, onUnauthorized)
      setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
    } catch { /* ignore */ }
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  // Merge REST session status with real-time store status
  const getSessionStatus = (sessionId: string, restStatus?: string) => {
    return sessionStatuses[sessionId] || restStatus || 'idle'
  }

  return (
    <div className="w-64 border-r border-border bg-card flex flex-col h-full shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-medium">Sessions</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNewSession}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="text-xs text-muted-foreground text-center py-4">Loading...</p>
        )}

        {!loading && sessions.length === 0 && (
          <div className="text-center py-8 space-y-2">
            <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No sessions yet</p>
          </div>
        )}

        {sessions.map(s => {
          const status = getSessionStatus(s.sessionId, s.status)
          return (
            <button
              key={s.sessionId}
              className={cn(
                'w-full text-left px-3 py-2 border-b border-border/50 transition-colors group cursor-pointer',
                s.sessionId === currentSessionId
                  ? 'bg-accent'
                  : 'hover:bg-accent/50',
              )}
              onClick={() => onSelectSession(s.sessionId)}
            >
              <div className="flex items-start justify-between gap-1">
                <p className="text-sm font-medium truncate flex-1">
                  {s.summary || s.firstPrompt || 'Untitled session'}
                </p>
                <button
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-all cursor-pointer"
                  onClick={(e) => handleDelete(e, s.sessionId)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{formatTime(s.lastModified)}</span>
                {status === 'processing' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-pulse ml-1" />
                )}
                {s.cronJobName && (
                  <span className="text-xs text-muted-foreground ml-1">cron: {s.cronJobName}</span>
                )}
                {s.providerId && providerNames?.[s.providerId] && (
                  <span className="text-xs text-muted-foreground ml-auto truncate max-w-[80px]" title={providerNames[s.providerId]}>
                    {providerNames[s.providerId]}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
