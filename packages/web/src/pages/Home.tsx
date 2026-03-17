import { Search, ChevronRight, FolderOpen, Check } from 'lucide-react'
import { useNavigate } from 'react-router'
import { cn } from '@/lib/utils'
import { projects, tasks } from '@/data/mock'
import { useState } from 'react'
import { useIsDesktop } from '@/hooks/useMediaQuery'

export function Home() {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const [search, setSearch] = useState('')

  const filteredProjects = projects.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  if (isDesktop) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <FolderOpen className="w-16 h-16 text-muted-foreground/20 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-muted-foreground">Select a project</h2>
          <p className="text-sm text-muted-foreground/60 mt-1">
            Choose a project from the sidebar to view its paintings
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-xl shrink-0">
        <div className="px-4 pt-safe-top pb-1">
          <h1 className="text-[28px] font-bold tracking-tight pt-10 pb-1">CodeCrab</h1>
        </div>
      </header>

      <div className="px-4 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-4 rounded-xl bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <section className="px-4 pt-3 pb-2">
        <h2 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Projects
        </h2>
        <div className="space-y-2">
          {filteredProjects.map(project => (
            <button
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="w-full flex items-center gap-3 p-3 rounded-xl bg-card border border-border active:bg-accent transition-colors"
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-semibold shrink-0"
                style={{ backgroundColor: project.color }}
              >
                {project.name.charAt(0)}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="font-medium text-[15px]">{project.name}</div>
                <div className="text-xs text-muted-foreground">{project.description}</div>
              </div>
              <div className="flex items-center gap-1 text-muted-foreground shrink-0">
                <span className="text-xs">{project.paintingCount}</span>
                <ChevronRight className="w-4 h-4" />
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="px-4 py-4">
        <h2 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Tasks
        </h2>
        <div className="rounded-xl bg-card border border-border overflow-hidden divide-y divide-border">
          {tasks.map(task => (
            <div key={task.id} className="flex items-center gap-3 px-3 py-2.5">
              <div
                className={cn(
                  'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0',
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
                  'text-sm flex-1',
                  task.completed && 'line-through text-muted-foreground'
                )}
              >
                {task.title}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
