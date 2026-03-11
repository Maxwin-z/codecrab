// SessionSidebar — session list, resume, and management
import { useState, useEffect, useCallback, useRef } from 'react'
import { useWs } from '@/hooks/WebSocketContext'
import { Button } from '@/components/ui/button'
import { X, Plus, History } from 'lucide-react'
import type { SessionInfo } from '@codeclaws/shared'

function StatusBadge({ status, isActive }: { status?: 'idle' | 'processing' | 'error'; isActive?: boolean }) {
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
        idle
      </span>
    )
  }
  return null
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

interface SessionSidebarProps {
  open: boolean
  onClose: () => void
  projectId?: string
}

export function SessionSidebar({ open, onClose, projectId }: SessionSidebarProps) {
  const ws = useWs()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(Date.now())
  const fetchedRef = useRef(false)

  // Update time display every minute without re-fetching sessions
  useEffect(() => {
    if (!open) return
    const interval = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(interval)
  }, [open])

  const fetchSessions = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      // Fetch sessions filtered by projectId
      const data = await ws.fetchSessions(projectId)
      setSessions(data)
    } catch {
      // ignore
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [ws, projectId])

  // Initial fetch when opening
  useEffect(() => {
    if (open && !fetchedRef.current) {
      fetchedRef.current = true
      fetchSessions(true)
    }
    if (!open) {
      fetchedRef.current = false
    }
  }, [open, fetchSessions])

  // Auto-refresh session list silently when sidebar is open
  useEffect(() => {
    if (!open) return
    const interval = setInterval(() => fetchSessions(false), 3000)
    return () => clearInterval(interval)
  }, [open, fetchSessions])

  const handleResume = (session: SessionInfo) => {
    ws.resumeSession(session.sessionId)
    onClose()
  }

  const handleNewChat = () => {
    ws.newChat()
    onClose()
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Sidebar */}
      <div className="fixed top-0 left-0 h-full w-80 bg-background border-r z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Sessions</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Button
          onClick={handleNewChat}
          className="mx-3 mt-3 mb-1"
          size="sm"
        >
          <Plus className="h-4 w-4 mr-1" />
          New Chat
        </Button>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && <p className="text-xs text-muted-foreground px-2 py-4">Loading...</p>}
          {!loading && sessions.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-4">No previous sessions</p>
          )}
          {sessions.map((session) => (
            <div
              key={session.sessionId}
              onClick={() => handleResume(session)}
              className="group flex items-start gap-2 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-accent transition-colors mb-0.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">
                  {session.summary || session.firstPrompt || 'Untitled session'}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-muted-foreground">{timeAgo(session.lastModified, now)}</p>
                  <span className="text-muted-foreground/50">·</span>
                  <p className="text-xs text-muted-foreground/50 font-mono">{session.sessionId.slice(-6)}</p>
                  <StatusBadge status={session.status} isActive={session.isActive} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
