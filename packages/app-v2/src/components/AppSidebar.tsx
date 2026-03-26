import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { useStore } from '@/store/store'
import { selectProjectStatuses } from '@/store/selectors'
import { authFetch } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { Search, Settings, FolderOpen, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface Project {
  id: string
  name: string
  path: string
  icon: string
}

export function AppSidebar({
  onUnauthorized,
}: {
  onUnauthorized?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { switchProject } = useWs()
  const projectStatuses = useStore(selectProjectStatuses)
  const [projects, setProjects] = useState<Project[]>([])
  const [filter, setFilter] = useState('')
  const currentProjectId = searchParams.get('project')

  const loadProjects = useCallback(async () => {
    try {
      const res = await authFetch('/api/projects', {}, onUnauthorized)
      if (res.ok) {
        setProjects(await res.json())
      }
    } catch { /* ignore */ }
  }, [onUnauthorized])

  // Reload projects on mount and on route changes (e.g. after creating a project)
  useEffect(() => {
    loadProjects()
  }, [loadProjects, location.pathname])

  const filtered = projects.filter(p =>
    p.name.toLowerCase().includes(filter.toLowerCase()),
  )

  const handleSelectProject = (p: Project) => {
    switchProject(p.id)
    navigate(`/chat?project=${p.id}`)
  }

  const getProjectStatus = (id: string) =>
    projectStatuses.find(s => s.projectId === id)?.status ?? 'idle'

  return (
    <aside className="w-56 border-r border-sidebar-border bg-sidebar flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-sidebar-border">
        <h2
          className="font-semibold text-sm text-sidebar-foreground cursor-pointer"
          onClick={() => navigate('/')}
        >
          CodeCrab v2
        </h2>
      </div>

      {/* Search */}
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter projects..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-1">
        {filtered.map(p => {
          const status = getProjectStatus(p.id)
          const isActive = currentProjectId === p.id
          return (
            <button
              key={p.id}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors cursor-pointer',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
              )}
              onClick={() => handleSelectProject(p)}
            >
              <span className="text-base shrink-0">{p.icon || '📁'}</span>
              <span className="truncate flex-1">{p.name}</span>
              {status === 'processing' && (
                <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse shrink-0" />
              )}
            </button>
          )
        })}

        {filtered.length === 0 && projects.length > 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No matching projects</p>
        )}
        {projects.length === 0 && (
          <div className="text-center py-6 space-y-2">
            <FolderOpen className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No projects yet</p>
          </div>
        )}

        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 mt-1 rounded-md text-xs text-muted-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
          onClick={() => navigate('/projects/new')}
        >
          <Plus className="h-3.5 w-3.5" />
          New project
        </button>
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-sidebar-border">
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
          onClick={() => navigate('/settings')}
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </button>
      </div>
    </aside>
  )
}
