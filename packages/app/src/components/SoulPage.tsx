// SoulPage — SOUL Profile detail view with identity, preferences, evolution timeline, and insights

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Sparkles, Brain, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSoul, type SoulDocument } from '@/hooks/useSoul'
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

function formatPath(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1]
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

export function SoulPage({ onUnauthorized }: SoulPageProps) {
  const navigate = useNavigate()
  const { soul, status, recentEvolution, loading, refresh } = useSoul(onUnauthorized)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState<SoulDocument | null>(null)
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    if (soul) {
      setEditDraft(structuredClone(soul))
      setEditing(true)
    }
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditDraft(null)
  }

  const saveEdit = async () => {
    if (!editDraft) return
    setSaving(true)
    try {
      const res = await authFetch('/api/soul', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      }, onUnauthorized)
      if (res.ok) {
        setEditing(false)
        setEditDraft(null)
        refresh()
      }
    } finally {
      setSaving(false)
    }
  }

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

  const current = editing ? editDraft! : soul
  const hasSoul = status?.hasSoul && soul?.identity?.name

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
              <Button size="sm" onClick={saveEdit} disabled={saving}>
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </>
          ) : hasSoul ? (
            <Button variant="outline" size="sm" onClick={startEdit}>Edit</Button>
          ) : null}
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

          {/* Identity */}
          {(hasSoul || editing) && current && (
            <Section title="Identity">
              {editing ? (
                <div className="flex flex-col gap-3">
                  <Field label="Name" value={editDraft!.identity.name} onChange={(v) => setEditDraft({ ...editDraft!, identity: { ...editDraft!.identity, name: v } })} />
                  <Field label="Role" value={editDraft!.identity.role} onChange={(v) => setEditDraft({ ...editDraft!, identity: { ...editDraft!.identity, role: v } })} />
                  <Field label="Expertise" value={editDraft!.identity.expertise.join(', ')} onChange={(v) => setEditDraft({ ...editDraft!, identity: { ...editDraft!.identity, expertise: v.split(',').map((s) => s.trim()).filter(Boolean) } })} hint="Comma separated" />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-base font-medium">{current.identity.name}</span>
                    {current.identity.role && <span className="text-sm text-muted-foreground">{current.identity.role}</span>}
                  </div>
                  {current.identity.expertise.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {current.identity.expertise.map((exp) => (
                        <span key={exp} className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{exp}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Preferences */}
          {(hasSoul || editing) && current && (
            <Section title="Preferences">
              {editing ? (
                <div className="flex flex-col gap-3">
                  <Field label="Communication Style" value={editDraft!.preferences.communicationStyle} onChange={(v) => setEditDraft({ ...editDraft!, preferences: { ...editDraft!.preferences, communicationStyle: v } })} />
                  <Field label="Decision Style" value={editDraft!.preferences.decisionStyle} onChange={(v) => setEditDraft({ ...editDraft!, preferences: { ...editDraft!.preferences, decisionStyle: v } })} />
                  <Field label="Risk Tolerance" value={editDraft!.preferences.riskTolerance} onChange={(v) => setEditDraft({ ...editDraft!, preferences: { ...editDraft!.preferences, riskTolerance: v } })} />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <PreferenceItem label="Communication" value={current.preferences.communicationStyle} />
                  <PreferenceItem label="Decision" value={current.preferences.decisionStyle} />
                  <PreferenceItem label="Risk" value={current.preferences.riskTolerance} />
                </div>
              )}
            </Section>
          )}

          {/* Context */}
          {(hasSoul || editing) && current && (
            <Section title="Context">
              {editing ? (
                <div className="flex flex-col gap-3">
                  <Field label="Domain" value={editDraft!.context.domain} onChange={(v) => setEditDraft({ ...editDraft!, context: { ...editDraft!.context, domain: v } })} />
                  <Field label="Active Goals" value={editDraft!.context.activeGoals.join(', ')} onChange={(v) => setEditDraft({ ...editDraft!, context: { ...editDraft!.context, activeGoals: v.split(',').map((s) => s.trim()).filter(Boolean) } })} hint="Comma separated" />
                  <Field label="Constraints" value={editDraft!.context.constraints.join(', ')} onChange={(v) => setEditDraft({ ...editDraft!, context: { ...editDraft!.context, constraints: v.split(',').map((s) => s.trim()).filter(Boolean) } })} hint="Comma separated" />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {current.context.domain && (
                    <div className="text-sm"><span className="text-muted-foreground">Domain:</span> {current.context.domain}</div>
                  )}
                  {current.context.activeGoals.length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Goals:</span>
                      <ul className="mt-1 ml-4 list-disc text-sm">
                        {current.context.activeGoals.map((g, i) => <li key={i}>{g}</li>)}
                      </ul>
                    </div>
                  )}
                  {current.context.constraints.length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Constraints:</span>
                      <ul className="mt-1 ml-4 list-disc text-sm text-muted-foreground">
                        {current.context.constraints.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                  {!current.context.domain && current.context.activeGoals.length === 0 && (
                    <p className="text-sm text-muted-foreground">No active context yet.</p>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Evolution Timeline */}
          {recentEvolution.length > 0 && !editing && (
            <Section title="Evolution Timeline">
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
                      <p className="text-sm">{entry.reasoning}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">{timeAgo(entry.timestamp)}</span>
                      </div>
                      {entry.changes.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1">
                          {entry.changes.map((change, j) => (
                            <div key={j} className="text-xs text-muted-foreground flex items-center gap-1.5">
                              <span className="font-mono bg-secondary px-1 rounded">{formatPath(change.path)}</span>
                              <span className="text-muted-foreground/40 line-through">{change.before || '(empty)'}</span>
                              <span>→</span>
                              <span>{change.after}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

        </div>
      </div>
    </div>
  )
}

// --- Sub-components ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">{title}</h2>
      {children}
    </section>
  )
}

function PreferenceItem({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="rounded-lg bg-secondary/50 p-3">
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

function Field({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">
        {label}
        {hint && <span className="text-muted-foreground/50 ml-1">({hint})</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/50"
      />
    </div>
  )
}
