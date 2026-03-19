// ChannelCard — Self-contained dashboard card for channel instances

import { useNavigate } from 'react-router'
import { MessageSquare, ChevronRight, Play, AlertTriangle } from 'lucide-react'
import { useChannelInstances, useChannelTypes } from '@/hooks/useChannels'

interface ChannelCardProps {
  onUnauthorized?: () => void
}

export function ChannelCard({ onUnauthorized }: ChannelCardProps) {
  const navigate = useNavigate()
  const { types, available } = useChannelTypes(onUnauthorized)
  const { instances } = useChannelInstances(onUnauthorized)

  const running = instances.filter(i => i.status === 'running').length
  const stopped = instances.filter(i => i.status === 'stopped').length
  const errored = instances.filter(i => i.status === 'error').length

  // No plugins and no instances — show minimal card
  if (!available && instances.length === 0) {
    return (
      <div
        onClick={() => navigate('/channels')}
        className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Channels</h3>
              <p className="text-xs text-muted-foreground">External messaging</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Connect messaging platforms like Telegram to interact with your projects.
        </p>
      </div>
    )
  }

  return (
    <div
      onClick={() => navigate('/channels')}
      className="rounded-lg border bg-card p-4 flex flex-col gap-3 cursor-pointer hover:bg-accent/50 hover:border-foreground/10 transition-colors"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center">
            <MessageSquare className="h-4 w-4 text-violet-500" />
          </div>
          <div>
            <h3 className="text-sm font-medium">Channels</h3>
            <p className="text-xs text-muted-foreground">
              {instances.length} instance{instances.length !== 1 ? 's' : ''}
              {types.length > 0 && ` · ${types.length} type${types.length !== 1 ? 's' : ''}`}
            </p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/30" />
      </div>

      {/* Status badges */}
      <div className="flex flex-wrap gap-1.5">
        {running > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
            <Play className="h-2.5 w-2.5" />
            {running} running
          </span>
        )}
        {stopped > 0 && (
          <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
            {stopped} stopped
          </span>
        )}
        {errored > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            {errored} error
          </span>
        )}
      </div>

      {/* Channel type icons */}
      {types.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {types.map(t => (
            <span key={t.id} title={t.name}>{t.icon}</span>
          ))}
          <span className="ml-1">{types.map(t => t.name).join(', ')}</span>
        </div>
      )}
    </div>
  )
}
