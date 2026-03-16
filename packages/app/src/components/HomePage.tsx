import { useNavigate } from 'react-router'
import { Settings, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectList } from '@/components/ProjectList'
import { Dashboard } from '@/components/Dashboard'
import { useSoul } from '@/hooks/useSoul'
import type { Project } from '@codeclaws/shared'

interface HomePageProps {
  onOpenSetup: () => void
  onUnauthorized?: () => void
}

export function HomePage({ onOpenSetup, onUnauthorized }: HomePageProps) {
  const navigate = useNavigate()
  const { soul, status, recentEvolution, loading: soulLoading } = useSoul(onUnauthorized)

  const handleSelectProject = (project: Project) => {
    navigate(`/chat?project=${encodeURIComponent(project.id)}`)
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Header — simplified */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <h1 className="text-lg font-semibold tracking-tight">CodeClaws</h1>
        <Button variant="ghost" size="icon-sm" onClick={onOpenSetup} aria-label="Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </header>

      {/* Dashboard */}
      <Dashboard
        soul={soul}
        soulStatus={status}
        recentEvolution={recentEvolution}
        loading={soulLoading}
      />

      {/* Projects section */}
      <div className="flex items-center justify-between px-4 sm:px-6 pt-5 pb-1">
        <h2 className="text-sm font-medium text-muted-foreground">Projects</h2>
        <Button variant="ghost" size="xs" onClick={() => navigate('/projects/new')}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>
      <ProjectList onSelect={handleSelectProject} onUnauthorized={onUnauthorized} />
    </div>
  )
}
