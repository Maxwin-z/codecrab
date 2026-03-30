import { useState, useEffect, useCallback } from 'react'
import { useStore } from '@/store/store'
import { selectThreads, selectThread } from '@/store/selectors'
import { fetchThreads, fetchThreadMessages, fetchArtifacts, completeThread, updateThreadConfig, type ArtifactInfo } from '@/lib/threads'
import type { ThreadInfo, ThreadMessageInfo } from '@/store/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft,
  MessageCircle,
  CheckCircle2,
  AlertTriangle,
  Users,
  FileText,
  X,
  Settings2,
} from 'lucide-react'

const STATUS_CONFIG = {
  active: { label: 'Active', color: 'text-emerald-500', bg: 'bg-emerald-500/10', dot: 'bg-emerald-500' },
  completed: { label: 'Completed', color: 'text-blue-500', bg: 'bg-blue-500/10', dot: 'bg-blue-500' },
  stalled: { label: 'Stalled', color: 'text-amber-500', bg: 'bg-amber-500/10', dot: 'bg-amber-500' },
} as const

function StatusBadge({ status }: { status: ThreadInfo['status'] }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium', cfg.bg, cfg.color)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot, status === 'active' && 'animate-pulse')} />
      {cfg.label}
    </span>
  )
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Thread List ──

function ThreadList({
  onSelect,
  onUnauthorized,
}: {
  onSelect: (threadId: string) => void
  onUnauthorized?: () => void
}) {
  const storeThreads = useStore(selectThreads)
  const [restThreads, setRestThreads] = useState<ThreadInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'stalled'>('all')

  const loadThreads = useCallback(async () => {
    try {
      const threads = await fetchThreads(undefined, onUnauthorized)
      setRestThreads(threads)
    } catch { /* ignore */ }
    setLoading(false)
  }, [onUnauthorized])

  useEffect(() => { loadThreads() }, [loadThreads])

  // Merge REST threads with real-time store threads (store wins on conflict)
  const merged = mergeThreads(restThreads, storeThreads)
  const filtered = filter === 'all' ? merged : merged.filter(t => t.status === filter)

  const groups = {
    active: filtered.filter(t => t.status === 'active'),
    stalled: filtered.filter(t => t.status === 'stalled'),
    completed: filtered.filter(t => t.status === 'completed'),
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter tabs */}
      <div className="flex gap-1 p-2 border-b border-border">
        {(['all', 'active', 'completed', 'stalled'] as const).map(f => (
          <button
            key={f}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors cursor-pointer',
              filter === f ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
            )}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : STATUS_CONFIG[f].label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-xs text-muted-foreground text-center py-4">Loading...</p>}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-8 space-y-2">
            <MessageCircle className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No threads yet</p>
          </div>
        )}

        {Object.entries(groups).map(([status, threads]) => {
          if (threads.length === 0) return null
          return (
            <div key={status}>
              {filter === 'all' && (
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
                  {STATUS_CONFIG[status as keyof typeof STATUS_CONFIG].label} ({threads.length})
                </div>
              )}
              {threads.map(thread => (
                <button
                  key={thread.id}
                  className="w-full text-left px-3 py-2.5 border-b border-border/50 hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => onSelect(thread.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium truncate flex-1">{thread.title}</p>
                    <StatusBadge status={thread.status} />
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="h-3 w-3" />
                      {thread.participants.length}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTime(thread.updatedAt)}
                    </span>
                  </div>
                  {thread.participants.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {thread.participants.map(p => (
                        <span key={p.agentId} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          @{p.agentName}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Thread Detail ──

function ThreadDetail({
  threadId,
  onBack,
  onUnauthorized,
}: {
  threadId: string
  onBack: () => void
  onUnauthorized?: () => void
}) {
  const thread = useStore(selectThread(threadId))
  const [messages, setMessages] = useState<ThreadMessageInfo[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [tab, setTab] = useState<'messages' | 'artifacts'>('messages')
  const [showConfig, setShowConfig] = useState(false)
  const [maxTurns, setMaxTurns] = useState('')

  useEffect(() => {
    fetchThreadMessages(threadId, 100, onUnauthorized).then(setMessages).catch(() => {})
    fetchArtifacts(threadId, onUnauthorized).then(setArtifacts).catch(() => {})
  }, [threadId, onUnauthorized])

  // Merge fetched messages with real-time store messages
  const storeMessages = thread?.messages ?? []
  const mergedMessages = mergeMessages(messages, storeMessages)

  const handleComplete = async () => {
    await completeThread(threadId, onUnauthorized)
  }

  const handleUpdateConfig = async () => {
    const turns = parseInt(maxTurns, 10)
    if (!isNaN(turns) && turns > 0) {
      await updateThreadConfig(threadId, { maxTurns: turns }, onUnauthorized)
      setShowConfig(false)
      setMaxTurns('')
    }
  }

  if (!thread) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b border-border">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center py-4">Thread not found</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <p className="text-sm font-medium truncate flex-1">{thread.title}</p>
          <StatusBadge status={thread.status} />
        </div>
        <div className="flex items-center gap-2 pl-9">
          {thread.participants.map(p => (
            <span key={p.agentId} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              @{p.agentName}
            </span>
          ))}
        </div>
        {thread.stalledReason && (
          <div className="flex items-start gap-1.5 pl-9 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {thread.stalledReason}
          </div>
        )}
        {/* Actions */}
        <div className="flex items-center gap-2 pl-9">
          {thread.status === 'active' && (
            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={handleComplete}>
              <CheckCircle2 className="h-3 w-3 mr-1" /> Complete
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowConfig(!showConfig)}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        {showConfig && (
          <div className="flex items-center gap-2 pl-9">
            <input
              type="number"
              min={1}
              placeholder="Max turns"
              value={maxTurns}
              onChange={e => setMaxTurns(e.target.value)}
              className="w-24 h-6 px-2 text-xs rounded border border-border bg-background"
            />
            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={handleUpdateConfig}>
              Save
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowConfig(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          className={cn(
            'flex-1 py-1.5 text-xs font-medium text-center transition-colors cursor-pointer',
            tab === 'messages' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('messages')}
        >
          Messages ({mergedMessages.length})
        </button>
        <button
          className={cn(
            'flex-1 py-1.5 text-xs font-medium text-center transition-colors cursor-pointer',
            tab === 'artifacts' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('artifacts')}
        >
          Artifacts ({artifacts.length})
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'messages' && (
          <div className="p-2 space-y-2">
            {mergedMessages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No messages yet</p>
            )}
            {mergedMessages.map(msg => (
              <div key={msg.id} className="rounded-lg border border-border p-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-foreground">@{msg.from}</span>
                  <span className="text-xs text-muted-foreground">
                    {msg.to === 'broadcast' ? 'to all' : `to @${msg.to}`}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">{formatTime(msg.timestamp)}</span>
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap break-words">{msg.content}</p>
                {msg.artifacts.length > 0 && (
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {msg.artifacts.map(a => (
                      <span key={a.id} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        <FileText className="h-3 w-3" />
                        {a.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {tab === 'artifacts' && (
          <div className="p-2 space-y-1.5">
            {artifacts.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No artifacts</p>
            )}
            {artifacts.map(a => (
              <div key={a.id} className="flex items-center gap-2 px-2.5 py-2 rounded border border-border">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.mimeType} &middot; {formatBytes(a.size)} &middot; by @{a.createdBy.agentName}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{formatTime(a.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Panel ──

export function ThreadPanel({ onClose, onUnauthorized }: { onClose: () => void; onUnauthorized?: () => void }) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)

  return (
    <div className="w-80 border-r border-border bg-card flex flex-col h-full shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-medium">Threads</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {selectedThreadId ? (
        <ThreadDetail
          threadId={selectedThreadId}
          onBack={() => setSelectedThreadId(null)}
          onUnauthorized={onUnauthorized}
        />
      ) : (
        <ThreadList onSelect={setSelectedThreadId} onUnauthorized={onUnauthorized} />
      )}
    </div>
  )
}

// ── Helpers ──

function mergeThreads(rest: ThreadInfo[], store: ThreadInfo[]): ThreadInfo[] {
  const map = new Map<string, ThreadInfo>()
  for (const t of rest) map.set(t.id, t)
  for (const t of store) map.set(t.id, t) // store wins
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

function mergeMessages(fetched: ThreadMessageInfo[], store: ThreadMessageInfo[]): ThreadMessageInfo[] {
  const map = new Map<string, ThreadMessageInfo>()
  for (const m of fetched) map.set(m.id, m)
  for (const m of store) map.set(m.id, m)
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
