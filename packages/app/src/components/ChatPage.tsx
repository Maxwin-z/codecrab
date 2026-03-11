// ChatPage — Main chat interface
import { useRef, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { SessionSidebar } from './SessionSidebar'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Menu, Loader2 } from 'lucide-react'
import { authFetch } from '@/lib/auth'
import type { ImageAttachment } from '@codeclaws/shared'

interface Project {
  id: string
  name: string
  path: string
  icon?: string
}

interface ChatPageProps {
  onUnauthorized?: () => void
}

export function ChatPage({ onUnauthorized }: ChatPageProps) {
  const ws = useWs()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [loadingProject, setLoadingProject] = useState(false)

  // Auto-scroll to bottom when messages change or project loads
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [ws.messages, ws.streamingText, ws.streamingThinking, project?.id])

  // Handle project query param
  useEffect(() => {
    const projectId = searchParams.get('project')
    if (projectId) {
      setLoadingProject(true)
      authFetch(`/api/projects/${projectId}`, {}, onUnauthorized)
        .then((r) => {
          if (r.status === 401) {
            onUnauthorized?.()
            throw new Error('Unauthorized')
          }
          return r.json()
        })
        .then((data) => {
          if (data.error) throw new Error(data.error)
          setProject(data)
          ws.setProjectId(projectId, data.path)
        })
        .catch((err) => {
          if (err.message !== 'Unauthorized') {
            console.error('Failed to load project:', err)
            navigate('/')
          }
        })
        .finally(() => {
          setLoadingProject(false)
        })
    } else {
      ws.setProjectId(null)
    }
  }, [searchParams, ws.setProjectId, navigate, onUnauthorized])

  // Update document title when project changes
  useEffect(() => {
    if (project) {
      const icon = project.icon || '🚀'
      document.title = `${icon} ${project.name} - CodeClaws`
    } else {
      document.title = 'CodeClaws'
    }
  }, [project])

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    if (text.startsWith('/')) {
      ws.sendCommand(text)
    } else {
      ws.sendPrompt(text, images)
    }
  }

  if (loadingProject) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="shrink-0"
            title="Back to projects"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          {project && (
            <div className="min-w-0 overflow-hidden">
              <div className="flex items-center gap-2">
                <span className="text-lg">{project.icon || '📁'}</span>
                <h2 className="text-sm font-medium truncate">{project.name}</h2>
              </div>
              <p className="text-xs text-muted-foreground truncate max-w-[200px]">{project.path}</p>
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSidebarOpen(true)}
          title="Session history"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </header>

      {/* Connection status */}
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground border-b shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${ws.connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span>{ws.connected ? 'Connected' : 'Disconnected'}</span>
        {ws.sessionId && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground font-mono">{ws.sessionId.slice(-6)}</span>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 min-w-0">
        <MessageList
          messages={ws.messages}
          streamingText={ws.streamingText}
          streamingThinking={ws.streamingThinking}
          isRunning={ws.isRunning}
        />
      </div>

      {/* Summary bar */}
      {ws.latestSummary && (
        <div className="border-t bg-emerald-50 dark:bg-emerald-950/30 px-4 py-2 flex items-center gap-2 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <p className="text-xs text-emerald-700 dark:text-emerald-300 flex-1 min-w-0 truncate">
            {ws.latestSummary}
          </p>
        </div>
      )}

      {/* Permission request dialog */}
      {ws.pendingPermission && (
        <div className="border-t bg-yellow-50 dark:bg-yellow-900/20 px-4 py-3 shrink-0">
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-0.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-600 dark:text-yellow-500">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">Permission Required</p>
              <p className="text-xs text-yellow-700 dark:text-yellow-300/80 mt-0.5">{ws.pendingPermission.reason}</p>
              <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                {ws.pendingPermission.toolName}(
                {typeof ws.pendingPermission.input === 'object'
                  ? JSON.stringify(ws.pendingPermission.input).slice(0, 120)
                  : String(ws.pendingPermission.input)})
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                onClick={() => ws.respondToPermission(ws.pendingPermission!.requestId, false)}
                variant="outline"
                size="sm"
              >
                Deny
              </Button>
              <Button
                onClick={() => ws.respondToPermission(ws.pendingPermission!.requestId, true)}
                size="sm"
              >
                Allow
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <InputBar
        onSend={handleSend}
        onAbort={ws.abort}
        isRunning={ws.isRunning}
        isAborting={ws.isAborting}
        disabled={!ws.connected}
        currentModel={ws.currentModel}
      />

      {/* Session History Sidebar */}
      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} projectId={project?.id} />
    </div>
  )
}
