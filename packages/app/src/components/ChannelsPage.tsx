// ChannelsPage — Channel plugin management (list, create, start/stop, delete)

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Plus, Repeat, Play, Square, Trash2, ChevronDown, ChevronRight, AlertTriangle, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChannelConfigForm } from '@/components/ChannelConfigForm'
import { ChannelSettingsForm } from '@/components/ChannelSettingsForm'
import type { ChannelSettings } from '@/components/ChannelSettingsForm'
import { useChannelTypes, useChannelInstances, channelApi } from '@/hooks/useChannels'
import type { ChannelType, ChannelInstance } from '@/hooks/useChannels'
import { authFetch } from '@/lib/auth'

interface ChannelsPageProps {
  onUnauthorized?: () => void
}

const statusConfig: Record<string, { color: string; bgColor: string; label: string }> = {
  running: { color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-500/15', label: 'Running' },
  starting: { color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-500/15', label: 'Starting' },
  stopped: { color: 'text-muted-foreground', bgColor: 'bg-secondary', label: 'Stopped' },
  error: { color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-500/15', label: 'Error' },
}

function InstanceCard({
  instance,
  channelType,
  expanded,
  onToggle,
  onStart,
  onStop,
  onDelete,
  actionLoading,
}: {
  instance: ChannelInstance
  channelType?: ChannelType
  expanded: boolean
  onToggle: () => void
  onStart: () => void
  onStop: () => void
  onDelete: () => void
  actionLoading: boolean
}) {
  const config = statusConfig[instance.status] || statusConfig.stopped

  return (
    <div className="rounded-lg border bg-card flex flex-col overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex flex-col gap-2.5 cursor-pointer hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
            }
            <span className="text-base shrink-0">{channelType?.icon || '🔌'}</span>
            <h3 className="text-sm font-medium truncate">
              {channelType?.name || instance.id} — {instance.instanceId}
            </h3>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {instance.status === 'running' || instance.status === 'starting' ? (
              <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onStop() }} disabled={actionLoading}>
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onStart() }} disabled={actionLoading}>
                <Play className="h-3.5 w-3.5" />
                Start
              </Button>
            )}
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${config.bgColor} ${config.color}`}>
              {config.label}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pl-7">
          <span>Mode: {instance.interactiveMode}</span>
          <span>Response: {instance.responseMode}</span>
          {instance.defaultProjectId && <span>Project: {instance.defaultProjectId}</span>}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 flex flex-col gap-4 bg-muted/30">
          {/* Config fields (secrets masked) */}
          {Object.keys(instance.config).length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Configuration</h4>
              <div className="grid grid-cols-1 gap-1.5 text-xs">
                {Object.entries(instance.config).map(([key, value]) => {
                  const field = channelType?.configSchema.find(f => f.key === key)
                  const isSecret = field?.type === 'secret'
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-muted-foreground font-medium">{field?.label || key}:</span>
                      <span className="font-mono truncate">
                        {isSecret ? '••••••••' : String(value)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <span className="text-muted-foreground">Interactive Mode</span>
              <p className="font-medium">{instance.interactiveMode}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Response Mode</span>
              <p className="font-medium">{instance.responseMode}</p>
            </div>
            {instance.maxMessageLength && (
              <div>
                <span className="text-muted-foreground">Max Length</span>
                <p className="font-medium">{instance.maxMessageLength}</p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Created</span>
              <p>{new Date(instance.createdAt).toLocaleString()}</p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onDelete} disabled={actionLoading} className="text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function AddChannelForm({
  channelTypes,
  projects,
  onCreated,
  onCancel,
  onUnauthorized,
}: {
  channelTypes: ChannelType[]
  projects: Array<{ id: string; name: string }>
  onCreated: () => void
  onCancel: () => void
  onUnauthorized?: () => void
}) {
  const [selectedTypeId, setSelectedTypeId] = useState('')
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({})
  const [settings, setSettings] = useState<ChannelSettings>({
    defaultProjectId: '',
    interactiveMode: 'forward',
    responseMode: 'streaming',
    maxMessageLength: '',
    projectMapping: '[]',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const selectedType = channelTypes.find(t => t.id === selectedTypeId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    let mapping: unknown[] = []
    try {
      mapping = JSON.parse(settings.projectMapping)
    } catch {
      setError('Invalid JSON in project mapping')
      setSubmitting(false)
      return
    }

    try {
      const res = await channelApi.createInstance({
        id: selectedTypeId,
        config: configValues,
        defaultProjectId: settings.defaultProjectId || undefined,
        projectMapping: mapping as [],
        interactiveMode: settings.interactiveMode,
        responseMode: settings.responseMode,
        maxMessageLength: settings.maxMessageLength ? Number(settings.maxMessageLength) : undefined,
      }, onUnauthorized)

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to create channel')
      } else {
        onCreated()
      }
    } catch {
      setError('Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-4 flex flex-col gap-5">
      <h3 className="text-sm font-medium">Add Channel</h3>

      {/* Channel Type */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Channel Type</span>
        <Select value={selectedTypeId} onValueChange={v => { setSelectedTypeId(v); setConfigValues({}) }}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select channel type..." />
          </SelectTrigger>
          <SelectContent>
            {channelTypes.map(t => (
              <SelectItem key={t.id} value={t.id}>
                {t.icon} {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Plugin config fields */}
      {selectedType && (
        <>
          <div className="border-t pt-4">
            <h4 className="text-xs font-medium text-muted-foreground mb-3">{selectedType.name} Configuration</h4>
            <ChannelConfigForm
              schema={selectedType.configSchema}
              values={configValues}
              onChange={setConfigValues}
            />
          </div>

          {/* Common settings */}
          <div className="border-t pt-4">
            <h4 className="text-xs font-medium text-muted-foreground mb-3">Settings</h4>
            <ChannelSettingsForm
              settings={settings}
              onChange={setSettings}
              projects={projects}
            />
          </div>
        </>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!selectedTypeId || submitting}>
          {submitting ? 'Creating...' : 'Create Channel'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function ChannelsPage({ onUnauthorized }: ChannelsPageProps) {
  const navigate = useNavigate()
  const { types, loading: typesLoading, available } = useChannelTypes(onUnauthorized)
  const { instances, loading: instancesLoading, refresh } = useChannelInstances(onUnauthorized)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])

  const loading = typesLoading || instancesLoading

  const fetchProjects = useCallback(async () => {
    try {
      const res = await authFetch('/api/projects', {}, onUnauthorized)
      if (res.ok) {
        const data = await res.json()
        setProjects(data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })))
      }
    } catch { /* silent */ }
  }, [onUnauthorized])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleStart = async (instanceId: string) => {
    setActionLoading(instanceId)
    try {
      await channelApi.startInstance(instanceId, onUnauthorized)
      await refresh()
    } catch { /* silent */ }
    setActionLoading(null)
  }

  const handleStop = async (instanceId: string) => {
    setActionLoading(instanceId)
    try {
      await channelApi.stopInstance(instanceId, onUnauthorized)
      await refresh()
    } catch { /* silent */ }
    setActionLoading(null)
  }

  const handleDelete = async (instanceId: string) => {
    setActionLoading(instanceId)
    try {
      await channelApi.deleteInstance(instanceId, onUnauthorized)
      setExpandedId(null)
      await refresh()
    } catch { /* silent */ }
    setActionLoading(null)
  }

  if (loading) {
    return (
      <div className="flex-1 flex flex-col bg-background overflow-y-auto">
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">Channels</h1>
        </header>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-background overflow-y-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">Channels</h1>
          {instances.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">{instances.length} instance{instances.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refresh()}>
            <Repeat className="h-3.5 w-3.5" />
            Refresh
          </Button>
          {available && !showAddForm && (
            <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add Channel
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-6">

          {/* Unavailable state */}
          {!available && instances.length === 0 && (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
                <MessageSquare className="h-7 w-7 text-muted-foreground" />
              </div>
              <h2 className="text-base font-medium mb-2">No Channel Plugins Detected</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Install a channel plugin package (e.g. <code className="text-xs bg-secondary px-1 py-0.5 rounded">@codecrab/channel-telegram</code>) to connect external messaging platforms.
              </p>
            </div>
          )}

          {/* Add form */}
          {showAddForm && (
            <AddChannelForm
              channelTypes={types}
              projects={projects}
              onCreated={() => { setShowAddForm(false); refresh() }}
              onCancel={() => setShowAddForm(false)}
              onUnauthorized={onUnauthorized}
            />
          )}

          {/* Empty state with available types */}
          {available && instances.length === 0 && !showAddForm && (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
                <MessageSquare className="h-7 w-7 text-muted-foreground" />
              </div>
              <h2 className="text-base font-medium mb-2">No Channels Configured</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-4">
                {types.length} channel type{types.length !== 1 ? 's' : ''} available: {types.map(t => t.name).join(', ')}
              </p>
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add Channel
              </Button>
            </div>
          )}

          {/* Instance list */}
          {instances.length > 0 && (
            <section>
              <div className="flex flex-col gap-2">
                {instances.map(inst => (
                  <InstanceCard
                    key={inst.instanceId}
                    instance={inst}
                    channelType={types.find(t => t.id === inst.id)}
                    expanded={expandedId === inst.instanceId}
                    onToggle={() => setExpandedId(prev => prev === inst.instanceId ? null : inst.instanceId)}
                    onStart={() => handleStart(inst.instanceId)}
                    onStop={() => handleStop(inst.instanceId)}
                    onDelete={() => handleDelete(inst.instanceId)}
                    actionLoading={actionLoading === inst.instanceId}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
