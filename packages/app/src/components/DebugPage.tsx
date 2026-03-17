import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, RefreshCw, ChevronDown, ChevronRight, Terminal, FileText, Clock, Hash, X, List, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buildApiUrl } from '@/lib/server'
import type { SessionInfo, ChatMessage, DebugEvent } from '@codeclaws/shared'

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

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n... (truncated)'
}

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  switch (toolName) {
    case 'Read':
    case 'ReadFile':
    case 'Write':
    case 'WriteFile':
    case 'Edit':
    case 'EditFile':
      return String(obj.file_path || obj.path || '')
    case 'Bash':
    case 'bash':
      return String(obj.command || '')
    case 'Glob':
    case 'Grep':
      return String(obj.pattern || '')
    case 'ToolSearch':
      return String(obj.query || '')
    default: {
      // For unknown tools, show first string value as summary
      const firstStr = Object.values(obj).find((v) => typeof v === 'string')
      return firstStr ? String(firstStr).slice(0, 80) : ''
    }
  }
}

// Try to parse MCP-style JSON results like [{"type":"text","text":"..."}]
function formatToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result)
    if (Array.isArray(parsed)) {
      const texts = parsed
        .filter((item: any) => item?.type === 'text' && item?.text)
        .map((item: any) => item.text)
      if (texts.length > 0) return texts.join('\n')
    }
  } catch {
    // not JSON, return as-is
  }
  return result
}

// --- Tool Call View (inline in debug) ---
function ToolCallView({ toolCall, compact }: { toolCall: NonNullable<ChatMessage['toolCalls']>[number]; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeInput(toolCall.name, toolCall.input)

  return (
    <div className="border rounded-lg overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 ${compact ? 'py-1' : 'py-1.5'} bg-muted/50 hover:bg-muted transition-colors text-left`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          toolCall.result === undefined ? 'bg-amber-500 animate-pulse' :
          toolCall.isError ? 'bg-red-500' : 'bg-green-500'
        }`} />
        <span className="font-mono text-cyan-600 dark:text-cyan-400 shrink-0">{toolCall.name}</span>
        {summary && (
          <span className="text-muted-foreground truncate flex-1 font-mono text-[11px]">
            {summary}
          </span>
        )}
        <span className="text-muted-foreground shrink-0">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 space-y-2 bg-muted/30 max-h-[500px] overflow-y-auto">
          <div>
            <div className="text-muted-foreground/70 mb-0.5 font-medium text-[10px] uppercase tracking-wider">Input</div>
            <pre className="text-muted-foreground whitespace-pre-wrap break-all text-[11px] bg-background/50 rounded p-2">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {toolCall.result !== undefined && (
            <div>
              <div className="text-muted-foreground/70 mb-0.5 font-medium text-[10px] uppercase tracking-wider">Result</div>
              <pre className={`whitespace-pre-wrap break-all text-[11px] bg-background/50 rounded p-2 ${toolCall.isError ? 'text-red-500' : 'text-muted-foreground'}`}>
                {truncate(formatToolResult(toolCall.result), 5000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// --- Message Bubble for debug view ---
function DebugMessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-xs font-bold text-blue-600 dark:text-blue-400">U</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-blue-600 dark:text-blue-400">User</span>
            <span className="text-[10px] text-muted-foreground">{formatTimestamp(message.timestamp)}</span>
          </div>
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.name || `Image ${i + 1}`}
                  className="max-h-32 max-w-48 rounded-lg object-cover border"
                />
              ))}
            </div>
          )}
          <div className="text-sm whitespace-pre-wrap break-words bg-blue-500/5 rounded-lg px-3 py-2 border border-blue-500/10">
            {message.content}
          </div>
        </div>
      </div>
    )
  }

  if (message.role === 'system' && message.toolCalls?.length) {
    return (
      <div className="pl-10 space-y-1">
        {message.toolCalls.map((tc) => (
          <ToolCallView key={tc.id} toolCall={tc} />
        ))}
      </div>
    )
  }

  if (message.role === 'system') {
    if (!message.content && message.costUsd === undefined) return null
    return (
      <div className="text-xs text-muted-foreground text-center py-1">
        {message.content}
        {message.costUsd !== undefined && (
          <span className={message.content ? 'ml-2 text-muted-foreground/70' : 'text-muted-foreground/70'}>
            (${message.costUsd.toFixed(4)} | {((message.durationMs || 0) / 1000).toFixed(1)}s)
          </span>
        )}
      </div>
    )
  }

  // Assistant message — render thinking, tool calls, then content
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0
  const hasContent = !!message.content
  const hasThinking = !!message.thinking

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-violet-500/10 flex items-center justify-center shrink-0 mt-0.5">
        <span className="text-xs font-bold text-violet-600 dark:text-violet-400">A</span>
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-violet-600 dark:text-violet-400">Assistant</span>
          <span className="text-[10px] text-muted-foreground">{formatTimestamp(message.timestamp)}</span>
          {message.costUsd !== undefined && (
            <span className="text-[10px] text-muted-foreground/60">
              ${message.costUsd.toFixed(4)} | {((message.durationMs || 0) / 1000).toFixed(1)}s
            </span>
          )}
          {hasToolCalls && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 font-medium">
              {message.toolCalls!.length} tool call{message.toolCalls!.length > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Thinking */}
        {hasThinking && (
          <details>
            <summary className="text-xs text-amber-500/70 cursor-pointer hover:text-amber-500">
              Thinking...
            </summary>
            <div className="text-xs text-muted-foreground bg-amber-500/5 rounded-lg px-3 py-2 mt-1 border border-amber-500/10 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
              {message.thinking}
            </div>
          </details>
        )}

        {/* Tool calls */}
        {hasToolCalls && (
          <div className="space-y-1.5">
            {message.toolCalls!.map((tc) => (
              <ToolCallView key={tc.id} toolCall={tc} compact />
            ))}
          </div>
        )}

        {/* Content */}
        {hasContent && (
          <div className="text-sm whitespace-pre-wrap break-words bg-muted rounded-lg px-3 py-2">
            {message.content}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Debug Event Timeline ---
const EVENT_COLORS: Record<string, string> = {
  query_start: 'bg-blue-500',
  sdk_spawn: 'bg-blue-400',
  sdk_init: 'bg-indigo-500',
  thinking: 'bg-amber-500',
  tool_use: 'bg-cyan-500',
  tool_result: 'bg-cyan-400',
  text: 'bg-green-500',
  result: 'bg-emerald-500',
  error: 'bg-red-500',
  permission_request: 'bg-orange-500',
  permission_response: 'bg-orange-400',
  ask_question: 'bg-purple-500',
  usage: 'bg-neutral-400',
}

const EVENT_LABELS: Record<string, string> = {
  query_start: 'Query Start',
  sdk_spawn: 'SDK Spawn',
  sdk_init: 'SDK Init',
  thinking: 'Thinking',
  tool_use: 'Tool Use',
  tool_result: 'Tool Result',
  text: 'Text Output',
  result: 'Result',
  error: 'Error',
  permission_request: 'Permission',
  permission_response: 'Permission OK',
  ask_question: 'Question',
  usage: 'Usage',
}

function EventTimeline({ events }: { events: DebugEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        No debug events recorded for this session
      </div>
    )
  }

  const startTs = events[0].ts

  return (
    <div className="space-y-0">
      {events.map((event, i) => {
        const elapsed = event.ts - startTs
        const elapsedStr = elapsed < 1000 ? `+${elapsed}ms` : `+${(elapsed / 1000).toFixed(1)}s`
        const color = EVENT_COLORS[event.type] || 'bg-neutral-400'
        const label = EVENT_LABELS[event.type] || event.type

        return (
          <div key={i} className="flex items-start gap-3 group">
            {/* Timeline rail */}
            <div className="flex flex-col items-center shrink-0 w-16">
              <span className="text-[10px] font-mono text-muted-foreground/60 leading-5">{elapsedStr}</span>
            </div>
            <div className="flex flex-col items-center shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${color} shrink-0 mt-1.5`} />
              {i < events.length - 1 && <div className="w-px flex-1 bg-border min-h-3" />}
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0 pb-3">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${event.type === 'error' ? 'text-red-500' : 'text-foreground'}`}>
                  {label}
                </span>
                <span className="text-[10px] text-muted-foreground/50 font-mono">
                  {formatTimestamp(event.ts)}
                </span>
              </div>
              {event.detail && (
                <p className={`text-xs mt-0.5 font-mono break-all ${event.type === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}>
                  {event.detail}
                </p>
              )}
              {event.data && Object.keys(event.data).length > 0 && event.type !== 'usage' && (
                <details className="mt-1">
                  <summary className="text-[10px] text-muted-foreground/40 cursor-pointer hover:text-muted-foreground">
                    data
                  </summary>
                  <pre className="text-[10px] text-muted-foreground/60 mt-0.5 bg-muted/50 rounded p-1.5 break-all whitespace-pre-wrap">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- Session Detail Panel ---
type DetailTab = 'messages' | 'timeline'

function SessionDetail({
  session,
  onClose,
}: {
  session: SessionInfo
  onClose: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<DetailTab>('messages')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setMessages(null)
    setDebugEvents([])

    fetch(buildApiUrl(`/api/debug/sessions/${session.sessionId}/messages`))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled) {
          setMessages(data.messages)
          setDebugEvents(data.debugEvents || [])
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [session.sessionId])

  return (
    <div className="flex flex-col h-full">
      {/* Detail header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold truncate">
              {session.summary || session.firstPrompt || 'Untitled session'}
            </h2>
            <StatusBadge status={session.status} isActive={session.isActive} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Hash className="w-3 h-3" />
              <span className="font-mono">{session.sessionId}</span>
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTime(session.lastModified)}
            </span>
          </div>
          {session.cwd && (
            <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground/60">
              <Terminal className="w-3 h-3" />
              <span className="font-mono truncate">{session.cwd}</span>
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b shrink-0">
        <button
          onClick={() => setTab('messages')}
          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
            tab === 'messages'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Messages
          {messages && <span className="text-[10px] text-muted-foreground">({messages.length})</span>}
        </button>
        <button
          onClick={() => setTab('timeline')}
          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
            tab === 'timeline'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <List className="w-3.5 h-3.5" />
          Timeline
          {debugEvents.length > 0 && <span className="text-[10px] text-muted-foreground">({debugEvents.length})</span>}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && tab === 'messages' && (
          <div className="space-y-4">
            {messages && messages.length === 0 && (
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                No messages in this session
              </div>
            )}
            {messages?.map((msg) => (
              <DebugMessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}

        {!loading && !error && tab === 'timeline' && (
          <EventTimeline events={debugEvents} />
        )}
      </div>

      {/* Footer stats */}
      {messages && messages.length > 0 && tab === 'messages' && (
        <div className="flex items-center gap-4 px-4 py-2 border-t bg-muted/30 text-[11px] text-muted-foreground shrink-0">
          <span>{messages.length} messages</span>
          <span>
            {messages.filter((m) => m.role === 'user').length} user / {messages.filter((m) => m.role === 'assistant').length} assistant
          </span>
          {(() => {
            const totalCost = messages.reduce((sum, m) => sum + (m.costUsd || 0), 0)
            return totalCost > 0 ? <span>Total: ${totalCost.toFixed(4)}</span> : null
          })()}
        </div>
      )}
      {debugEvents.length > 0 && tab === 'timeline' && (
        <div className="flex items-center gap-4 px-4 py-2 border-t bg-muted/30 text-[11px] text-muted-foreground shrink-0">
          <span>{debugEvents.length} events</span>
          <span>
            {debugEvents.filter((e) => e.type === 'tool_use').length} tool calls
          </span>
          {(() => {
            const dur = debugEvents.length >= 2 ? debugEvents[debugEvents.length - 1].ts - debugEvents[0].ts : 0
            return dur > 0 ? <span>Duration: {(dur / 1000).toFixed(1)}s</span> : null
          })()}
        </div>
      )}
    </div>
  )
}

// --- Main Debug Page ---
export function DebugPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null)

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const res = await fetch(buildApiUrl('/api/debug/sessions'))
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
    <div className="h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold tracking-tight">Debug</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Stats inline */}
          <div className="hidden sm:flex items-center gap-3 text-xs">
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
          <Button variant="ghost" size="sm" onClick={() => fetchData(true)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </header>

      {/* Main content: split panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: project/session list */}
        <div className={`${selectedSession ? 'w-80 xl:w-96' : 'flex-1 max-w-3xl mx-auto'} border-r flex flex-col shrink-0 transition-all`}>
          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="m-3 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
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
                        {!selectedSession && group.project.path && (
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
                        {group.sessions.map((session) => {
                          const isSelected = selectedSession?.sessionId === session.sessionId
                          return (
                            <button
                              key={session.sessionId}
                              onClick={() => setSelectedSession(session)}
                              className={`w-full flex items-start gap-3 px-4 py-2.5 pl-11 border-b border-border/50 last:border-b-0 transition-colors text-left ${
                                isSelected
                                  ? 'bg-accent'
                                  : 'hover:bg-accent/30'
                              }`}
                            >
                              <StatusDot status={session.status} isActive={session.isActive} />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm truncate">
                                  {session.summary || session.firstPrompt || 'Untitled session'}
                                </p>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                  <span className="text-[11px] font-mono text-muted-foreground/50">
                                    {selectedSession ? session.sessionId.slice(-8) : session.sessionId}
                                  </span>
                                  <StatusBadge status={session.status} isActive={session.isActive} />
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[11px] text-muted-foreground">{timeAgo(session.lastModified, now)}</span>
                                  {!selectedSession && (
                                    <>
                                      <span className="text-muted-foreground/30">·</span>
                                      <span className="text-[11px] text-muted-foreground/60">{formatTime(session.lastModified)}</span>
                                    </>
                                  )}
                                </div>
                                {!selectedSession && session.cwd && (
                                  <p className="text-[11px] text-muted-foreground/40 font-mono truncate mt-0.5">{session.cwd}</p>
                                )}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Right panel: session detail */}
        {selectedSession ? (
          <div className="flex-1 min-w-0">
            <SessionDetail
              key={selectedSession.sessionId}
              session={selectedSession}
              onClose={() => setSelectedSession(null)}
            />
          </div>
        ) : (
          <div className="flex-1 hidden sm:flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Select a session to view messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
