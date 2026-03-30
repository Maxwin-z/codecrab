import { useEffect } from 'react'
import { useStore } from '@/store/store'
import { selectAutoResumeBanners } from '@/store/selectors'
import { X } from 'lucide-react'

const AUTO_DISMISS_MS = 8000

export function AgentActivityBanner() {
  const banners = useStore(selectAutoResumeBanners)
  const dismiss = useStore(s => s.dismissAutoResumeBanner)

  // Auto-dismiss banners after timeout
  useEffect(() => {
    if (banners.length === 0) return
    const timers = banners.map(b =>
      setTimeout(() => dismiss(b.id), AUTO_DISMISS_MS),
    )
    return () => timers.forEach(clearTimeout)
  }, [banners, dismiss])

  if (banners.length === 0) return null

  return (
    <div className="space-y-1 px-3 py-1.5">
      {banners.map(b => (
        <div
          key={b.id}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs animate-in slide-in-from-top-2 duration-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
          <span className="flex-1">
            <span className="font-medium">@{b.triggeredBy.agentName}</span>
            {' woke up '}
            <span className="font-medium">@{b.agentName}</span>
            {' in '}
            <span className="font-medium">{b.threadTitle}</span>
          </span>
          <button
            className="p-0.5 hover:bg-blue-500/20 rounded transition-colors cursor-pointer"
            onClick={() => dismiss(b.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
