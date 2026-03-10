import { useCallback, useEffect, useState } from 'react'
import { Plus, Star, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DetectResult } from '@codeclaws/shared'

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { value: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { value: 'google', label: 'Google', placeholder: 'AIza...' },
  { value: 'custom', label: 'Custom / Self-hosted', placeholder: 'API key' },
] as const

interface SetupPageProps {
  onComplete: () => void
}

interface MaskedModel {
  id: string
  name: string
  provider: string
  configDir?: string
  apiKey?: string
  baseUrl?: string
}

export function SetupPage({ onComplete }: SetupPageProps) {
  // Model list
  const [models, setModels] = useState<MaskedModel[]>([])
  const [defaultModelId, setDefaultModelId] = useState<string>()

  // Add-model form
  const [showForm, setShowForm] = useState(false)
  const [provider, setProvider] = useState<string>('anthropic')
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Claude CLI detection
  const [claudeFound, setClaudeFound] = useState(false)
  const [probing, setProbing] = useState(false)
  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(false)

  const selectedProvider = PROVIDERS.find((p) => p.value === provider)

  // --- Data fetching ---

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/models')
      const data = await res.json()
      setModels(data.models)
      setDefaultModelId(data.defaultModelId)
    } catch {}
  }, [])

  useEffect(() => { loadModels() }, [loadModels])

  // Two-step Claude CLI detection
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const checkRes = await fetch('/api/setup/detect')
        const { claudeCodeInstalled } = await checkRes.json()
        if (cancelled || !claudeCodeInstalled) return

        setClaudeFound(true)
        setProbing(true)

        const probeRes = await fetch('/api/setup/detect/probe')
        const data: DetectResult = await probeRes.json()
        if (cancelled) return
        setDetect(data)
      } catch {}
      finally { if (!cancelled) setProbing(false) }
    })()
    return () => { cancelled = true }
  }, [])

  // --- Actions ---

  async function handleUseClaude() {
    setImporting(true)
    setError('')
    try {
      const res = await fetch('/api/setup/use-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionType: detect?.auth?.subscriptionType,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to import')
      }
      setImported(true)
      await loadModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function handleAddModel(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/setup/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || selectedProvider?.label || provider,
          provider,
          apiKey,
          baseUrl: baseUrl || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to save')
      }
      resetForm()
      await loadModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/setup/models/${id}`, { method: 'DELETE' })
      await loadModels()
    } catch {}
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch('/api/setup/default-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: id }),
      })
      setDefaultModelId(id)
    } catch {}
  }

  function resetForm() {
    setShowForm(false)
    setProvider('anthropic')
    setName('')
    setApiKey('')
    setBaseUrl('')
    setError('')
  }

  // --- Derived state ---

  const cliUsable = detect?.cliAvailable && detect?.auth?.loggedIn
  const showDetectBanner = claudeFound && !imported && (probing || detect?.claudeCodeInstalled)

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg flex flex-col gap-6">
        {/* Page header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">CodeClaws Setup</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure your environment to get started</p>
        </div>

        {/* Models section */}
        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
            <CardDescription>
              Add at least one AI model to begin. You can configure multiple and switch between them.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">

            {/* Claude CLI detection banner */}
            {showDetectBanner && (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] px-4 py-3 flex flex-col gap-2">
                {probing ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Found Claude Code &mdash; checking configuration&hellip;</span>
                  </div>
                ) : detect?.claudeCodeInstalled ? (
                  <>
                    <div className="text-sm font-medium">
                      {cliUsable
                        ? `Claude Code detected${detect.auth?.subscriptionType ? ` (${detect.auth.subscriptionType})` : ''}`
                        : 'Claude Code found'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {!detect.cliAvailable
                        ? 'CLI binary not found in PATH — is Claude Code installed?'
                        : !detect.auth?.loggedIn
                          ? 'Not logged in — run `claude` in your terminal to log in'
                          : `v${detect.cliVersion} — ${detect.auth.authMethod ?? 'authenticated'}`}
                    </div>
                    {cliUsable && (
                      <Button size="sm" onClick={handleUseClaude} disabled={importing} className="self-start">
                        {importing ? 'Importing...' : 'Use Claude Code'}
                      </Button>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {/* Model list */}
            {models.length > 0 && (
              <div className="flex flex-col gap-2">
                {models.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => handleSetDefault(m.id)}
                      className="shrink-0"
                      title={m.id === defaultModelId ? 'Default model' : 'Set as default'}
                    >
                      <Star className={cn(
                        'h-4 w-4 transition-colors',
                        m.id === defaultModelId
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-muted-foreground/30 hover:text-amber-400/60'
                      )} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {m.configDir || m.apiKey || 'No credentials'}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded capitalize shrink-0">
                      {m.provider}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      className="shrink-0 text-muted-foreground/30 hover:text-destructive transition-colors"
                      title="Delete model"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add-model form */}
            {showForm ? (
              <form onSubmit={handleAddModel} className="flex flex-col gap-3 rounded-lg border border-dashed p-4">
                <div className="text-sm font-medium">Add Model</div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="provider">Provider</Label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger id="provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Display Name</Label>
                  <Input
                    id="name"
                    placeholder={selectedProvider?.label || 'Model name'}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="apiKey">API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder={selectedProvider?.placeholder || 'API key'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    required
                  />
                </div>

                {provider === 'custom' && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="baseUrl">Base URL</Label>
                    <Input
                      id="baseUrl"
                      placeholder="https://api.example.com/v1"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                  </div>
                )}

                {error && <p className="text-sm text-destructive">{error}</p>}

                <div className="flex gap-2 justify-end pt-1">
                  <Button type="button" variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
                  <Button type="submit" size="sm" disabled={!apiKey || saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </form>
            ) : (
              <Button variant="outline" className="self-start" onClick={() => setShowForm(true)}>
                <Plus className="h-4 w-4" />
                Add Model
              </Button>
            )}

          </CardContent>
        </Card>

        {/* Continue */}
        <div className="flex flex-col gap-2">
          <Button className="w-full" size="lg" disabled={models.length === 0} onClick={onComplete}>
            Get Started
          </Button>
          {models.length === 0 && (
            <p className="text-xs text-muted-foreground text-center">
              Add at least one model to continue
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
