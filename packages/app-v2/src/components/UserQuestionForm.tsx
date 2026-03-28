import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MessageCircleQuestion, Send, X } from 'lucide-react'
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
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(answers)
  }

  return (
    <div className="mx-4 mb-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircleQuestion className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-medium">Question</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {pending.questions.map((q, i) => (
          <div key={i} className="space-y-1.5">
            {q.header && (
              <p className="text-xs font-medium text-muted-foreground">{q.header}</p>
            )}
            <p className="text-sm">{q.question}</p>

            {q.options && q.options.length > 0 ? (
              <div className="space-y-1">
                {q.options.map((opt, j) => (
                  <button
                    key={j}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 rounded border text-sm transition-colors cursor-pointer ${
                      answers[q.question] === opt.label
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-border hover:bg-accent/50'
                    }`}
                    onClick={() => setAnswers(prev => ({ ...prev, [q.question]: opt.label }))}
                  >
                    <span>{opt.label}</span>
                    {opt.description && (
                      <span className="text-xs text-muted-foreground ml-2">{opt.description}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <Input
                placeholder="Type your answer..."
                value={(answers[q.question] as string) || ''}
                onChange={e => setAnswers(prev => ({ ...prev, [q.question]: e.target.value }))}
                className="h-8 text-sm"
              />
            )}
          </div>
        ))}

        <div className="flex gap-2">
          <Button type="submit" size="sm" className="gap-1">
            <Send className="h-3.5 w-3.5" />
            Submit
          </Button>
          <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" />
            Dismiss
          </Button>
        </div>
      </form>
    </div>
  )
}
