// SoulCard — Dashboard card showing SOUL persona status and recent evolution

import { useNavigate } from 'react-router'
import { Brain, Sparkles, ChevronRight, User } from 'lucide-react'
import type { SoulDocument, SoulStatus, EvolutionEntry } from '@/hooks/useSoul'

interface SoulCardProps {
  soul: SoulDocument | null
  status: SoulStatus | null
  recentEvolution: EvolutionEntry[]
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Extract a brief summary line from soul markdown content */
function extractSummary(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const clean = trimmed.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^-\s*/, '')
    if (clean.length > 0) return clean.length > 80 ? clean.slice(0, 80) + '…' : clean
  }
  return ''
}

/** Extract tags/keywords from soul markdown for display */
function extractTags(content: string): string[] {
  const tags: string[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    // Match "- **Label:** Value" pattern
    const match = line.match(/^\s*-\s*\*\*[^*]+:\*\*\s*(.+)/)
    if (match && tags.length < 4) {
      const value = match[1].trim()
      // Split comma-separated values
      if (value.includes(',')) {
        tags.push(...value.split(',').map(v => v.trim()).filter(Boolean).slice(0, 2))
      } else if (value.length < 30) {
        tags.push(value)
      }
    }
  }
  return tags.slice(0, 4)
}

export function SoulCard({ soul, status, recentEvolution }: SoulCardProps) {
  const navigate = useNavigate()
  const hasSoul = status?.hasSoul

  // Empty state — SOUL not initialized yet
  if (!hasSoul) {
    return (
      <div
        onClick={() => navigate('/soul')}
        className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
              <Brain className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-medium">SOUL</h3>
              <p className="text-xs text-muted-foreground">Personal Profile</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          I'll learn your preferences and work style through our conversations to provide better assistance over time.
        </p>
        <div className="flex items-center gap-1 text-xs text-muted-foreground/60">
          <Sparkles className="h-3 w-3" />
          <span>Evolves automatically</span>
        </div>
      </div>
    )
  }

  // Active state — show persona summary + recent evolution
  const latestEvolution = recentEvolution[recentEvolution.length - 1]
  const summary = soul ? extractSummary(soul.content) : ''
  const tags = soul ? extractTags(soul.content) : []

  return (
    <div
      onClick={() => navigate('/soul')}
      className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
            <User className="h-4 w-4 text-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-medium">SOUL</h3>
            <p className="text-xs text-muted-foreground line-clamp-1">{summary || 'Personal Profile'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground/60 tabular-nums">v{status.soulVersion}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
        </div>
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Recent evolution */}
      {latestEvolution && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <span className="line-clamp-1">{latestEvolution.summary}</span>
            <span className="text-muted-foreground/50 ml-1">{timeAgo(latestEvolution.timestamp)}</span>
          </div>
        </div>
      )}

      {/* Footer */}
      {status && status.evolutionCount > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground/50 pt-1 border-t">
          <span>{status.evolutionCount} evolutions</span>
          {status.insightCount > 0 && <span>{status.insightCount} insights</span>}
        </div>
      )}
    </div>
  )
}
