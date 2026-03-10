// MessageList — renders chat messages
import { useState } from 'react'
import type { ChatMessage } from '@codeclaws/shared'

interface MessageListProps {
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  isRunning: boolean
}

export function MessageList({ messages, streamingText, streamingThinking, isRunning }: MessageListProps) {
  if (messages.length === 0 && !streamingText && !isRunning) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">CodeClaws</p>
          <p className="text-sm mt-1">Send a message to start coding with AI</p>
        </div>
      </div>
    )
  }

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

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end min-w-0">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2 max-w-[85%] text-sm whitespace-pre-wrap break-all">
          {message.content}
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
