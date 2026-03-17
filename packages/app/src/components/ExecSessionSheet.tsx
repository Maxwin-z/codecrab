// ExecSessionSheet — Modal for viewing cron execution session details (mirrors iOS ExecSessionSheet)
import { useEffect, useState } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MessageList } from './MessageList'
import { authFetch } from '@/lib/auth'
import type { ChatMessage, DebugEvent } from '@codecrab/shared'

interface ExecSessionSheetProps {
  sessionId: string
  onClose: () => void
}

interface SessionMessagesResponse {
  sessionId: string
  messages: ChatMessage[]
  debugEvents: DebugEvent[]
}

export function ExecSessionSheet({ sessionId, onClose }: ExecSessionSheetProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    authFetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: SessionMessagesResponse) => {
        setMessages(data.messages)
        setDebugEvents(data.debugEvents)
      })
      .catch((err) => {
        setError(`Failed to load session: ${err.message}`)
      })
      .finally(() => setLoading(false))
  }, [sessionId])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Sheet */}
      <div className="relative z-50 w-full max-w-2xl max-h-[85vh] bg-background rounded-t-xl sm:rounded-xl border shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h3 className="text-sm font-medium">Execution Details</h3>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-muted-foreground">{sessionId.slice(-8)}</span>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading session...</span>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <AlertTriangle className="h-6 w-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{error}</span>
            </div>
          )}
          {!loading && !error && (
            <MessageList
              messages={messages}
              streamingText=""
              streamingThinking=""
              isRunning={false}
              sdkEvents={debugEvents}
            />
          )}
        </div>
      </div>
    </div>
  )
}
