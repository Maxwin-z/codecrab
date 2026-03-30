import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import { useStore } from '@/store/store'
import { selectThread } from '@/store/selectors'
import {
  fetchThreads,
  fetchThreadMessages,
  fetchArtifacts,
  fetchArtifactContent,
  getArtifactRawUrl,
  completeThread,
  updateThreadConfig,
  type ArtifactInfo,
  type ArtifactContent,
} from '@/lib/threads'
import { getToken } from '@/lib/auth'
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
  Settings2,
  X,
  Download,
  Image,
  Code,
  Eye,
  Loader2,
} from 'lucide-react'

const STATUS_CONFIG = {
  active: { label: 'Active', color: 'text-emerald-500', bg: 'bg-emerald-500/10', dot: 'bg-emerald-500' },
  completed: { label: 'Completed', color: 'text-blue-500', bg: 'bg-blue-500/10', dot: 'bg-blue-500' },
  stalled: { label: 'Stalled', color: 'text-amber-500', bg: 'bg-amber-500/10', dot: 'bg-amber-500' },
} as const

function StatusBadge({ status }: { status: ThreadInfo['status'] }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', cfg.bg, cfg.color)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot, status === 'active' && 'animate-pulse')} />
      {cfg.label}
    </span>
  )
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function mergeMessages(fetched: ThreadMessageInfo[], store: ThreadMessageInfo[]): ThreadMessageInfo[] {
  const map = new Map<string, ThreadMessageInfo>()
  for (const m of fetched) map.set(m.id, m)
  for (const m of store) map.set(m.id, m)
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/javascript' ||
    mime === 'application/xml'
  )
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/** Get a language hint from mimeType for syntax-style display */
function langFromMime(mime: string): string {
  const map: Record<string, string> = {
    'application/json': 'json',
    'application/javascript': 'javascript',
    'text/javascript': 'javascript',
    'text/html': 'html',
    'text/css': 'css',
    'text/markdown': 'markdown',
    'text/csv': 'csv',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/svg+xml': 'svg',
  }
  return map[mime] ?? 'plaintext'
}

// ── Artifact Content Viewer ──

function ArtifactViewer({
  artifact,
  threadId,
  onClose,
  onUnauthorized,
}: {
  artifact: ArtifactInfo
  threadId: string
  onClose: () => void
  onUnauthorized?: () => void
}) {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchArtifactContent(threadId, artifact.id, onUnauthorized)
      .then(data => {
        if (data) {
          setContent(data)
        } else {
          setError('Failed to load content')
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load content')
        setLoading(false)
      })
  }, [threadId, artifact.id, onUnauthorized])

  const rawUrl = getArtifactRawUrl(threadId, artifact.id)
  const token = getToken()
  const downloadUrl = token ? `${rawUrl}?token=${encodeURIComponent(token)}` : rawUrl

  return (
    <div className="flex flex-col h-full">
      {/* Viewer header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30 shrink-0">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate flex-1">{artifact.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">
          {artifact.mimeType} &middot; {formatBytes(artifact.size)}
        </span>
        <a
          href={downloadUrl}
          download={artifact.name}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center py-12 gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <AlertTriangle className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <a
              href={downloadUrl}
              download={artifact.name}
              className="text-xs text-blue-500 hover:underline"
            >
              Download file instead
            </a>
          </div>
        )}

        {!loading && !error && content && (
          <>
            {/* Image preview */}
            {isImageMime(artifact.mimeType) && (
              <div className="p-6 flex items-center justify-center bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
                <img
                  src={downloadUrl}
                  alt={artifact.name}
                  className="max-w-full max-h-[70vh] object-contain rounded shadow-sm"
                />
              </div>
            )}

            {/* Text / code content */}
            {isTextMime(artifact.mimeType) && (
              <div className="relative">
                <div className="absolute top-2 right-3 text-xs text-muted-foreground/60 select-none">
                  {langFromMime(artifact.mimeType)}
                </div>
                <pre className="p-4 text-sm leading-relaxed overflow-x-auto">
                  <code>{content.content}</code>
                </pre>
              </div>
            )}

            {/* SVG: both render preview and show source */}
            {artifact.mimeType === 'image/svg+xml' && (
              <div className="space-y-4">
                <div className="p-6 flex items-center justify-center border-b border-border bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
                  <div
                    className="max-w-full max-h-[40vh] overflow-auto"
                    dangerouslySetInnerHTML={{ __html: content.content }}
                  />
                </div>
                <div className="relative">
                  <div className="absolute top-2 right-3 text-xs text-muted-foreground/60 select-none">svg</div>
                  <pre className="p-4 text-sm leading-relaxed overflow-x-auto">
                    <code>{content.content}</code>
                  </pre>
                </div>
              </div>
            )}

            {/* PDF: link to open */}
            {artifact.mimeType === 'application/pdf' && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-sm font-medium">{artifact.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(artifact.size)}</p>
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Eye className="h-4 w-4" /> Open PDF
                </a>
              </div>
            )}

            {/* Fallback for unknown binary */}
            {!isTextMime(artifact.mimeType) &&
             !isImageMime(artifact.mimeType) &&
             artifact.mimeType !== 'image/svg+xml' &&
             artifact.mimeType !== 'application/pdf' && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-sm font-medium">{artifact.name}</p>
                <p className="text-xs text-muted-foreground">{artifact.mimeType} &middot; {formatBytes(artifact.size)}</p>
                <a
                  href={downloadUrl}
                  download={artifact.name}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Artifact List Item ──

function ArtifactListItem({
  artifact,
  isSelected,
  onClick,
}: {
  artifact: ArtifactInfo
  isSelected: boolean
  onClick: () => void
}) {
  const icon = isImageMime(artifact.mimeType)
    ? <Image className="h-4 w-4 text-muted-foreground shrink-0" />
    : isTextMime(artifact.mimeType) || artifact.mimeType === 'image/svg+xml'
      ? <Code className="h-4 w-4 text-muted-foreground shrink-0" />
      : <FileText className="h-4 w-4 text-muted-foreground shrink-0" />

  return (
    <button
      className={cn(
        'w-full flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer text-left',
        isSelected
          ? 'border-foreground/20 bg-accent/50'
          : 'border-border hover:bg-accent/30',
      )}
      onClick={onClick}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{artifact.name}</p>
        <p className="text-xs text-muted-foreground">
          {artifact.mimeType} &middot; {formatBytes(artifact.size)} &middot; by @{artifact.createdBy.agentName}
        </p>
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{formatTime(artifact.createdAt)}</span>
    </button>
  )
}

// ── Main Page ──

export function ThreadViewPage({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const threadId = searchParams.get('id')

  const storeThread = useStore(selectThread(threadId))
  const [restThread, setRestThread] = useState<ThreadInfo | null>(null)
  const [fetchedMessages, setFetchedMessages] = useState<ThreadMessageInfo[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'messages' | 'artifacts'>('messages')
  const [showConfig, setShowConfig] = useState(false)
  const [maxTurns, setMaxTurns] = useState('')
  const [viewingArtifact, setViewingArtifact] = useState<ArtifactInfo | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Load thread data from REST
  useEffect(() => {
    if (!threadId) return
    setLoading(true)
    setViewingArtifact(null)
    Promise.all([
      fetchThreads(undefined, onUnauthorized),
      fetchThreadMessages(threadId, 100, onUnauthorized),
      fetchArtifacts(threadId, onUnauthorized),
    ]).then(([threads, msgs, arts]) => {
      const found = threads.find(t => t.id === threadId) ?? null
      setRestThread(found)
      setFetchedMessages(msgs)
      setArtifacts(arts)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [threadId, onUnauthorized])

  // Use store thread if available (real-time), fallback to REST
  const thread = storeThread ?? restThread

  // Merge fetched + real-time store messages
  const storeMessages = storeThread?.messages ?? []
  const messages = mergeMessages(fetchedMessages, storeMessages)

  // Auto-scroll on new messages
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(isAtBottom)
  }, [])

  useEffect(() => {
    if (autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length, autoScroll])

  const handleComplete = async () => {
    if (!threadId) return
    await completeThread(threadId, onUnauthorized)
  }

  const handleUpdateConfig = async () => {
    if (!threadId) return
    const turns = parseInt(maxTurns, 10)
    if (!isNaN(turns) && turns > 0) {
      await updateThreadConfig(threadId, { maxTurns: turns }, onUnauthorized)
      setShowConfig(false)
      setMaxTurns('')
    }
  }

  // Click on artifact ref in a message → switch to artifacts tab and open viewer
  const handleArtifactRefClick = (artifactId: string) => {
    const found = artifacts.find(a => a.id === artifactId)
    if (found) {
      setTab('artifacts')
      setViewingArtifact(found)
    }
  }

  if (!threadId) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Select a thread from the sidebar</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Loading thread...</p>
      </div>
    )
  }

  if (!thread) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <MessageCircle className="h-10 w-10 text-muted-foreground" />
        <p className="text-muted-foreground">Thread not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/')}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Go back
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-4 py-3 space-y-2 shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-base font-semibold truncate flex-1">{thread.title}</h1>
          <StatusBadge status={thread.status} />
        </div>

        <div className="flex items-center gap-2 pl-11">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          {thread.participants.map(p => (
            <span key={p.agentId} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              @{p.agentName}
            </span>
          ))}
        </div>

        {thread.stalledReason && (
          <div className="flex items-start gap-1.5 pl-11 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {thread.stalledReason}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pl-11">
          {thread.status === 'active' && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleComplete}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Complete Thread
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowConfig(!showConfig)}
            title="Configure thread"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
          {showConfig && (
            <>
              <input
                type="number"
                min={1}
                placeholder="Max turns"
                value={maxTurns}
                onChange={e => setMaxTurns(e.target.value)}
                className="w-24 h-7 px-2 text-xs rounded border border-border bg-background"
              />
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleUpdateConfig}>
                Save
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowConfig(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        <button
          className={cn(
            'flex-1 py-2 text-sm font-medium text-center transition-colors cursor-pointer',
            tab === 'messages' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => { setTab('messages'); setViewingArtifact(null) }}
        >
          Messages ({messages.length})
        </button>
        <button
          className={cn(
            'flex-1 py-2 text-sm font-medium text-center transition-colors cursor-pointer',
            tab === 'artifacts' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('artifacts')}
        >
          Artifacts ({artifacts.length})
        </button>
      </div>

      {/* Content */}
      {tab === 'messages' && (
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto"
        >
          <div className="max-w-3xl mx-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-12 space-y-2">
                <MessageCircle className="h-10 w-10 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No messages yet</p>
                {thread.status === 'active' && (
                  <p className="text-xs text-muted-foreground">Messages will appear here in real-time</p>
                )}
              </div>
            )}

            {messages.map(msg => (
              <div key={msg.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-foreground">@{msg.from}</span>
                  <span className="text-xs text-muted-foreground">
                    {msg.to === 'broadcast' ? 'to all' : `to @${msg.to}`}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">{formatTime(msg.timestamp)}</span>
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
                {msg.artifacts.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {msg.artifacts.map(a => (
                      <button
                        key={a.id}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                        onClick={() => handleArtifactRefClick(a.id)}
                        title="View artifact"
                      >
                        <FileText className="h-3 w-3" />
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Live indicator for active threads */}
            {thread.status === 'active' && messages.length > 0 && (
              <div className="flex items-center gap-2 py-2 justify-center">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs text-muted-foreground">Listening for new messages...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {tab === 'artifacts' && !viewingArtifact && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 space-y-2">
            {artifacts.length === 0 && (
              <div className="text-center py-12 space-y-2">
                <FileText className="h-10 w-10 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No artifacts shared yet</p>
              </div>
            )}
            {artifacts.map(a => (
              <ArtifactListItem
                key={a.id}
                artifact={a}
                isSelected={false}
                onClick={() => setViewingArtifact(a)}
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'artifacts' && viewingArtifact && threadId && (
        <ArtifactViewer
          artifact={viewingArtifact}
          threadId={threadId}
          onClose={() => setViewingArtifact(null)}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  )
}
