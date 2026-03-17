import { Search, Check } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router'
import { cn } from '@/lib/utils'
import { projects, tasks } from '@/data/mock'
import { useState } from 'react'

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')

  const match = location.pathname.match(/^\/projects\/([^/]+)/)
  const selectedProjectId = match ? match[1] : null

  const filteredProjects = projects.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const pendingCount = tasks.filter(t => !t.completed).length

  return (
    <aside className="w-72 h-full flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shrink-0">
      <div className="px-4 pt-4 pb-1">
        <h1 className="text-xl font-bold tracking-tight">CodeCrab</h1>
      </div>

      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-8 pl-8 pr-3 rounded-lg bg-sidebar-accent text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sidebar-ring"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <div className="px-2 py-2">
          <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Projects</h2>
        </div>
        <nav className="space-y-0.5">
          {filteredProjects.map(project => (
            <button
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className={cn(
                'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm text-left transition-colors',
                selectedProjectId === project.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-sidebar-accent/50'
              )}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-semibold shrink-0"
                style={{ backgroundColor: project.color }}
              >
                {project.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{project.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {project.paintingCount} paintings
                </div>
              </div>
            </button>
          ))}
        </nav>
      </div>

      <div className="border-t border-sidebar-border px-2 py-2 shrink-0">
        <div className="px-2 py-1.5">
          <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Tasks <span className="opacity-60">({pendingCount})</span>
          </h2>
        </div>
        <div className="space-y-0.5 max-h-44 overflow-y-auto">
          {tasks.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
            >
              <div
                className={cn(
                  'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                  task.completed
                    ? 'bg-primary border-primary'
                    : 'border-muted-foreground/30'
                )}
              >
                {task.completed && (
                  <Check className="w-3 h-3 text-primary-foreground" />
                )}
              </div>
              <span
                className={cn(
                  'truncate',
                  task.completed && 'line-through text-muted-foreground'
                )}
              >
                {task.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
