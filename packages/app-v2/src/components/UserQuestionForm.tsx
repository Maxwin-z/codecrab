import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MessageCircleQuestion, Send, X, Circle, CircleDot, Square, CheckSquare } from 'lucide-react'
import type { PendingQuestion } from '@/store/types'

export function UserQuestionForm({
  pending,
  onSubmit,
  onDismiss,
}: {
  pending: PendingQuestion
  onSubmit: (answers: Record<string, string | string[]>) => void
  onDismiss: () => void
}) {
  // selections[key] = array of selected option labels
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  // customTexts[key] = free-text input value
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({})

  const isSelected = (key: string, label: string) =>
    (selections[key] ?? []).includes(label)

  const toggleOption = (key: string, label: string, isMulti: boolean) => {
    setSelections(prev => {
      const current = prev[key] ?? []
      if (isMulti) {
        return { ...prev, [key]: current.includes(label) ? current.filter(l => l !== label) : [...current, label] }
      }
      // single-select: pick this option, clear custom text
      setCustomTexts(p => ({ ...p, [key]: '' }))
      return { ...prev, [key]: [label] }
    })
  }

  const selectOther = (key: string) => {
    // deselect all options so "Other" is active
    setSelections(prev => ({ ...prev, [key]: [] }))
  }

  const isAnswered = (index: number) => {
    const key = String(index + 1)
    return (selections[key] ?? []).length > 0 || (customTexts[key] ?? '').trim().length > 0
  }

  const allAnswered = pending.questions.every((_, i) => isAnswered(i))

  const buildAnswers = (): Record<string, string | string[]> => {
    const result: Record<string, string | string[]> = {}
    pending.questions.forEach((q, i) => {
      const key = String(i + 1)
      const custom = (customTexts[key] ?? '').trim()
      if (q.multiSelect) {
        const arr = [...(selections[key] ?? [])]
        if (custom) arr.push(custom)
        result[key] = arr
      } else {
        result[key] = (selections[key] ?? [])[0] ?? custom
      }
    })
    return result
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(buildAnswers())
  }

  return (
    <div className="mx-4 mb-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircleQuestion className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-medium">Question</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 max-h-[60vh] overflow-y-auto">
        {pending.questions.map((q, i) => {
          const key = String(i + 1)
          const isMulti = q.multiSelect ?? false
          const hasOptions = q.options && q.options.length > 0
          const otherActive = hasOptions && !isMulti && (selections[key] ?? []).length === 0

          return (
            <div key={i} className="space-y-1.5">
              {q.header && (
                <p className="text-xs font-medium text-muted-foreground">{q.header}</p>
              )}
              <p className="text-sm">{q.question}</p>

              {hasOptions ? (
                <div className="space-y-1">
                  {q.options.map((opt, j) => {
                    const selected = isSelected(key, opt.label)
                    const Icon = isMulti
                      ? (selected ? CheckSquare : Square)
                      : (selected ? CircleDot : Circle)

                    return (
                      <button
                        key={j}
                        type="button"
                        className={`w-full flex items-center gap-2 text-left px-3 py-1.5 rounded border text-sm transition-colors cursor-pointer ${
                          selected
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-border hover:bg-accent/50'
                        }`}
                        onClick={() => toggleOption(key, opt.label, isMulti)}
                      >
                        <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-blue-500' : 'text-muted-foreground'}`} />
                        <span>{opt.label}</span>
                        {opt.description && (
                          <span className="text-xs text-muted-foreground ml-1">{opt.description}</span>
                        )}
                      </button>
                    )
                  })}

                  {/* "Other" option for single-select */}
                  {!isMulti && (
                    <button
                      type="button"
                      className={`w-full flex items-center gap-2 text-left px-3 py-1.5 rounded border text-sm transition-colors cursor-pointer ${
                        otherActive
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-border hover:bg-accent/50'
                      }`}
                      onClick={() => selectOther(key)}
                    >
                      {otherActive
                        ? <CircleDot className="h-4 w-4 shrink-0 text-blue-500" />
                        : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                      }
                      <span>Other (type below)</span>
                    </button>
                  )}

                  {/* Custom text input */}
                  <Input
                    placeholder={isMulti ? 'Or enter custom option...' : 'Type an answer...'}
                    value={customTexts[key] ?? ''}
                    onChange={e => setCustomTexts(prev => ({ ...prev, [key]: e.target.value }))}
                    disabled={!isMulti && !otherActive}
                    className="h-8 text-sm mt-1"
                  />
                </div>
              ) : (
                <Input
                  placeholder="Type your answer..."
                  value={customTexts[key] ?? ''}
                  onChange={e => setCustomTexts(prev => ({ ...prev, [key]: e.target.value }))}
                  className="h-8 text-sm"
                />
              )}
            </div>
          )
        })}

        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" className="gap-1" disabled={!allAnswered}>
            <Send className="h-3.5 w-3.5" />
            Submit
          </Button>
          <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" />
            Dismiss
          </Button>
          {!allAnswered && (
            <span className="text-xs text-muted-foreground">
              {pending.questions.filter((_, i) => !isAnswered(i)).length} left
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
