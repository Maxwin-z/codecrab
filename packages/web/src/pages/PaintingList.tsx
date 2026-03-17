import { useParams, useNavigate } from 'react-router'
import { getProject, getPaintings, type Painting } from '@/data/mock'
import { MobileHeader } from '@/components/MobileHeader'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { ChevronRight, Circle, CheckCircle2, Clock, Paintbrush } from 'lucide-react'

const statusConfig = {
  draft: { label: 'Draft', icon: Circle, color: 'text-muted-foreground' },
  'in-progress': { label: 'In Progress', icon: Clock, color: 'text-chart-4' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'text-chart-2' },
}

export function PaintingList() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  const project = getProject(projectId!)
  const paintings = getPaintings(projectId!)

  if (!project) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Project not found</div>
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {!isDesktop && <MobileHeader title={project.name} backTo="/" />}

      {isDesktop && (
        <header className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">{project.description}</p>
        </header>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className={cn(isDesktop ? 'p-6' : 'p-4')}>
          <div
            className={cn(
              isDesktop
                ? 'grid grid-cols-2 xl:grid-cols-3 gap-4'
                : 'space-y-2'
            )}
          >
            {paintings.map(painting => (
              <PaintingCard
                key={painting.id}
                painting={painting}
                isDesktop={isDesktop}
                onClick={() =>
                  navigate(`/projects/${projectId}/paintings/${painting.id}`)
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function PaintingCard({
  painting,
  isDesktop,
  onClick,
}: {
  painting: Painting
  isDesktop: boolean
  onClick: () => void
}) {
  const status = statusConfig[painting.status]
  const StatusIcon = status.icon

  if (isDesktop) {
    return (
      <button
        onClick={onClick}
        className="text-left p-4 rounded-xl bg-card border border-border hover:border-ring/50 transition-colors group"
      >
        <div className="aspect-[4/3] rounded-lg bg-secondary mb-3 flex items-center justify-center">
          <Paintbrush className="w-8 h-8 text-muted-foreground/20" />
        </div>
        <h3 className="font-medium group-hover:text-primary transition-colors">
          {painting.title}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
          {painting.description}
        </p>
        <div className={cn('flex items-center gap-1 mt-2 text-xs', status.color)}>
          <StatusIcon className="w-3 h-3" />
          <span>{status.label}</span>
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-xl bg-card border border-border active:bg-accent transition-colors"
    >
      <div className="w-12 h-12 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        <Paintbrush className="w-5 h-5 text-muted-foreground/40" />
      </div>
      <div className="flex-1 text-left min-w-0">
        <div className="font-medium text-sm">{painting.title}</div>
        <div className={cn('flex items-center gap-1 text-xs mt-0.5', status.color)}>
          <StatusIcon className="w-3 h-3" />
          <span>{status.label}</span>
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </button>
  )
}
