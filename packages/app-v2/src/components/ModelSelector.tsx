import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

const MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
]

export function ModelSelector({
  currentModel,
  onSelectModel,
}: {
  currentModel: string
  onSelectModel: (model: string) => void
}) {
  const [open, setOpen] = useState(false)

  const current = MODELS.find(m => m.id === currentModel)

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs gap-1 text-muted-foreground"
        onClick={() => setOpen(!open)}
      >
        {current?.name || currentModel || 'Select model'}
        <ChevronDown className="h-3 w-3" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-50 w-56 bg-popover border border-border rounded-md shadow-md py-1">
            {MODELS.map(m => (
              <button
                key={m.id}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors flex items-center justify-between cursor-pointer',
                  m.id === currentModel && 'text-primary',
                )}
                onClick={() => {
                  onSelectModel(m.id)
                  setOpen(false)
                }}
              >
                {m.name}
                {m.id === currentModel && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
