import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Plus, Trash2, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { authFetch } from '@/lib/auth'
import { useWs } from '@/hooks/WebSocketContext'
import type { Project } from '@codecrab/shared'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface ProjectListProps {
  onSelect: (project: Project) => void
  onDoubleClick?: (project: Project) => void
  onUnauthorized?: () => void
}

export function ProjectList({ onSelect, onDoubleClick, onUnauthorized }: ProjectListProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { projectStatuses } = useWs()

  const SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

  const getProjectStatus = (projectId: string) =>
    projectStatuses.find((s) => s.projectId === projectId)

  const isProjectActive = (projectId: string) => {
    const status = getProjectStatus(projectId)
    if (!status) return false
    if (status.status === 'processing') return true
    if (status.lastModified && (Date.now() - status.lastModified) < SESSION_ACTIVE_THRESHOLD_MS) return true
    return false
  }

  const fetchProjects = async () => {
    try {
      setLoading(true)
      const res = await authFetch('/api/projects', {}, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
      if (!res.ok) throw new Error('Failed to fetch projects')
      const data = await res.json()
      // Filter out internal projects (e.g. __soul__)
      setProjects(data.filter((p: Project) => !p.id.startsWith('__')))
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
      const res = await authFetch(`/api/projects/${id}`, { method: 'DELETE' }, onUnauthorized)
      if (res.status === 401) {
        onUnauthorized?.()
        return
      }
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
        {projects.map((project) => {
          const status = getProjectStatus(project.id)
          const isProcessing = status?.status === 'processing'
          const isActive = isProjectActive(project.id)
          return (
            <div
              key={project.id}
              onClick={() => onSelect(project)}
              onDoubleClick={() => onDoubleClick?.(project)}
              className={`group text-left p-4 rounded-lg border bg-card hover:bg-accent/50 hover:border-foreground/10 transition-colors cursor-pointer ${isProcessing ? 'border-amber-500/40' : isActive ? 'border-emerald-500/40' : ''}`}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-2xl shrink-0 relative">
                  {project.icon || '📁'}
                  {isProcessing && (
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
                    </span>
                  )}
                  {!isProcessing && isActive && (
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
                    </span>
                  )}
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
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-muted-foreground/60">
                      {formatDate(project.lastActivityAt ?? project.updatedAt)}
                    </p>
                    {isProcessing ? (
                      <span className="text-xs text-amber-500 font-medium">Running</span>
                    ) : isActive ? (
                      <span className="text-xs text-emerald-500 font-medium">Active</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
