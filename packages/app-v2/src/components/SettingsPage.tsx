import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, Star, Trash2, Loader2, CircleCheck, CircleX, Wifi, WifiOff, Radar, Server, ArrowLeft, Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
// Card components removed — flat layout
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { authFetch } from '@/lib/auth'
import { buildApiUrl, getServerUrl, setServerUrl, clearServerUrl, getServerDisplay } from '@/lib/server'
import { scanLAN, canScan, type DiscoveredServer, type ScanProgress } from '@/lib/lanScanner'
import type { DetectResult } from '@codecrab/shared'

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { value: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { value: 'google', label: 'Google', placeholder: 'AIza...' },
  { value: 'custom', label: 'Custom / Self-hosted', placeholder: 'API key' },
] as const

interface MaskedProvider {
  id: string
  name: string
  provider: string
  apiKey?: string
  baseUrl?: string
}

export function SettingsPage({
  onUnauthorized,
}: {
  onUnauthorized?: () => void
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

  // Provider list
  const [providers, setProviders] = useState<MaskedProvider[]>([])
  const [defaultProviderId, setDefaultProviderId] = useState<string>()

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

  // Model connectivity test
  const [testStatus, setTestStatus] = useState<Record<string, { status: 'testing' | 'ok' | 'error'; error?: string }>>({})
  const testedRef = useRef<Set<string>>(new Set())

  // Server connection
  const [serverDisplay, setServerDisplayState] = useState(getServerDisplay())
  const [serverPort, setServerPort] = useState('4200')
  const [manualAddress, setManualAddress] = useState(getServerUrl() || `http://${window.location.hostname}:4200`)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([])
  const [serverConnecting, setServerConnecting] = useState(false)
  const [serverError, setServerError] = useState('')
  const [serverStatus, setServerStatus] = useState<'unknown' | 'checking' | 'connected' | 'error'>('unknown')
  const scanAbortRef = useRef<AbortController | null>(null)

  const selectedProvider = PROVIDERS.find((p) => p.value === provider)

  // Check current server connectivity on mount
  useEffect(() => {
    checkServerConnection()
  }, [])

  async function checkServerConnection() {
    setServerStatus('checking')
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(buildApiUrl('/api/discovery'), { signal: controller.signal })
      clearTimeout(timeoutId)
      if (res.ok) {
        const data = await res.json()
        if (data.service?.toLowerCase() === 'codecrab') {
          setServerStatus('connected')
          return
        }
      }
      setServerStatus('error')
    } catch {
      setServerStatus('error')
    }
  }

  async function handleConnectServer(url: string) {
    setServerConnecting(true)
    setServerError('')
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${url}/api/discovery`, { signal: controller.signal })
      clearTimeout(timeoutId)
      if (!res.ok) throw new Error('Server returned an error')
      const data = await res.json()
      if (data.service?.toLowerCase() !== 'codecrab') throw new Error('Not a CodeCrab server')

      setServerUrl(url)
      setServerDisplayState(getServerDisplay())
      setManualAddress(url)
      setServerStatus('connected')
      window.location.reload()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Connection failed')
      setServerStatus('error')
    } finally {
      setServerConnecting(false)
    }
  }

  function handleResetServer() {
    clearServerUrl()
    setServerDisplayState(getServerDisplay())
    setManualAddress(`http://${window.location.hostname}:4200`)
    setServerStatus('unknown')
    window.location.reload()
  }

  function handleStartScan() {
    scanAbortRef.current?.abort()
    const controller = new AbortController()
    scanAbortRef.current = controller
    setScanning(true)
    setDiscoveredServers([])
    setScanProgress(null)

    scanLAN(
      parseInt(serverPort) || 4200,
      (progress) => {
        setScanProgress(progress)
        setDiscoveredServers(progress.servers)
      },
      controller.signal
    ).then(() => {
      setScanning(false)
    })
  }

  function handleStopScan() {
    scanAbortRef.current?.abort()
    setScanning(false)
  }

  // --- Data fetching ---

  const loadProviders = useCallback(async () => {
    try {
      const res = await authFetch('/api/setup/providers', {}, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      const data = await res.json()
      setProviders(data.providers)
      setDefaultProviderId(data.defaultProviderId)
    } catch {}
  }, [onUnauthorized])

  useEffect(() => { loadProviders() }, [loadProviders])

  // Two-step Claude CLI detection
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const checkRes = await fetch(buildApiUrl('/api/setup/detect'))
        const { claudeCodeInstalled } = await checkRes.json()
        if (cancelled || !claudeCodeInstalled) return

        setClaudeFound(true)
        setProbing(true)

        const probeRes = await fetch(buildApiUrl('/api/setup/detect/probe'))
        const data: DetectResult = await probeRes.json()
        if (cancelled) return
        setDetect(data)
      } catch {}
      finally { if (!cancelled) setProbing(false) }
    })()
    return () => { cancelled = true }
  }, [])

  // Auto-test API-key providers on load
  useEffect(() => {
    for (const p of providers) {
      if (p.apiKey && !testedRef.current.has(p.id)) {
        testedRef.current.add(p.id)
        testProvider(p.id)
      }
    }
  }, [providers])

  async function testProvider(id: string) {
    setTestStatus((prev) => ({ ...prev, [id]: { status: 'testing' } }))
    try {
      const res = await authFetch(`/api/setup/providers/${id}/test`, { method: 'POST' }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      const data = await res.json()
      setTestStatus((prev) => ({
        ...prev,
        [id]: data.ok ? { status: 'ok' } : { status: 'error', error: data.error },
      }))
    } catch {
      setTestStatus((prev) => ({ ...prev, [id]: { status: 'error', error: 'Connection failed' } }))
    }
  }

  // --- Actions ---

  async function handleUseClaude() {
    setImporting(true)
    setError('')
    try {
      const res = await authFetch('/api/setup/use-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionType: detect?.auth?.subscriptionType,
        }),
      }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to import')
      }
      setImported(true)
      await loadProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function handleAddProvider(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const res = await authFetch('/api/setup/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || selectedProvider?.label || provider,
          provider,
          apiKey,
          baseUrl: baseUrl || undefined,
        }),
      }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to save')
      }
      resetForm()
      await loadProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await authFetch(`/api/setup/providers/${id}`, { method: 'DELETE' }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      testedRef.current.delete(id)
      setTestStatus((prev) => { const next = { ...prev }; delete next[id]; return next })
      await loadProviders()
    } catch {}
  }

  async function handleSetDefault(id: string) {
    try {
      const res = await authFetch('/api/setup/default-provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: id }),
      }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      setDefaultProviderId(id)
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
  const hasClaudeProvider = providers.some((p) => p.provider === 'anthropic' && !p.apiKey)
  const showDetectBanner = claudeFound && !imported && !hasClaudeProvider && (probing || detect?.claudeCodeInstalled)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>

        {/* Appearance */}
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Appearance</h2>
            <p className="text-xs text-muted-foreground">Choose your preferred color theme</p>
          </div>
          <div className="flex gap-2">
            {([
              { value: 'light' as const, icon: Sun, label: 'Light' },
              { value: 'dark' as const, icon: Moon, label: 'Dark' },
            ]).map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors cursor-pointer',
                  theme === value
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent/50',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </section>

        <hr className="border-border" />

        {/* Server Connection */}
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Server Connection</h2>
            <p className="text-xs text-muted-foreground">Connect to a CodeCrab server on your local network</p>
          </div>

          {/* Current connection status */}
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            {serverStatus === 'checking' ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
            ) : serverStatus === 'connected' ? (
              <Wifi className="h-4 w-4 text-emerald-500 shrink-0" />
            ) : (
              <WifiOff className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {serverStatus === 'connected' ? 'Connected' : serverStatus === 'checking' ? 'Checking...' : 'Not connected'}
              </div>
              <div className="text-xs text-muted-foreground font-mono truncate">
                {serverDisplay.address}
              </div>
            </div>
            {serverDisplay.isCustom && (
              <Button variant="ghost" size="sm" onClick={handleResetServer} className="shrink-0 text-xs">
                Reset
              </Button>
            )}
          </div>

          {/* Port input + scan button (only when accessed via LAN IP) */}
          {canScan() && (
            <>
              <div className="flex gap-2 items-end">
                <div className="flex flex-col gap-1.5 flex-1">
                  <Label htmlFor="serverPort" className="text-xs">Port</Label>
                  <Input
                    id="serverPort"
                    type="number"
                    placeholder="4200"
                    value={serverPort}
                    onChange={(e) => setServerPort(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={scanning ? handleStopScan : handleStartScan}
                  disabled={serverConnecting}
                >
                  {scanning ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Radar className="h-4 w-4" />
                      Scan
                    </>
                  )}
                </Button>
              </div>

              {/* Scan progress */}
              {scanning && scanProgress && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs text-muted-foreground">
                    Scanning... {scanProgress.completed}/{scanProgress.total}
                  </div>
                  <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${(scanProgress.completed / scanProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Discovered servers */}
              {discoveredServers.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Found {discoveredServers.length} server{discoveredServers.length > 1 ? 's' : ''}
                  </div>
                  {discoveredServers.map((s) => (
                    <button
                      key={s.url}
                      type="button"
                      onClick={() => handleConnectServer(s.url)}
                      disabled={serverConnecting}
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 hover:bg-accent/50 transition-colors text-left w-full cursor-pointer"
                    >
                      <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium font-mono truncate">{s.ip}:{s.port}</div>
                        <div className="text-xs text-muted-foreground">v{s.version}</div>
                      </div>
                      <span className="text-xs text-primary">Connect</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Scan complete, no results */}
              {!scanning && scanProgress && discoveredServers.length === 0 && (
                <p className="text-xs text-muted-foreground">No servers found on port {serverPort}</p>
              )}
            </>
          )}

          {/* Manual address input */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manualAddress" className="text-xs">Server Address</Label>
            <div className="flex gap-2">
              <Input
                id="manualAddress"
                placeholder="http://192.168.1.x:4200"
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
              />
              <Button
                variant="outline"
                onClick={() => handleConnectServer(manualAddress.replace(/\/$/, ''))}
                disabled={!manualAddress || serverConnecting}
              >
                {serverConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
              </Button>
            </div>
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        </section>

        <hr className="border-border" />

        {/* Providers section */}
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Providers</h2>
            <p className="text-xs text-muted-foreground">Configure AI providers. You can add multiple and switch between them.</p>
          </div>

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

          {/* Provider list */}
          {providers.length > 0 && (
            <div className="flex flex-col gap-2">
              {providers.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => handleSetDefault(p.id)}
                    className="shrink-0 cursor-pointer"
                    title={p.id === defaultProviderId ? 'Default provider' : 'Set as default'}
                  >
                    <Star className={cn(
                      'h-4 w-4 transition-colors',
                      p.id === defaultProviderId
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-muted-foreground/30 hover:text-amber-400/60'
                    )} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {p.apiKey ? p.apiKey : 'CLI OAuth'}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded capitalize shrink-0">
                    {p.provider}
                  </span>
                  {testStatus[p.id]?.status === 'testing' && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                  )}
                  {testStatus[p.id]?.status === 'ok' && (
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  )}
                  {testStatus[p.id]?.status === 'error' && (
                    <button
                      type="button"
                      onClick={() => { testedRef.current.delete(p.id); testProvider(p.id) }}
                      className="shrink-0 cursor-pointer"
                      title={testStatus[p.id].error || 'Connection failed — click to retry'}
                    >
                      <CircleX className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(p.id)}
                    className="shrink-0 text-muted-foreground/30 hover:text-destructive transition-colors cursor-pointer"
                    title="Delete provider"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add-provider form */}
          {showForm ? (
            <form onSubmit={handleAddProvider} className="flex flex-col gap-3 rounded-lg border border-dashed p-4">
              <div className="text-sm font-medium">Add Provider</div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider" className="text-xs">Provider</Label>
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

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name" className="text-xs">Display Name</Label>
                <Input
                  id="name"
                  placeholder={selectedProvider?.label || 'Model name'}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apiKey" className="text-xs">API Key</Label>
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
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="baseUrl" className="text-xs">Base URL</Label>
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
              Add Provider
            </Button>
          )}
        </section>
      </div>
    </div>
  )
}
