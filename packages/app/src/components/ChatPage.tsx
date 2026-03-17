// ChatPage — Main chat interface
import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { MessageList } from './MessageList'
import { InputBar, type InputBarHandle } from './InputBar'
import { QueryQueueBar } from './QueryQueueBar'
import { UserQuestionForm } from './UserQuestionForm'
import { SessionSidebar } from './SessionSidebar'
import { ExecSessionSheet } from './ExecSessionSheet'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Menu, Loader2, Code, ArrowDown } from 'lucide-react'
import { authFetch } from '@/lib/auth'
import type { ImageAttachment, McpInfo, SessionInfo } from '@codeclaws/shared'

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
  const inputBarRef = useRef<InputBarHandle>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [loadingProject, setLoadingProject] = useState(false)
  const [customMcps, setCustomMcps] = useState<McpInfo[]>([])
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set())
  const [lastSession, setLastSession] = useState<SessionInfo | null>(null)
  const [execSessionId, setExecSessionId] = useState<string | null>(null)
  // Track whether we've initialized enabledIds from the first data load
  const initializedRef = useRef(false)
  // Track whether we've already handled the initial session param from the URL
  const initialSessionHandledRef = useRef(false)

  // Fetch custom MCPs (chrome, cron, etc.) on mount
  useEffect(() => {
    authFetch('/api/mcps', {}, onUnauthorized)
      .then((r) => r.json())
      .then((data: McpInfo[]) => {
        const mcps = data.map((m) => ({ ...m, source: 'custom' as const }))
        setCustomMcps(mcps)
        // Enable all custom MCPs by default
        setEnabledIds((prev) => {
          const next = new Set(prev)
          mcps.forEach((m) => next.add(m.id))
          return next
        })
        initializedRef.current = true
      })
      .catch((err) => console.error('Failed to load MCPs:', err))
  }, [onUnauthorized])

  // Build SDK MCP entries from init message
  // Exclude our custom MCP names (they already appear in customMcps) and
  // Claude Code system tools (not user-configurable, should not be toggled)
  const sdkMcpEntries: McpInfo[] = useMemo(() => {
    if (!ws.sdkMcpServers.length) return []
    const customIds = new Set(customMcps.map((m) => m.id))
    return ws.sdkMcpServers
      .filter((s) => s.status === 'connected' && !customIds.has(s.name))
      .map((server) => {
        // Count tools belonging to this server: mcp__<name>__*
        const prefix = `mcp__${server.name}__`
        const serverTools = ws.sdkTools.filter((t) => t.startsWith(prefix))
        return {
          id: `sdk:${server.name}`,
          name: server.name,
          description: `SDK MCP server (${serverTools.length} tools)`,
          icon: '🔌',
          toolCount: serverTools.length,
          source: 'sdk' as const,
          tools: serverTools,
        }
      })
  }, [ws.sdkMcpServers, ws.sdkTools, customMcps])

  // Build skill entries from init message
  const skillEntries: McpInfo[] = useMemo(() => {
    if (!ws.sdkSkills.length) return []
    return ws.sdkSkills.map((skill) => ({
      id: `skill:${skill.name}`,
      name: skill.name,
      description: skill.description || 'Skill',
      icon: '⚡',
      toolCount: 0,
      source: 'skill' as const,
    }))
  }, [ws.sdkSkills])

  // Auto-enable new SDK MCPs and skills when they first appear
  useEffect(() => {
    if (!initializedRef.current) return
    const allNew = [...sdkMcpEntries, ...skillEntries]
    if (allNew.length === 0) return
    setEnabledIds((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const entry of allNew) {
        if (!next.has(entry.id)) {
          next.add(entry.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [sdkMcpEntries, skillEntries])

  // Unified list for the toggle UI
  const allMcps: McpInfo[] = useMemo(
    () => [...customMcps, ...sdkMcpEntries, ...skillEntries],
    [customMcps, sdkMcpEntries, skillEntries],
  )

  const enabledMcpsList = useMemo(() => Array.from(enabledIds), [enabledIds])

  const handleToggleMcp = useCallback((mcpId: string) => {
    setEnabledIds((prev) => {
      const next = new Set(prev)
      if (next.has(mcpId)) {
        next.delete(mcpId)
      } else {
        next.add(mcpId)
      }
      return next
    })
  }, [])

  // Auto-scroll to bottom when messages change or project loads
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [ws.messages, ws.streamingText, ws.streamingThinking, ws.sdkEvents, project?.id])

  // Handle project (and optional session) query params
  useEffect(() => {
    const projectId = searchParams.get('project')
    const sessionParam = searchParams.get('session')
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
          // If URL contains a session param, resume that session on initial load
          if (sessionParam && !initialSessionHandledRef.current) {
            initialSessionHandledRef.current = true
            ws.resumeSession(sessionParam)
          }
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

  // Sync session ID to URL (replaceState to avoid polluting history)
  useEffect(() => {
    if (!project || !ws.sessionId) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('session') !== ws.sessionId) {
      url.searchParams.set('session', ws.sessionId)
      window.history.replaceState(null, '', url.toString())
    }
  }, [project, ws.sessionId])

  // Update document title when project changes
  useEffect(() => {
    if (project) {
      const icon = project.icon || '🚀'
      document.title = `${icon} ${project.name} - CodeClaws`
    } else {
      document.title = 'CodeClaws'
    }
  }, [project])

  // Fetch last session for the empty state (mirrors iOS fetchLastSession)
  useEffect(() => {
    if (!project) return
    authFetch(`/api/sessions?projectId=${project.id}`, {}, onUnauthorized)
      .then((r) => r.json())
      .then((data: SessionInfo[]) => {
        if (Array.isArray(data) && data.length > 0) {
          const sorted = [...data].sort((a, b) => b.lastModified - a.lastModified)
          setLastSession(sorted[0])
        }
      })
      .catch(() => {})
  }, [project, onUnauthorized])

  const showEmptyState = ws.messages.length === 0 && !ws.streamingText && !ws.streamingThinking && !ws.isRunning

  const handleSend = (text: string, images?: ImageAttachment[], mcps?: string[]) => {
    if (text.startsWith('/')) {
      ws.sendCommand(text)
    } else {
      // Separate enabled custom MCPs from disabled SDK servers/skills
      const enabledCustomMcps = mcps?.filter((id) => !id.startsWith('sdk:') && !id.startsWith('skill:'))
      const disabledSdkServers = sdkMcpEntries
        .filter((e) => !enabledIds.has(e.id))
        .map((e) => e.name)
      const disabledSkills = skillEntries
        .filter((e) => !enabledIds.has(e.id))
        .map((e) => e.name)
      ws.sendPrompt(
        text,
        images,
        enabledCustomMcps,
        disabledSdkServers.length ? disabledSdkServers : undefined,
        disabledSkills.length ? disabledSkills : undefined,
      )
    }
  }

  if (loadingProject) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
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
        <span className={`w-1.5 h-1.5 rounded-full ${
          ws.activityHeartbeat
            ? ws.activityHeartbeat.paused
              ? 'bg-yellow-500'
              : 'bg-green-500 animate-pulse'
            : ws.connected ? 'bg-green-500' : 'bg-red-500'
        }`} />
        <span>{ws.connected ? 'Connected' : 'Disconnected'}</span>
        {ws.sessionId && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground font-mono">{ws.sessionId.slice(-6)}</span>
          </>
        )}
        {ws.activityHeartbeat && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground">
              {ws.activityHeartbeat.paused
                ? 'Waiting for input'
                : ws.activityHeartbeat.lastActivityType === 'text_delta'
                  ? 'Streaming'
                  : ws.activityHeartbeat.lastActivityType === 'thinking_delta'
                    ? 'Thinking'
                    : ws.activityHeartbeat.lastActivityType === 'tool_use'
                      ? `Tool: ${ws.activityHeartbeat.lastToolName || 'unknown'}`
                      : ws.activityHeartbeat.lastActivityType === 'tool_result'
                        ? 'Processing result'
                        : 'Working'}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground font-mono">
              {Math.floor(ws.activityHeartbeat.elapsedMs / 60000)}m {Math.floor((ws.activityHeartbeat.elapsedMs % 60000) / 1000)}s
            </span>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 min-w-0">
        {showEmptyState ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="flex flex-col items-center gap-4">
              <Code className="h-10 w-10 text-muted-foreground/30" />
              <div className="text-center">
                <p className="text-xl font-bold">CodeClaws</p>
                <p className="text-sm text-muted-foreground mt-1">Your AI coding companion</p>
              </div>

              {/* Last session card */}
              {lastSession && (
                <button
                  onClick={() => ws.resumeSession(lastSession.sessionId)}
                  className="mt-4 w-full max-w-xs flex items-center gap-3 px-4 py-3 rounded-xl bg-muted hover:bg-muted/80 transition-colors text-left"
                >
                  <span className="text-muted-foreground shrink-0">🕐</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {lastSession.summary || lastSession.firstPrompt || 'Untitled session'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatTimeAgo(lastSession.lastModified)}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground/50">›</span>
                </button>
              )}

              <div className="flex flex-col items-center gap-1.5 mt-4 text-muted-foreground/50">
                <ArrowDown className="h-4 w-4 animate-bounce" />
                <p className="text-xs">Send a message to start a new session</p>
              </div>
            </div>
          </div>
        ) : (
          <MessageList
            messages={ws.messages}
            streamingText={ws.streamingText}
            streamingThinking={ws.streamingThinking}
            isRunning={ws.isRunning}
            sdkEvents={ws.sdkEvents}
            onResumeSession={(sid) => setExecSessionId(sid)}
          />
        )}
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

      {/* User question form */}
      {ws.pendingQuestion && (
        <div className="border-t px-4 py-2 shrink-0">
          <UserQuestionForm
            questions={ws.pendingQuestion.questions}
            onSubmit={ws.submitQuestionResponse}
            onCancel={ws.dismissQuestion}
          />
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

      {/* Suggested replies */}
      {ws.suggestions.length > 0 && !ws.isRunning && (
        <div className="px-4 py-2 flex flex-wrap gap-2 shrink-0">
          {ws.suggestions.map((suggestion, i) => (
            <button
              key={i}
              onClick={() => inputBarRef.current?.setText(suggestion)}
              className="text-xs px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:border-primary/50 transition-colors truncate max-w-[280px]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {/* Query queue */}
      <QueryQueueBar
        items={ws.queryQueue}
        currentSessionId={ws.sessionId}
        onAbort={ws.abort}
        onDequeue={ws.dequeueQuery}
        isAborting={ws.isAborting}
      />

      {/* Input */}
      <InputBar
        ref={inputBarRef}
        onSend={handleSend}
        onAbort={ws.abort}
        isRunning={ws.isRunning}
        isAborting={ws.isAborting}
        disabled={!ws.connected}
        currentModel={ws.currentModel}
        permissionMode={ws.permissionMode}
        onPermissionModeChange={ws.setPermissionMode}
        availableMcps={allMcps}
        enabledMcps={enabledMcpsList}
        onToggleMcp={handleToggleMcp}
        sdkLoaded={ws.sdkLoaded}
        onProbeSdk={ws.probeSdk}
      />

      {/* Session History Sidebar */}
      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} projectId={project?.id} />

      {/* Exec Session Sheet */}
      {execSessionId && (
        <ExecSessionSheet sessionId={execSessionId} onClose={() => setExecSessionId(null)} />
      )}
    </div>
  )
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}
