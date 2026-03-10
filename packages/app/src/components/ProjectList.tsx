import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Plus, Trash2, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Project } from '@codeclaws/shared'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface ProjectListProps {
  onSelect: (project: Project) => void
}

export function ProjectList({ onSelect }: ProjectListProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const fetchProjects = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error('Failed to fetch projects')
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProjects()
  }, [])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('Delete this project?')) return
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete project')
      setProjects((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading projects...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-destructive">
        <p className="text-sm">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={fetchProjects}>
          Retry
        </Button>
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-16 h-16 mb-4 rounded-full bg-secondary flex items-center justify-center">
          <FolderOpen className="h-7 w-7 text-muted-foreground" />
        </div>
        <p className="text-base font-medium mb-1">No projects yet</p>
        <p className="text-sm text-muted-foreground mb-6">Create your first project to get started</p>
        <Button onClick={() => navigate('/projects/new')}>
          <Plus className="h-4 w-4" />
          Create Project
        </Button>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelect(project)}
            className="group text-left p-4 rounded-lg border bg-card hover:bg-accent/50 hover:border-foreground/10 transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-2xl shrink-0">
                {project.icon || '📁'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium truncate">{project.name}</h3>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, project.id)}
                    className="shrink-0 p-1 text-muted-foreground/30 hover:text-destructive transition-colors rounded"
                    title="Delete project"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground break-all mt-0.5">{project.path}</p>
                <p className="text-xs text-muted-foreground/60 mt-2">
                  {formatDate(project.updatedAt)}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
