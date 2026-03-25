import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { authFetch } from '@/lib/auth'
import { useWs } from '@/hooks/WebSocketContext'
import { FolderOpen, ArrowRight } from 'lucide-react'

interface Project {
  id: string
  name: string
  path: string
  icon: string
  lastActivityAt?: number
}

export function HomePage({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const navigate = useNavigate()
  const { projectStatuses, switchProject } = useWs()
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    authFetch('/api/projects', {}, onUnauthorized)
      .then(res => res.ok ? res.json() : [])
      .then(setProjects)
      .catch(() => {})
  }, [onUnauthorized])

  const handleSelectProject = (p: Project) => {
    switchProject(p.id)
    navigate(`/chat?project=${p.id}`)
  }

  const getStatus = (id: string) =>
    projectStatuses.find(s => s.projectId === id)?.status ?? 'idle'

  return (
    <div className="h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">CodeCrab v2</h1>
          <p className="text-muted-foreground">Select a project to start coding</p>
        </div>

        <div className="space-y-2">
          {projects.map(p => (
            <button
              key={p.id}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors text-left cursor-pointer group"
              onClick={() => handleSelectProject(p)}
            >
              <span className="text-2xl">{p.icon || '📁'}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium flex items-center gap-2">
                  {p.name}
                  {getStatus(p.id) === 'processing' && (
                    <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">{p.path}</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}

          {projects.length === 0 && (
            <div className="text-center py-12 space-y-3">
              <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">No projects configured</p>
              <p className="text-xs text-muted-foreground">
                Set up projects in <code className="bg-muted px-1 rounded">~/.codecrab/projects.json</code>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
