// MessageList — renders chat messages with optional SDK event timeline
import { useState, useMemo } from 'react'
import type { ChatMessage, DebugEvent } from '@codeclaws/shared'

interface MessageListProps {
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  isRunning: boolean
  sdkEvents?: DebugEvent[]
  onResumeSession?: (sessionId: string) => void
}

// Turn group: user message + associated agent events
interface TurnGroup {
  id: string
  userMessage?: ChatMessage
  agentEvents: DebugEvent[]
}

export function MessageList({ messages, streamingText, streamingThinking, isRunning, sdkEvents = [], onResumeSession }: MessageListProps) {
  const hasSdkEvents = sdkEvents.length > 0

  // Build turn groups when sdkEvents are available (mirrors iOS turnGroups)
  const turnGroups = useMemo((): TurnGroup[] => {
    if (!hasSdkEvents) return []

    const sortedUserMsgs = messages
      .filter((m) => m.role === 'user')
      .sort((a, b) => a.timestamp - b.timestamp)

    const groups: TurnGroup[] = []

    // Events before the first user message (e.g. from session resume)
    if (sortedUserMsgs.length > 0) {
      const firstTs = sortedUserMsgs[0].timestamp
      const earlyEvents = sdkEvents.filter((e) => e.ts < firstTs).sort((a, b) => a.ts - b.ts)
      if (earlyEvents.length > 0) {
        groups.push({ id: 'turn-pre', userMessage: undefined, agentEvents: earlyEvents })
      }
    }

    for (let i = 0; i < sortedUserMsgs.length; i++) {
      const userMsg = sortedUserMsgs[i]
      const nextTs = i + 1 < sortedUserMsgs.length ? sortedUserMsgs[i + 1].timestamp : Infinity
      const events = sdkEvents
        .filter((e) => e.ts >= userMsg.timestamp && e.ts < nextTs)
        .sort((a, b) => a.ts - b.ts)
      groups.push({ id: `turn-${userMsg.id}`, userMessage: userMsg, agentEvents: events })
    }

    // No user messages but have SDK events
    if (sortedUserMsgs.length === 0) {
      groups.push({ id: 'turn-all', userMessage: undefined, agentEvents: [...sdkEvents].sort((a, b) => a.ts - b.ts) })
    }

    return groups
  }, [messages, sdkEvents, hasSdkEvents])

  // SDK events mode: turn-based rendering
  if (hasSdkEvents || (isRunning && messages.some(m => m.role === 'user'))) {
    return (
      <div className="space-y-1 min-w-0 overflow-x-hidden">
        {hasSdkEvents ? (
          <>
            {turnGroups.map((group, index) => (
              <div key={group.id}>
                {group.userMessage && (
                  <div className="py-1.5">
                    <MessageBubble message={group.userMessage} />
                  </div>
                )}
                {group.agentEvents.length > 0 && (
                  <AgentResponseView
                    events={group.agentEvents}
                    isStreaming={isRunning && index === turnGroups.length - 1}
                    onResumeSession={onResumeSession}
                  />
                )}
              </div>
            ))}

            {/* Running indicator when no SDK events are flowing yet */}
            {isRunning && sdkEvents.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                Processing...
              </div>
            )}
          </>
        ) : (
          // Fallback: show messages linearly when no sdkEvents yet
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {streamingThinking && (
              <div className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2 border max-w-full">
                <span className="text-amber-500 font-medium">Thinking: </span>
                <span className="whitespace-pre-wrap break-all">{streamingThinking}</span>
              </div>
            )}
            {streamingText && (
              <div className="bg-muted rounded-lg px-3 py-2 max-w-full">
                <div className="text-sm whitespace-pre-wrap">{streamingText}</div>
              </div>
            )}
            {isRunning && !streamingText && !streamingThinking && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                Processing...
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // Legacy mode: linear message rendering (no sdkEvents)
  return (
    <div className="space-y-4 min-w-0 overflow-x-hidden">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Streaming thinking */}
      {streamingThinking && (
        <div className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2 border max-w-full">
          <span className="text-amber-500 font-medium">Thinking: </span>
          <span className="whitespace-pre-wrap break-all">{streamingThinking}</span>
        </div>
      )}

      {/* Streaming text */}
      {streamingText && (
        <div className="bg-muted rounded-lg px-3 py-2 max-w-full">
          <div className="text-sm whitespace-pre-wrap">{streamingText}</div>
        </div>
      )}

      {/* Running indicator */}
      {isRunning && !streamingText && !streamingThinking && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-block w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          Processing...
        </div>
      )}
    </div>
  )
}

// ─── Agent Response View (with message/debug toggle) ────────────────────

const MESSAGE_TYPES = new Set(['thinking', 'text', 'tool_use', 'tool_result', 'cron_task_completed'])

function AgentResponseView({
  events,
  isStreaming,
  onResumeSession,
}: {
  events: DebugEvent[]
  isStreaming: boolean
  onResumeSession?: (sessionId: string) => void
}) {
  const [showDebug, setShowDebug] = useState(false)

  const messageEvents = useMemo(
    () =>
      events.filter((e) => {
        if (MESSAGE_TYPES.has(e.type)) return true
        // Include result events with execSessionId (cron task results from history)
        if (e.type === 'result' && e.data && typeof e.data.execSessionId === 'string') return true
        return false
      }),
    [events]
  )

  return (
    <div className={`space-y-${showDebug ? '0.5' : '1'}`}>
      {showDebug ? (
        events.map((event, i) => <SdkEventInline key={i} event={event} />)
      ) : (
        messageEvents.map((event, i) => {
          if (event.type === 'cron_task_completed') {
            return <CronTaskCompletedView key={i} event={event} onResumeSession={onResumeSession} />
          }
          if (event.type === 'result' && event.data && typeof event.data.execSessionId === 'string') {
            return <CronResultView key={i} event={event} onResumeSession={onResumeSession} />
          }
          return <MessageModeEventView key={i} event={event} isStreaming={isStreaming} />
        })
      )}

      {/* Toggle button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowDebug(!showDebug)}
          className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${
            showDebug
              ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
              : 'text-muted-foreground bg-muted/50'
          } hover:opacity-80 transition-opacity`}
        >
          <span>{showDebug ? '🐛' : '💬'}</span>
          <span>{showDebug ? 'Debug' : 'Message'}</span>
        </button>
      </div>
    </div>
  )
}

// ─── Message Mode Views ─────────────────────────────────────────────────

function MessageModeEventView({ event, isStreaming }: { event: DebugEvent; isStreaming: boolean }) {
  switch (event.type) {
    case 'text':
      return <MessageModeText event={event} />
    case 'thinking':
      return <MessageModeThinking event={event} defaultExpanded={isStreaming} />
    case 'tool_use':
      return <MessageModeToolUse event={event} defaultExpanded={isStreaming} />
    case 'tool_result':
      return <MessageModeToolResult event={event} defaultExpanded={isStreaming} />
    default:
      return null
  }
}

function MessageModeText({ event }: { event: DebugEvent }) {
  const content = (event.data?.content as string) || ''
  if (!content) return null
  return (
    <div className="text-sm font-mono whitespace-pre-wrap break-words">
      {content}
    </div>
  )
}

function MessageModeThinking({ event, defaultExpanded }: { event: DebugEvent; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const content = (event.data?.content as string) || ''
  if (!content) return null

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-amber-500/70 hover:text-amber-500"
      >
        <span className="text-[10px]">{expanded ? '▼' : '▶'}</span>
        <span className="font-mono">Thinking</span>
      </button>
      {expanded && (
        <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap break-all mt-1 pl-4">
          {content}
        </div>
      )}
    </div>
  )
}

function MessageModeToolUse({ event, defaultExpanded }: { event: DebugEvent; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const toolName = (event.data?.toolName as string) || 'unknown'
  const input = (event.data?.input as string) || ''
  const summary = input.split('\n')[0]?.slice(0, 60) || ''

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-left"
      >
        <span className="text-[10px] text-muted-foreground">{expanded ? '▼' : '▶'}</span>
        <span className="font-mono font-medium text-cyan-600 dark:text-cyan-400">{toolName}</span>
        {!expanded && summary && (
          <span className="font-mono text-muted-foreground truncate max-w-[200px]">{summary}</span>
        )}
      </button>
      {expanded && input && (
        <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all mt-1 pl-4">
          {input}
        </pre>
      )}
    </div>
  )
}

function MessageModeToolResult({ event, defaultExpanded }: { event: DebugEvent; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const content = (event.data?.content as string) || ''
  const isError = !!(event.data?.isError)
  const charCount = (event.data?.length as number) || content.length
  if (!content) return null

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs"
      >
        <span className="text-[10px] text-muted-foreground">{expanded ? '▼' : '▶'}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${isError ? 'bg-red-500' : 'bg-green-500'}`} />
        <span className="font-mono text-muted-foreground">Result</span>
        <span className="font-mono text-muted-foreground/70">{charCount} chars</span>
      </button>
      {expanded && (
        <pre className={`text-[11px] font-mono whitespace-pre-wrap break-all mt-1 pl-4 ${isError ? 'text-red-500' : 'text-muted-foreground'}`}>
          {content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content}
        </pre>
      )}
    </div>
  )
}

// ─── Cron Views ─────────────────────────────────────────────────────────

function CronTaskCompletedView({ event, onResumeSession }: { event: DebugEvent; onResumeSession?: (sid: string) => void }) {
  const cronJobName = (event.data?.cronJobName as string) || (event.data?.cronJobId as string) || 'Task'
  const execSessionId = (event.data?.execSessionId as string) || ''
  const success = !!(event.data?.success)

  return (
    <div className={`rounded-lg border p-2.5 ${success ? 'border-green-500/30' : 'border-red-500/30'} bg-muted/30`}>
      <div className="flex items-center gap-1.5 text-xs">
        <span>{success ? '✅' : '❌'}</span>
        <span className="font-mono font-medium">Scheduled Task: {cronJobName}</span>
      </div>
      {execSessionId && onResumeSession && (
        <button
          onClick={() => onResumeSession(execSessionId)}
          className="mt-2 flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-600 font-mono bg-blue-500/5 rounded px-2.5 py-1.5 w-full"
        >
          <span>→</span>
          <span>View Execution Details</span>
          <span className="ml-auto">›</span>
        </button>
      )}
    </div>
  )
}

function CronResultView({ event, onResumeSession }: { event: DebugEvent; onResumeSession?: (sid: string) => void }) {
  const execSessionId = (event.data?.execSessionId as string) || ''
  const isError = !!(event.data?.isError)
  const costUsd = event.data?.costUsd as number | undefined

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span>{isError ? '❌' : '✅'}</span>
        <span className="font-mono text-muted-foreground">{event.detail || (isError ? 'Failed' : 'Completed')}</span>
        {costUsd !== undefined && (
          <span className="font-mono text-muted-foreground/70">${costUsd.toFixed(4)}</span>
        )}
      </div>
      {execSessionId && onResumeSession && (
        <button
          onClick={() => onResumeSession(execSessionId)}
          className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-600 font-mono bg-blue-500/5 rounded px-2.5 py-1.5 w-full"
        >
          <span>→</span>
          <span>View Execution Details</span>
          <span className="ml-auto">›</span>
        </button>
      )}
    </div>
  )
}

// ─── Debug Mode: SDK Event Inline View ──────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  query_start: '▶', sdk_init: '⚡', sdk_spawn: '⚡',
  thinking: '💭', text: '📝', tool_use: '🔧', tool_result: '◀',
  result: '✅', error: '❌', permission_request: '🔐',
  usage: '📊', message_start: '▶', message_done: '■',
  content_block_start: '▷', content_block_stop: '◁',
  rate_limit: '⏱', assistant: '◀', cron_task_completed: '📋',
}

const EVENT_COLORS: Record<string, string> = {
  query_start: 'text-blue-500',
  sdk_init: 'text-purple-500', sdk_spawn: 'text-purple-500',
  thinking: 'text-amber-500', text: 'text-green-600 dark:text-green-400',
  tool_use: 'text-cyan-600 dark:text-cyan-400',
  tool_result: 'text-emerald-600 dark:text-emerald-400',
  result: 'text-green-500', error: 'text-red-500',
  permission_request: 'text-yellow-600',
  usage: 'text-indigo-500',
  message_start: 'text-blue-500', message_done: 'text-blue-500',
  rate_limit: 'text-yellow-600',
  cron_task_completed: 'text-blue-500',
}

function getEventInlineInfo(event: DebugEvent): string {
  const data = event.data
  if (!data) return event.detail || ''

  switch (event.type) {
    case 'tool_use': {
      const name = data.toolName as string || ''
      const tid = data.toolId as string || ''
      return tid ? `${name}  id=${tid.slice(-8)}` : name
    }
    case 'tool_result': {
      const parts: string[] = []
      if (data.isError) parts.push('ERROR')
      if (data.toolUseId) parts.push(`tool_use_id=${String(data.toolUseId).slice(-8)}`)
      if (data.length) parts.push(`${data.length} chars`)
      return parts.join('  ')
    }
    case 'text':
    case 'thinking':
      return data.length ? `${data.length} chars` : ''
    case 'result': {
      const parts: string[] = []
      if (data.subtype) parts.push(String(data.subtype))
      if (data.costUsd != null) parts.push(`$${Number(data.costUsd).toFixed(4)}`)
      if (data.durationMs != null) parts.push(`${(Number(data.durationMs) / 1000).toFixed(1)}s`)
      if (data.isError) parts.push('ERROR')
      return parts.join(' · ')
    }
    case 'sdk_init':
      return (data.model as string) || ''
    default:
      return event.detail || ''
  }
}

function SdkEventInline({ event }: { event: DebugEvent }) {
  const [expanded, setExpanded] = useState(true)
  const icon = EVENT_ICONS[event.type] || '·'
  const color = EVENT_COLORS[event.type] || 'text-muted-foreground'
  const info = getEventInlineInfo(event)

  // Check for expandable content
  const fullContent = (() => {
    if (!event.data) return null
    switch (event.type) {
      case 'text':
      case 'thinking':
        return (event.data.content as string) || null
      case 'tool_use':
        return (event.data.input as string) || null
      case 'tool_result':
        return (event.data.content as string) || null
      default:
        return null
    }
  })()

  return (
    <div className="text-[10px] font-mono leading-relaxed px-2.5 py-0.5 rounded bg-muted/30 hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-0">
        <span className="w-4 text-center shrink-0">{icon}</span>
        <span className={`font-semibold ${color}`}>{event.type}</span>
        {info && <span className="text-muted-foreground ml-2 truncate">{info}</span>}
        <span className="flex-1" />
        {fullContent && (
          <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground/50 hover:text-muted-foreground">
            {expanded ? '▼' : '▶'}
          </button>
        )}
      </div>
      {expanded && fullContent && (
        <div className="pl-4 mt-0.5 whitespace-pre-wrap break-all text-muted-foreground">
          {fullContent.length > 2000 ? fullContent.slice(0, 2000) + '\n... (truncated)' : fullContent}
        </div>
      )}
    </div>
  )
}

// ─── Message Bubble (for user/system/assistant messages) ────────────────

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end min-w-0">
        <div className="flex flex-col items-end gap-1">
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2 max-w-[85%] text-sm">
            {message.images && message.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name || `Image ${i + 1}`}
                    className="max-h-32 max-w-48 rounded-lg object-cover"
                  />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-all">{message.content}</div>
          </div>
          <span className="text-[10px] text-muted-foreground px-1">{formatTimestamp(message.timestamp)}</span>
        </div>
      </div>
    )
  }

  if (message.role === 'system' && message.toolCalls?.length) {
    return (
      <div className="space-y-1">
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
          <span className={message.content ? "ml-2 text-muted-foreground/70" : "text-muted-foreground/70"}>
            (${message.costUsd.toFixed(4)} | {((message.durationMs || 0) / 1000).toFixed(1)}s)
          </span>
        )}
      </div>
    )
  }

  // Assistant message
  return (
    <div className="max-w-[95%] min-w-0">
      {message.thinking && (
        <details className="mb-1">
          <summary className="text-xs text-amber-500/70 cursor-pointer hover:text-amber-500">
            Thinking...
          </summary>
          <div className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2 mt-1 border whitespace-pre-wrap break-all">
            {message.thinking}
          </div>
        </details>
      )}
      {message.content && (
        <div className="bg-muted rounded-lg px-4 py-2 min-w-0">
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        </div>
      )}
      <span className="text-[10px] text-muted-foreground px-1 mt-1 block">{formatTimestamp(message.timestamp)}</span>
    </div>
  )
}

function ToolCallView({ toolCall }: { toolCall: NonNullable<ChatMessage['toolCalls']>[number] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border rounded-lg overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/50 hover:bg-muted transition-colors text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${
          toolCall.result === undefined ? "bg-amber-500 animate-pulse" :
          toolCall.isError ? "bg-red-500" : "bg-green-500"
        }`} />
        <span className="font-mono text-cyan-600 dark:text-cyan-400">{toolCall.name}</span>
        <span className="text-muted-foreground truncate flex-1">
          {summarizeInput(toolCall.name, toolCall.input)}
        </span>
        <span className="text-muted-foreground">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 space-y-2 bg-muted/30">
          <div>
            <div className="text-muted-foreground mb-0.5">Input:</div>
            <pre className="text-muted-foreground whitespace-pre-wrap break-all">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {toolCall.result !== undefined && (
            <div>
              <div className="text-muted-foreground mb-0.5">Result:</div>
              <pre className={`whitespace-pre-wrap break-all ${toolCall.isError ? "text-red-500" : "text-muted-foreground"}`}>
                {truncate(toolCall.result, 2000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>

  switch (toolName) {
    case 'Read':
    case 'ReadFile':
      return String(obj.file_path || obj.path || '')
    case 'Write':
    case 'WriteFile':
      return String(obj.file_path || obj.path || '')
    case 'Edit':
    case 'EditFile':
      return String(obj.file_path || obj.path || '')
    case 'Bash':
    case 'bash':
      return String(obj.command || '')
    case 'Glob':
    case 'Grep':
      return String(obj.pattern || '')
    default:
      return ''
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n... (truncated)'
}
