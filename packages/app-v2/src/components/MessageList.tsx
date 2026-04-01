import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { stripMetaTags } from '@/lib/utils'
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  AlertCircle,
  Bot,
} from 'lucide-react'
import type { ChatMsg, ContentBlock } from '@/store/types'

/**
 * Group consecutive assistant messages into one message with ordered blocks.
 * In a single query, the Claude SDK makes multiple API rounds (tool loop).
 * Each round produces a separate assistant message in history.
 * This function merges them so one query = one card.
 */
export function groupAssistantMessages(messages: ChatMsg[]): ChatMsg[] {
  const result: ChatMsg[] = []
  let group: ChatMsg | null = null

  function flushGroup() {
    if (group) {
      result.push(group)
      group = null
    }
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (!group) {
        group = {
          ...msg,
          blocks: [],
        }
      }
      // Convert this message's fields into ordered blocks:
      // SDK order within one API response: thinking → text → tool_uses
      if (msg.thinking) {
        group.blocks!.push({ type: 'thinking', thinking: msg.thinking })
      }
      if (msg.content) {
        group.blocks!.push({ type: 'text', content: msg.content })
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          group.blocks!.push({ type: 'tool', name: tc.name, id: tc.id, input: tc.input, result: tc.result, isError: tc.isError })
        }
      }
      // Also merge blocks if the source message already has them
      if (msg.blocks) {
        for (const b of msg.blocks) {
          group.blocks!.push(b)
        }
      }
    } else {
      flushGroup()
      result.push(msg)
    }
  }
  flushGroup()
  return result
}

interface ToolLike {
  name: string
  id: string
  input: unknown
  result?: string
  isError?: boolean
}

function getToolSummary(tc: ToolLike): string {
  const input = tc.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return ''

  switch (tc.name) {
    case 'Agent':
      return String(input.description ?? '')
    case 'Bash': {
      const cmd = String(input.command ?? '')
      return cmd.length > 60 ? '…' + cmd.slice(-60) : cmd
    }
    case 'ToolSearch':
      return String(input.query ?? '')
    case 'Read': {
      const fp = String(input.file_path ?? '')
      return fp.length > 60 ? '…' + fp.slice(-60) : fp
    }
    case 'WebSearch':
      return String(input.query ?? '')
    case 'WebFetch':
      return String(input.url ?? '')
    case 'Grep':
      return String(input.pattern ?? '')
    case 'Glob':
      return String(input.pattern ?? '')
    case 'Edit': {
      const fp = String(input.file_path ?? '')
      return fp.length > 60 ? '…' + fp.slice(-60) : fp
    }
    case 'Write': {
      const fp = String(input.file_path ?? '')
      return fp.length > 60 ? '…' + fp.slice(-60) : fp
    }
    default:
      return ''
  }
}

function ToolCallBlock({ tc }: { tc: ToolLike }) {
  const [expanded, setExpanded] = useState(false)
  const inputStr = typeof tc.input === 'string'
    ? tc.input
    : JSON.stringify(tc.input, null, 2)
  const summary = getToolSummary(tc)

  return (
    <div className="my-1 border border-border/50 rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent/30 transition-colors cursor-pointer min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <code className="font-medium shrink-0">{tc.name}</code>
        {summary && (
          <span className="text-muted-foreground truncate min-w-0">{summary}</span>
        )}
        {tc.isError && <AlertCircle className="h-3 w-3 text-destructive ml-auto shrink-0" />}
        {tc.result !== undefined && !tc.isError && (
          <span className="text-green-500 ml-auto text-[10px] shrink-0">done</span>
        )}
      </button>

      {expanded && (
        <div className="px-2 py-1.5 border-t border-border/50 space-y-1">
          <div>
            <span className="text-[10px] text-muted-foreground uppercase">Input</span>
            <pre className="text-xs bg-muted/30 rounded p-1.5 overflow-x-auto max-h-32">
              {inputStr.length > 1000 ? inputStr.slice(0, 1000) + '...' : inputStr}
            </pre>
          </div>
          {tc.result !== undefined && (
            <div>
              <span className="text-[10px] text-muted-foreground uppercase">
                {tc.isError ? 'Error' : 'Result'}
              </span>
              <pre className={cn(
                'text-xs rounded p-1.5 overflow-x-auto max-h-32',
                tc.isError ? 'bg-destructive/10 text-destructive' : 'bg-muted/30',
              )}>
                {(tc.result?.length ?? 0) > 1000 ? tc.result!.slice(0, 1000) + '...' : tc.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="my-1">
      <button
        className="w-full flex items-center gap-1.5 text-xs text-amber-500/80 hover:text-amber-500 transition-colors cursor-pointer min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Brain className="h-3 w-3 shrink-0" />
        <span className="shrink-0">Thinking</span>
        {!expanded && thinking && (
          <span className="text-muted-foreground truncate min-w-0">{thinking.slice(0, 100)}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-5 text-xs text-muted-foreground bg-amber-500/5 border border-amber-500/10 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap">
          {thinking}
        </div>
      )}
    </div>
  )
}

function TextBlock({ content }: { content: string }) {
  return (
    <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {stripMetaTags(content)}
      </ReactMarkdown>
    </div>
  )
}

function renderBlock(block: ContentBlock, index: number) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock key={`t-${index}`} thinking={block.thinking} />
    case 'text':
      return <TextBlock key={`x-${index}`} content={block.content} />
    case 'tool':
      return <ToolCallBlock key={block.id} tc={block} />
    default:
      return null
  }
}

function MessageBubble({ msg }: { msg: ChatMsg }) {
  if (msg.role === 'system') {
    return (
      <div className="flex justify-center my-2">
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-full px-3 py-1 max-w-md text-center">
          {msg.content}
        </div>
      </div>
    )
  }

  const isUser = msg.role === 'user'
  const hasBlocks = msg.blocks && msg.blocks.length > 0

  // Skip empty assistant messages (e.g. just created by query_start, no blocks yet)
  if (msg.role === 'assistant' && !hasBlocks && !msg.content && !msg.thinking && (!msg.toolCalls || msg.toolCalls.length === 0)) {
    return null
  }

  return (
    <div className={cn('flex gap-2 my-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="h-4 w-4 text-muted-foreground" />
        </div>
      )}

      <div className={cn(
        'max-w-[80%] rounded-lg px-3 py-2',
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted/50',
      )}>
        {/* Images */}
        {msg.images && msg.images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {msg.images.map((img, i) => (
              <img
                key={i}
                src={img.url || `data:${img.mediaType};base64,${img.data}`}
                alt={img.name || 'image'}
                className="max-h-40 rounded-md"
              />
            ))}
          </div>
        )}

        {hasBlocks ? (
          /* Render ordered blocks (new path) */
          msg.blocks!.map((block, i) => renderBlock(block, i))
        ) : (
          /* Legacy fallback: thinking → content → toolCalls */
          <>
            {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}

            {msg.content && (
              <div className={cn(
                'text-sm',
                !isUser && 'prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground',
              )}>
                {isUser ? (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {stripMetaTags(msg.content)}
                  </ReactMarkdown>
                )}
              </div>
            )}

            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div className="mt-1">
                {msg.toolCalls.map(tc => (
                  <ToolCallBlock key={tc.id} tc={tc} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StreamingIndicator({
  streamingText,
  streamingThinking,
}: {
  streamingText: string
  streamingThinking: string
}) {
  const hasContent = streamingText || streamingThinking
  const thinkingRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (thinkingRef.current) {
      thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight
    }
  }, [streamingThinking])

  return (
    <div className="flex gap-2 my-3 justify-start">
      <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 bg-muted/50">
        {streamingThinking && (
          <div className="my-1">
            <div className="flex items-center gap-1.5 text-xs text-amber-500/80">
              <Brain className="h-3 w-3" />
              <span>Thinking…</span>
            </div>
            <div ref={thinkingRef} className="mt-1 ml-5 text-xs text-muted-foreground bg-amber-500/5 border border-amber-500/10 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap">
              {streamingThinking}
            </div>
          </div>
        )}

        {streamingText ? (
          <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {stripMetaTags(streamingText)}
            </ReactMarkdown>
          </div>
        ) : !hasContent ? (
          <div className="streaming-dots flex gap-1 py-1">
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function MessageList({
  messages,
  isStreaming,
  streamingText,
  streamingThinking,
  promptPending,
}: {
  messages: ChatMsg[]
  isStreaming: boolean
  streamingText: string
  streamingThinking: string
  promptPending?: boolean
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages or streaming
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, streamingThinking, isStreaming])

  if (messages.length === 0 && !isStreaming && !promptPending) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-2xl">🦀</p>
          <p className="text-muted-foreground text-sm">Start a conversation</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {messages.map(msg => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}

      {promptPending && !isStreaming && (
        <div className="flex justify-center my-3">
          <div className="streaming-dots flex gap-1 py-1">
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          </div>
        </div>
      )}

      {isStreaming && (
        <StreamingIndicator
          streamingText={streamingText}
          streamingThinking={streamingThinking}
        />
      )}

      <div ref={bottomRef} />
    </div>
  )
}
