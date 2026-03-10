// InputBar — user text input with command prefix support
import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'

interface InputBarProps {
  onSend: (text: string) => void
  onAbort: () => void
  isRunning: boolean
  isAborting?: boolean
  disabled: boolean
}

export function InputBar({ onSend, onAbort, isRunning, isAborting, disabled }: InputBarProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }
  }, [text])

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const isComposingRef = useRef(false)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd+Enter to send, Enter for new line
    if (e.key === 'Enter' && e.metaKey && !isComposingRef.current) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="border-t bg-background px-4 py-3">
      <div className="relative flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          placeholder={isRunning ? 'Running...' : 'Cmd+Enter to send'}
          disabled={disabled || isRunning}
          rows={1}
          className="flex-1 min-h-[44px] max-h-[150px] bg-muted rounded-lg px-4 py-2.5 pr-12 text-sm resize-none placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <div className="absolute right-16 bottom-1.5">
          {isRunning ? (
            <Button
              onClick={onAbort}
              disabled={isAborting}
              size="icon"
              variant="destructive"
              className="h-8 w-8"
              title={isAborting ? 'Stopping...' : 'Stop'}
            >
              {isAborting ? (
                <svg width="14" height="14" viewBox="0 0 24 24" className="animate-spin">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="60" strokeDashoffset="20" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" />
                </svg>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={disabled || !text.trim()}
              size="icon"
              className="h-8 w-8"
              title="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 text-xs text-muted-foreground">
        <span>Cmd+Enter to send</span>
        {isRunning && <span className="text-amber-500">Processing...</span>}
      </div>
    </div>
  )
}
