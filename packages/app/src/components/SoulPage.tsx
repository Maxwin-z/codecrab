// SoulPage — SOUL Profile viewer/editor with Markdown content and evolution timeline

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Sparkles, Brain, Save, X, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSoul } from '@/hooks/useSoul'
import { authFetch } from '@/lib/auth'

interface SoulPageProps {
  onUnauthorized?: () => void
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

export function SoulPage({ onUnauthorized }: SoulPageProps) {
  const navigate = useNavigate()
  const { soul, status, recentEvolution, loading, refresh } = useSoul(onUnauthorized)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    if (soul) {
      setEditDraft(soul.content)
      setEditing(true)
    }
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditDraft('')
  }

  const saveEdit = async () => {
    setSaving(true)
    try {
      const res = await authFetch('/api/soul', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editDraft }),
      }, onUnauthorized)
      if (res.ok) {
        setEditing(false)
        setEditDraft('')
        refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  const maxLength = status?.maxLength || 4000
  const overLimit = editDraft.length > maxLength

  if (loading) {
    return (
      <div className="min-h-dvh flex flex-col bg-background">
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">SOUL Profile</h1>
        </header>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  const hasSoul = status?.hasSoul

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">SOUL Profile</h1>
          {status && <span className="text-xs text-muted-foreground tabular-nums">v{status.soulVersion}</span>}
        </div>
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={cancelEdit}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit} disabled={saving || overLimit}>
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={startEdit}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-6">

          {/* Empty state */}
          {!hasSoul && !editing && (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
                <Brain className="h-7 w-7 text-muted-foreground" />
              </div>
              <h2 className="text-base font-medium mb-2">No SOUL Profile Yet</h2>
              <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                Your SOUL profile will be built automatically as we have conversations. It captures your preferences, expertise, and work style to provide better assistance over time.
              </p>
              <Button variant="outline" onClick={startEdit}>Set Up Manually</Button>
            </div>
          )}

          {/* Editor mode */}
          {editing && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-medium text-muted-foreground">Content</h2>
                <span className={`text-xs tabular-nums ${overLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                  {editDraft.length} / {maxLength}
                </span>
              </div>
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                className="w-full h-[60vh] rounded-md border bg-background px-4 py-3 text-sm font-mono leading-relaxed outline-none focus:ring-2 focus:ring-ring/50 resize-none"
                placeholder="# Identity&#10;&#10;(Write about who you are...)&#10;&#10;# Preferences&#10;&#10;(Communication style, decision-making approach...)"
              />
              {overLimit && (
                <p className="mt-1 text-xs text-destructive">
                  Content exceeds the {maxLength} character limit. Please condense.
                </p>
              )}
            </section>
          )}

          {/* View mode — render Markdown as styled content */}
          {!editing && hasSoul && soul && (
            <section>
              <SoulMarkdownView content={soul.content} />
              {status && (
                <div className="mt-4 text-xs text-muted-foreground/50 tabular-nums">
                  {status.contentLength} / {status.maxLength} characters
                </div>
              )}
            </section>
          )}

          {/* Evolution Timeline */}
          {recentEvolution.length > 0 && !editing && (
            <section>
              <h2 className="text-sm font-medium text-muted-foreground mb-3">Evolution Timeline</h2>
              <div className="flex flex-col gap-3">
                {[...recentEvolution].reverse().map((entry, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center shrink-0">
                        <Sparkles className="h-3 w-3 text-amber-500" />
                      </div>
                      {i < recentEvolution.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                    </div>
                    <div className="pb-4 min-w-0">
                      <p className="text-sm">{entry.summary}</p>
                      <span className="text-xs text-muted-foreground">{timeAgo(entry.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  )
}

// --- Markdown renderer (lightweight, no dependencies) ---

function SoulMarkdownView({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Headings
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={key++} className="text-base font-semibold mt-5 mb-2 first:mt-0">{line.slice(2)}</h2>
      )
    } else if (line.startsWith('## ')) {
      elements.push(
        <h3 key={key++} className="text-sm font-semibold mt-4 mb-1.5">{line.slice(3)}</h3>
      )
    } else if (line.startsWith('### ')) {
      elements.push(
        <h4 key={key++} className="text-sm font-medium mt-3 mb-1">{line.slice(4)}</h4>
      )
    }
    // List items
    else if (line.match(/^\s*[-*]\s/)) {
      const text = line.replace(/^\s*[-*]\s/, '')
      elements.push(
        <li key={key++} className="text-sm ml-4 list-disc leading-relaxed">
          <InlineMarkdown text={text} />
        </li>
      )
    }
    // Indented list items (sub-list)
    else if (line.match(/^\s{2,}[-*]\s/)) {
      const text = line.replace(/^\s+[-*]\s/, '')
      elements.push(
        <li key={key++} className="text-sm ml-8 list-circle leading-relaxed text-muted-foreground">
          <InlineMarkdown text={text} />
        </li>
      )
    }
    // Empty line
    else if (line.trim() === '') {
      elements.push(<div key={key++} className="h-2" />)
    }
    // Regular paragraph
    else {
      elements.push(
        <p key={key++} className="text-sm leading-relaxed">
          <InlineMarkdown text={line} />
        </p>
      )
    }
  }

  return <div>{elements}</div>
}

/** Render inline markdown: **bold**, *italic*, `code` */
function InlineMarkdown({ text }: { text: string }) {
  // Split on markdown patterns and render styled spans
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i}>{part.slice(1, -1)}</em>
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i} className="rounded bg-secondary px-1 py-0.5 text-xs font-mono">{part.slice(1, -1)}</code>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
