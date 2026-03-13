import { useNavigate } from 'react-router'
import { Settings, Plus, Bug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectList } from '@/components/ProjectList'
import type { Project } from '@codeclaws/shared'

interface HomePageProps {
  onOpenSetup: () => void
  onUnauthorized?: () => void
}

export function HomePage({ onOpenSetup, onUnauthorized }: HomePageProps) {
  const navigate = useNavigate()

  const handleSelectProject = (project: Project) => {
    navigate(`/chat?project=${encodeURIComponent(project.id)}`)
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <h1 className="text-lg font-semibold tracking-tight">CodeClaws</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigate('/projects/new')}>
            <Plus className="h-4 w-4" />
            New Project
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate('/debug')} aria-label="Debug">
            <Bug className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onOpenSetup} aria-label="Settings">
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Project list */}
      <ProjectList onSelect={handleSelectProject} onUnauthorized={onUnauthorized} />
    </div>
  )
}
