import { useState, useEffect } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router'
import { Search, Brain, Clock, MessageSquare, Settings, Plus, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { authFetch } from '@/lib/auth'
import { useWs } from '@/hooks/WebSocketContext'
import type { Project } from '@codecrab/shared'

interface AppSidebarProps {
  onOpenSetup: () => void
  onUnauthorized?: () => void
}

export function AppSidebar({ onOpenSetup, onUnauthorized }: AppSidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [search, setSearch] = useState('')
  const { projectStatuses } = useWs()

  const currentProjectId = searchParams.get('project')

  const fetchProjects = () => {
    authFetch('/api/projects', {}, onUnauthorized)
      .then(r => r.json())
      .then(data => setProjects(data.filter((p: Project) => !p.id.startsWith('__'))))
      .catch(() => {})
  }

  useEffect(() => {
    fetchProjects()
  }, [])

  // Refresh project list when navigating (e.g. after creating a project)
  useEffect(() => {
    fetchProjects()
  }, [location.pathname])

  const filteredProjects = projects.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const getProjectStatus = (projectId: string) =>
    projectStatuses.find(s => s.projectId === projectId)

  const isProjectActive = (projectId: string) => {
    const status = getProjectStatus(projectId)
    if (!status) return false
    if (status.status === 'processing') return true
    if (status.lastModified && (Date.now() - status.lastModified) < 10 * 60 * 1000) return true
    return false
  }

  const navItems = [
    { label: 'SOUL', icon: Brain, path: '/soul' },
    { label: 'Cron', icon: Clock, path: '/cron' },
    { label: 'Channels', icon: MessageSquare, path: '/channels' },
  ]

  return (
    <aside className="w-72 h-full flex flex-col border-r bg-sidebar text-sidebar-foreground shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <button onClick={() => navigate('/')} className="text-lg font-bold tracking-tight hover:opacity-80 transition-opacity">
          CodeCrab
        </button>
        <button
          onClick={onOpenSetup}
          className="p-1.5 rounded-lg hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-8 pl-8 pr-3 rounded-lg bg-sidebar-accent text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sidebar-ring"
          />
        </div>
      </div>

      {/* Nav items */}
      <div className="px-2 space-y-0.5">
        {navItems.map(item => {
          const Icon = item.icon
          const isActive = location.pathname === item.path
          return (
            <button
              key={item.label}
              onClick={() => navigate(item.path)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-sidebar-accent/50'
              )}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          )
        })}
      </div>

      {/* Divider */}
      <div className="mx-3 my-2 border-t border-sidebar-border" />

      {/* Projects header */}
      <div className="flex items-center justify-between px-4 py-1">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Projects
        </h2>
        <button
          onClick={() => navigate('/projects/new')}
          className="p-1 rounded hover:bg-sidebar-accent/50 text-muted-foreground hover:text-sidebar-foreground transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <nav className="space-y-0.5">
          {filteredProjects.map(project => {
            const status = getProjectStatus(project.id)
            const isProcessing = status?.status === 'processing'
            const isActive = isProjectActive(project.id)
            const isSelected = currentProjectId === project.id

            return (
              <button
                key={project.id}
                onClick={() => navigate(`/chat?project=${encodeURIComponent(project.id)}`)}
                className={cn(
                  'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm text-left transition-colors',
                  isSelected
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent/50'
                )}
              >
                <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-base shrink-0 relative">
                  {project.icon || <FolderOpen className="w-4 h-4 text-muted-foreground" />}
                  {isProcessing && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                    </span>
                  )}
                  {!isProcessing && isActive && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{project.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{project.path}</div>
                </div>
              </button>
            )
          })}
          {filteredProjects.length === 0 && !search && (
            <div className="px-3 py-6 text-center">
              <FolderOpen className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No projects yet</p>
            </div>
          )}
          {filteredProjects.length === 0 && search && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              No matching projects
            </p>
          )}
        </nav>
      </div>
    </aside>
  )
}
