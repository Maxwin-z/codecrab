import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { useStore } from '@/store/store'
import { selectProjectStatuses, selectThreads } from '@/store/selectors'
import { authFetch } from '@/lib/auth'
import { fetchThreads } from '@/lib/threads'
import { cn } from '@/lib/utils'
import type { ThreadInfo } from '@/store/types'
import { Search, Settings, FolderOpen, Plus, ChevronRight, Pencil, MessageCircle, Sun, Moon } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Input } from '@/components/ui/input'
import { CreateAgentDialog } from '@/components/CreateAgentDialog'

interface Project {
  id: string
  name: string
  path: string
  icon: string
}

interface Agent {
  id: string
  name: string
  emoji: string
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
  const storeThreads = useStore(selectThreads)
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [restThreads, setRestThreads] = useState<ThreadInfo[]>([])
  const [filter, setFilter] = useState('')
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [agentsCollapsed, setAgentsCollapsed] = useState(false)
  const [threadsCollapsed, setThreadsCollapsed] = useState(false)
  const [showCreateAgent, setShowCreateAgent] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const { theme, toggleTheme } = useTheme()
  const currentProjectId = searchParams.get('project')
  const currentThreadId = searchParams.get('id')

  const loadData = useCallback(async () => {
    try {
      const [projectsRes, agentsRes, threads] = await Promise.all([
        authFetch('/api/projects', {}, onUnauthorized),
        authFetch('/api/agents', {}, onUnauthorized),
        fetchThreads(undefined, onUnauthorized),
      ])
      if (projectsRes.ok) {
        const all: Project[] = await projectsRes.json()
        // Filter out internal agent projects (prefixed with __)
        setProjects(all.filter(p => !p.id.startsWith('__')))
      }
      if (agentsRes.ok) {
        setAgents(await agentsRes.json())
      }
      setRestThreads(threads)
    } catch { /* ignore */ }
  }, [onUnauthorized])

  // Reload on mount and on route changes (e.g. after creating a project/agent)
  useEffect(() => {
    loadData()
  }, [loadData, location.pathname])

  const filterLower = filter.toLowerCase()
  const filteredProjects = projects.filter(p =>
    p.name.toLowerCase().includes(filterLower),
  )
  const filteredAgents = agents.filter(a =>
    a.name.toLowerCase().includes(filterLower),
  )

  const handleSelectProject = (p: Project) => {
    switchProject(p.id)
    navigate(`/chat?project=${p.id}`)
  }

  const handleSelectAgent = async (agent: Agent) => {
    try {
      const res = await authFetch(`/api/agents/${agent.id}/use`, { method: 'POST' }, onUnauthorized)
      if (res.ok) {
        const project = await res.json()
        switchProject(project.id)
        navigate(`/chat?project=${project.id}`)
      }
    } catch { /* ignore */ }
  }

  const handleEditAgent = async (e: React.MouseEvent, agent: Agent) => {
    e.stopPropagation()
    try {
      const res = await authFetch(`/api/agents/${agent.id}/edit`, { method: 'POST' }, onUnauthorized)
      if (res.ok) {
        const data = await res.json()
        switchProject(data.projectId)
        navigate(`/chat?project=${data.projectId}`)
      }
    } catch { /* ignore */ }
  }

  const getProjectStatus = (id: string) =>
    projectStatuses.find(s => s.projectId === id)?.status ?? 'idle'

  // Check if an agent's internal project is currently active
  const isAgentActive = (agentId: string) =>
    currentProjectId === `__agent-${agentId}`

  const getAgentStatus = (agentId: string) =>
    getProjectStatus(`__agent-${agentId}`)

  // Merge REST threads with real-time store threads (store wins)
  const mergedThreads = (() => {
    const map = new Map<string, ThreadInfo>()
    for (const t of restThreads) map.set(t.id, t)
    for (const t of storeThreads) map.set(t.id, t)
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  })()

  const filteredThreads = mergedThreads.filter(t =>
    t.title.toLowerCase().includes(filterLower),
  )

  const handleSelectThread = (thread: ThreadInfo) => {
    navigate(`/thread?id=${thread.id}`)
  }

  const totalFiltered = filteredProjects.length + filteredAgents.length + filteredThreads.length
  const hasData = projects.length > 0 || agents.length > 0 || mergedThreads.length > 0

  return (
    <aside className="w-56 border-r border-sidebar-border bg-sidebar flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-sidebar-border flex items-center justify-between">
        <h2
          className="font-semibold text-sm text-sidebar-foreground cursor-pointer"
          onClick={() => navigate('/')}
        >
          CodeCrab v2
        </h2>
        <div
          ref={addMenuRef}
          className="relative"
          onMouseEnter={() => setShowAddMenu(true)}
          onMouseLeave={() => setShowAddMenu(false)}
        >
          <button
            className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors cursor-pointer"
            title="New..."
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {showAddMenu && (
            <div className="absolute right-0 top-full z-50 w-36 pt-1">
            <div className="rounded-md border border-sidebar-border bg-sidebar shadow-md py-1">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors cursor-pointer"
                onClick={() => { setShowAddMenu(false); setShowCreateAgent(true) }}
              >
                <span>🤖</span>
                New Agent
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors cursor-pointer"
                onClick={() => { setShowAddMenu(false); navigate('/projects/new') }}
              >
                <span>📁</span>
                New Project
              </button>
            </div>
            </div>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto px-1">
        {/* Agents section */}
        {(filteredAgents.length > 0 || !filter) && (
          <div>
            <button
              className="w-full flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-sidebar-foreground transition-colors cursor-pointer"
              onClick={() => setAgentsCollapsed(!agentsCollapsed)}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', !agentsCollapsed && 'rotate-90')} />
              Agents
              <span className="text-muted-foreground/60 ml-auto">{filteredAgents.length}</span>
            </button>

            {!agentsCollapsed && (
              <>
                {filteredAgents.map(a => {
                  const active = isAgentActive(a.id)
                  const status = getAgentStatus(a.id)
                  return (
                    <div key={a.id} className="group relative">
                      <button
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors cursor-pointer',
                          active
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
                        )}
                        onClick={() => handleSelectAgent(a)}
                      >
                        <span className="text-base shrink-0">{a.emoji || '🤖'}</span>
                        <span className="truncate flex-1">{a.name}</span>
                        {status === 'processing' && (
                          <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse shrink-0" />
                        )}
                      </button>
                      <button
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/80 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        onClick={e => handleEditAgent(e, a)}
                        title="Edit agent definition"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}

        {/* Projects section */}
        {(filteredProjects.length > 0 || !filter) && (
          <div className="mt-1">
            <button
              className="w-full flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-sidebar-foreground transition-colors cursor-pointer"
              onClick={() => setProjectsCollapsed(!projectsCollapsed)}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', !projectsCollapsed && 'rotate-90')} />
              Projects
              <span className="text-muted-foreground/60 ml-auto">{filteredProjects.length}</span>
            </button>

            {!projectsCollapsed && (
              <>
                {filteredProjects.map(p => {
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
              </>
            )}
          </div>
        )}

        {/* Threads section */}
        {(filteredThreads.length > 0 || !filter) && mergedThreads.length > 0 && (
          <div className="mt-1">
            <button
              className="w-full flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-sidebar-foreground transition-colors cursor-pointer"
              onClick={() => setThreadsCollapsed(!threadsCollapsed)}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', !threadsCollapsed && 'rotate-90')} />
              Threads
              <span className="text-muted-foreground/60 ml-auto">{filteredThreads.length}</span>
            </button>

            {!threadsCollapsed && (
              <>
                {filteredThreads.map(t => {
                  const isActive = location.pathname === '/thread' && currentThreadId === t.id
                  return (
                    <button
                      key={t.id}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors cursor-pointer',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
                      )}
                      onClick={() => handleSelectThread(t)}
                    >
                      <MessageCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{t.title}</span>
                      {t.status === 'active' && (
                        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                      )}
                      {t.status === 'stalled' && (
                        <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                      )}
                      {t.status === 'completed' && (
                        <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}

        {totalFiltered === 0 && hasData && (
          <p className="text-xs text-muted-foreground text-center py-4">No matches</p>
        )}
        {!hasData && (
          <div className="text-center py-6 space-y-2">
            <FolderOpen className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No projects or agents yet</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-sidebar-border flex items-center">
        <button
          className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
          onClick={() => navigate('/settings')}
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </button>
        <button
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      </div>

      <CreateAgentDialog
        open={showCreateAgent}
        onOpenChange={setShowCreateAgent}
        onCreated={() => loadData()}
        onUnauthorized={onUnauthorized}
      />
    </aside>
  )
}
