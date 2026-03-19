import { useNavigate } from 'react-router'
import { Settings, Plus, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectList } from '@/components/ProjectList'
import { Dashboard } from '@/components/Dashboard'
import { useSoul } from '@/hooks/useSoul'
import { useCronSummary } from '@/hooks/useCron'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import type { Project } from '@codecrab/shared'

interface HomePageProps {
  onOpenSetup: () => void
  onUnauthorized?: () => void
}

export function HomePage({ onOpenSetup, onUnauthorized }: HomePageProps) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const { soul, status, recentEvolution, loading: soulLoading } = useSoul(onUnauthorized)
  const { summary: cronSummary, loading: cronLoading } = useCronSummary(onUnauthorized)

  const handleSelectProject = (project: Project) => {
    navigate(`/chat?project=${encodeURIComponent(project.id)}`)
  }

  return (
    <div className="flex-1 flex flex-col bg-background overflow-y-auto">
      {/* Header — only on mobile (desktop has sidebar) */}
      {!isDesktop && (
        <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h1 className="text-lg font-semibold tracking-tight">CodeCrab</h1>
          <Button variant="ghost" size="icon-sm" onClick={onOpenSetup} aria-label="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        </header>
      )}

      {/* Dashboard */}
      <Dashboard
        soul={soul}
        soulStatus={status}
        recentEvolution={recentEvolution}
        cronSummary={cronSummary}
        loading={soulLoading && cronLoading}
        onUnauthorized={onUnauthorized}
      />

      {/* Projects section — only on mobile (desktop has sidebar) */}
      {!isDesktop && (
        <>
          <div className="flex items-center justify-between px-4 sm:px-6 pt-5 pb-1">
            <h2 className="text-sm font-medium text-muted-foreground">Projects</h2>
            <Button variant="ghost" size="xs" onClick={() => navigate('/projects/new')}>
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </div>
          <ProjectList onSelect={handleSelectProject} onUnauthorized={onUnauthorized} />
        </>
      )}

      {/* Desktop: prompt to select a project from sidebar */}
      {isDesktop && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <FolderOpen className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
            <p className="text-base font-medium text-muted-foreground">Select a project</p>
            <p className="text-sm text-muted-foreground/60 mt-1">Choose a project from the sidebar to start</p>
          </div>
        </div>
      )}
    </div>
  )
}
