import { useParams, useNavigate } from 'react-router'
import { getProject, getPainting } from '@/data/mock'
import { MobileHeader } from '@/components/MobileHeader'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  Circle,
  CheckCircle2,
  Clock,
  Calendar,
  Layers,
  Paintbrush,
} from 'lucide-react'

const statusConfig = {
  draft: { label: 'Draft', icon: Circle, color: 'text-muted-foreground', bg: 'bg-muted' },
  'in-progress': { label: 'In Progress', icon: Clock, color: 'text-chart-4', bg: 'bg-chart-4/10' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'text-chart-2', bg: 'bg-chart-2/10' },
}

export function PaintingDetail() {
  const { projectId, paintingId } = useParams()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  const project = getProject(projectId!)
  const painting = getPainting(projectId!, paintingId!)

  if (!project || !painting) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Not found</div>
  }

  const status = statusConfig[painting.status]
  const StatusIcon = status.icon

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {!isDesktop && (
        <MobileHeader
          title={painting.title}
          backTo={`/projects/${projectId}`}
        />
      )}

      {isDesktop && (
        <header className="px-6 pt-4 pb-3 border-b border-border flex items-center gap-3 shrink-0">
          <button
            onClick={() => navigate(`/projects/${projectId}`)}
            className="p-1.5 -ml-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="text-xs text-muted-foreground">{project.name}</div>
            <h1 className="text-lg font-semibold leading-tight">{painting.title}</h1>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className={cn(isDesktop ? 'p-6 max-w-3xl' : 'p-4')}>
          <div className="aspect-video rounded-xl bg-secondary flex items-center justify-center mb-6">
            <Paintbrush className="w-12 h-12 text-muted-foreground/15" />
          </div>

          <div className="space-y-4">
            <div>
              <h2 className={cn(isDesktop ? 'text-xl' : 'text-lg', 'font-semibold')}>
                {painting.title}
              </h2>
              <p className="text-muted-foreground mt-1">{painting.description}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <div
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium',
                  status.color,
                  status.bg
                )}
              >
                <StatusIcon className="w-3.5 h-3.5" />
                {status.label}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="p-3 rounded-xl bg-card border border-border">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Calendar className="w-4 h-4" />
                  <span className="text-xs">Created</span>
                </div>
                <div className="text-sm font-medium">{painting.createdAt}</div>
              </div>
              <div className="p-3 rounded-xl bg-card border border-border">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Layers className="w-4 h-4" />
                  <span className="text-xs">Project</span>
                </div>
                <div className="text-sm font-medium">{project.name}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
