import { useEffect, useState, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useStore } from '@/store/store'
import { selectConnected, selectViewingSession, selectViewingSessionId, selectProjectState, selectPromptPending, selectIsAborting, selectQueryQueue } from '@/store/selectors'
import { authFetch } from '@/lib/auth'
import { cn, formatDuration, formatCost } from '@/lib/utils'
import { MessageList } from './MessageList'
import { InputBar, type MentionableAgent } from './InputBar'
import { SessionSidebar } from './SessionSidebar'
import { ThreadPanel } from './ThreadPanel'
import { AgentActivityBanner } from './AgentActivityBanner'
import { PermissionRequestUI } from './PermissionRequestUI'
import { UserQuestionForm } from './UserQuestionForm'
import { QueryQueueBar } from './QueryQueueBar'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PanelLeftClose,
  PanelLeft,
  Clock,
  DollarSign,
  Cpu,
  Zap,
  Shield,
  GitBranch,
  Save,
  Pencil,
  Check,
} from 'lucide-react'

interface ProjectInfo {
  id: string
  name: string
  icon: string
  path: string
  defaultProviderId: string
  defaultPermissionMode: string
}

interface ProviderOption {
  id: string
  name: string
  provider: string
}

interface EditingAgent {
  agentId: string
  agentName: string
  agentEmoji: string
  currentClaudeMd: string
}

const EDITOR_PROJECT_PREFIX = '__agent-editor-'

/** Extract <agent-claude-md>...</agent-claude-md> content from messages */
function extractAgentClaudeMd(messages: Array<{ role: string; content: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const match = messages[i].content.match(/<agent-claude-md>([\s\S]*?)<\/agent-claude-md>/)
    if (match) return match[1].trim()
  }
  return null
}

export function ChatPage({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const isDesktop = useIsDesktop()
  const ws = useWs()

  const projectId = searchParams.get('project')
  const sessionParam = searchParams.get('session')

  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const [showThreads, setShowThreads] = useState(false)
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null)
  const [agents, setAgents] = useState<MentionableAgent[]>([])
  const [editingAgent, setEditingAgent] = useState<EditingAgent | null>(null)
  const [editSaved, setEditSaved] = useState(false)
  const editPromptSentRef = useRef<string | null>(null) // tracks projectId for which we sent the initial prompt

  // Detect editor project
  const isEditorProject = projectId?.startsWith(EDITOR_PROJECT_PREFIX) ?? false
  const editingAgentId = isEditorProject ? projectId!.replace(EDITOR_PROJECT_PREFIX, '') : null

  // Store selectors
  const viewingSessionId = useStore(selectViewingSessionId(projectId))
  const session = useStore(selectViewingSession(projectId))
  const promptPending = useStore(selectPromptPending(projectId))
  const isAborting = useStore(selectIsAborting(projectId))
  const queryQueue = useStore(selectQueryQueue(projectId))
  const connected = useStore(selectConnected)

  // Ensure project subscription on WS connect/reconnect
  // (switchProject may be silently dropped if called before WS is open)
  useEffect(() => {
    if (connected && projectId) {
      ws.switchProject(projectId)
    }
  }, [connected, projectId])

  // Load project info
  useEffect(() => {
    if (!projectId) return
    authFetch(`/api/projects/${projectId}`, {}, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setProject(data)
          ws.switchProject(projectId)
        }
      })
      .catch(() => {})
  }, [projectId, onUnauthorized])

  // Load providers list
  useEffect(() => {
    authFetch('/api/setup/providers', {}, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.providers) {
          setProviders(data.providers.map((p: any) => ({
            id: p.id,
            name: p.name,
            provider: p.provider,
          })))
          if (data.defaultProviderId) {
            setDefaultProviderId(data.defaultProviderId)
          }
        }
      })
      .catch(() => {})
  }, [onUnauthorized])

  // Load agents list for @mention
  useEffect(() => {
    authFetch('/api/agents', {}, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (Array.isArray(data)) {
          setAgents(data.map((a: any) => ({ id: a.id, name: a.name, emoji: a.emoji })))
        }
      })
      .catch(() => {})
  }, [onUnauthorized])

  // Load editing context when on an editor project
  useEffect(() => {
    if (!editingAgentId) {
      setEditingAgent(null)
      setEditSaved(false)
      return
    }
    authFetch(`/api/agents/${editingAgentId}/edit`, { method: 'POST' }, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setEditingAgent({
            agentId: data.agentId,
            agentName: data.agentName,
            agentEmoji: data.agentEmoji,
            currentClaudeMd: data.currentClaudeMd,
          })
          setEditSaved(false)
        }
      })
      .catch(() => {})
  }, [editingAgentId, onUnauthorized])

  // Auto-send initial prompt for new editing sessions
  useEffect(() => {
    if (!editingAgent || !connected || !projectId) return
    if (editPromptSentRef.current === projectId) return // already sent for this project

    // Wait a tick for session state to settle
    const timer = setTimeout(() => {
      const state = useStore.getState()
      const proj = state.projects[projectId]
      // Only auto-send if no session or empty session
      if (proj?.viewingSessionId) {
        const sess = proj.sessions[proj.viewingSessionId]
        if (sess?.messages && sess.messages.length > 0) return
      }

      editPromptSentRef.current = projectId
      const prompt = editingAgent.currentClaudeMd
        ? `I want to edit the agent "${editingAgent.agentName}". Here's the current CLAUDE.md:\n\n\`\`\`markdown\n${editingAgent.currentClaudeMd}\n\`\`\``
        : `I want to define a new agent called "${editingAgent.agentName}". Please help me create its CLAUDE.md.`
      ws.sendPrompt(projectId, prompt, { providerId: defaultProviderId || undefined })
    }, 300)
    return () => clearTimeout(timer)
  }, [editingAgent, connected, projectId])

  // Handle session param — only resume if we're not already on that session
  useEffect(() => {
    if (projectId && sessionParam) {
      if (viewingSessionId !== sessionParam) {
        ws.resumeSession(projectId, sessionParam)
      }
    }
  }, [projectId, sessionParam])

  // Sync URL with resolved session ID (temp → real SDK ID)
  useEffect(() => {
    if (!projectId || !viewingSessionId) return
    if (!viewingSessionId.startsWith('temp-') && !viewingSessionId.startsWith('pending-')) {
      const urlSession = searchParams.get('session')
      if (urlSession !== viewingSessionId) {
        setSearchParams({ project: projectId, session: viewingSessionId }, { replace: true })
      }
    }
  }, [projectId, viewingSessionId])

  // Fetch history when viewing a session with no messages
  // (covers tabs that receive session_resumed from server broadcasts)
  useEffect(() => {
    if (!projectId || !viewingSessionId) return
    if (viewingSessionId.startsWith('temp-') || viewingSessionId.startsWith('pending-')) return
    const session = useStore.getState().projects[projectId]?.sessions[viewingSessionId]
    if (session?.messages && session.messages.length > 0) return

    authFetch(`/api/sessions/${viewingSessionId}/history`, {}, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.messages?.length) return
        const currentState = useStore.getState()
        if (currentState.projects[projectId]?.viewingSessionId !== viewingSessionId) return
        currentState.updateSession(projectId, viewingSessionId, s => {
          if (s.messages.length === 0) {
            s.messages = data.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              thinking: m.thinking,
              toolCalls: m.toolCalls,
              images: m.images,
              timestamp: m.timestamp,
            }))
          }
        })
      })
      .catch(() => {})
  }, [projectId, viewingSessionId, onUnauthorized])

  // Detect <agent-claude-md> in messages (must be before early return to preserve hook order)
  const sessionMessages = session?.messages ?? []
  const extractedClaudeMd = useMemo(() => extractAgentClaudeMd(sessionMessages), [sessionMessages])

  if (!projectId || !project) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Select a project from the sidebar</p>
      </div>
    )
  }

  const handleSaveClaudeMd = async () => {
    if (!extractedClaudeMd || !editingAgentId) return
    try {
      const res = await authFetch(`/api/agents/${editingAgentId}/edit/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: extractedClaudeMd }),
      }, onUnauthorized)
      if (res.ok) {
        setEditSaved(true)
      }
    } catch { /* ignore */ }
  }

  // Derive display values from session data
  const messages = session?.messages ?? []
  const isStreaming = session?.isStreaming ?? false
  const streamingText = session?.streamingText ?? ''
  const streamingThinking = session?.streamingThinking ?? ''
  const suggestions = session?.suggestions ?? []
  const usage = session?.usage ?? null
  const heartbeat = session?.activityHeartbeat ?? null
  const isRunning = session?.status === 'processing'
  const permissionMode = session?.permissionMode ?? 'default'
  const pendingPermission = session?.pendingPermission ?? null
  const pendingQuestion = session?.pendingQuestion ?? null

  // Build provider name lookup for session sidebar
  const providerNames = Object.fromEntries(providers.map(p => [p.id, p.name]))

  // Determine current provider for display
  const activeProviderId = session?.providerId || project.defaultProviderId || defaultProviderId
  const hasMessages = messages.length > 0
  const providerLocked = hasMessages || isRunning || promptPending

  const handleSend = (prompt: string, images?: any[]) => {
    ws.sendPrompt(projectId, prompt, { images, providerId: activeProviderId || undefined })
  }

  const handleNewSession = () => {
    ws.newSession(projectId)
    setSearchParams({ project: projectId })
  }

  const handleSelectSession = (sessionId: string) => {
    ws.resumeSession(projectId, sessionId)
    setSearchParams({ project: projectId, session: sessionId })
    setShowSessions(false)
  }

  const handleProviderChange = (providerConfigId: string) => {
    ws.setProvider(projectId, providerConfigId)
  }

  const togglePermissionMode = () => {
    if (!viewingSessionId) return
    const newMode = permissionMode === 'bypassPermissions' ? 'default' : 'bypassPermissions'
    ws.setPermissionMode(projectId, viewingSessionId, newMode)
  }

  return (
    <div className="h-full flex">
      {/* Session sidebar (toggleable) */}
      {isDesktop && showSessions && (
        <SessionSidebar
          projectId={projectId}
          currentSessionId={viewingSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onUnauthorized={onUnauthorized}
          providerNames={providerNames}
        />
      )}

      {/* Thread panel (toggleable) */}
      {isDesktop && showThreads && (
        <ThreadPanel onClose={() => setShowThreads(false)} onUnauthorized={onUnauthorized} />
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 border-b border-border flex items-center px-3 gap-2 shrink-0">
          {isDesktop && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowSessions(!showSessions)}
            >
              {showSessions ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowThreads(!showThreads)}
            title="Toggle thread panel"
          >
            <GitBranch className={cn('h-4 w-4', showThreads && 'text-foreground')} />
          </Button>

          <span className="text-base mr-1">{project.icon || '📁'}</span>
          <span className="font-medium text-sm truncate">{project.name}</span>

          {/* Editing indicator */}
          {editingAgent && (
            <div className="flex items-center gap-1.5 ml-1">
              <Pencil className="h-3 w-3 text-blue-500" />
              <span className="text-xs text-blue-500 font-medium">
                Editing {editingAgent.agentEmoji} {editingAgent.agentName}
              </span>
            </div>
          )}

          {/* Provider selector */}
          {providers.length > 1 && (
            <Select
              value={activeProviderId || undefined}
              onValueChange={handleProviderChange}
              disabled={providerLocked}
            >
              <SelectTrigger
                className={cn(
                  'h-7 w-auto min-w-[100px] max-w-[180px] border-none shadow-none text-xs ml-1',
                  providerLocked
                    ? 'text-muted-foreground/60 cursor-not-allowed'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                title={providerLocked ? 'Provider is locked for this session' : undefined}
              >
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="text-xs">{p.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Activity heartbeat */}
          {heartbeat && isRunning && (
            <div className="flex items-center gap-1.5 ml-2">
              <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
              <span className="text-xs text-muted-foreground">
                {heartbeat.lastToolName || heartbeat.lastActivityType}
                {' '}
                {formatDuration(heartbeat.elapsedMs)}
              </span>
            </div>
          )}

          <div className="flex-1" />

          {/* Session usage */}
          {usage && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {usage.totalCostUsd > 0 && (
                <span className="flex items-center gap-1" title="Total cost">
                  <DollarSign className="h-3 w-3" />
                  {formatCost(usage.totalCostUsd)}
                </span>
              )}
              {usage.totalDurationMs > 0 && (
                <span className="flex items-center gap-1" title="Total duration">
                  <Clock className="h-3 w-3" />
                  {formatDuration(usage.totalDurationMs)}
                </span>
              )}
              {usage.contextWindowMax > 0 && (
                <span className="flex items-center gap-1" title="Context window usage">
                  <Cpu className="h-3 w-3" />
                  {Math.round(usage.contextWindowUsed / usage.contextWindowMax * 100)}%
                </span>
              )}
            </div>
          )}

          {/* Permission mode toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={togglePermissionMode}
            title={permissionMode === 'bypassPermissions' ? 'Bypass mode (click to switch)' : 'Default mode (click to switch)'}
          >
            {permissionMode === 'bypassPermissions' ? (
              <Zap className="h-4 w-4 text-amber-500" />
            ) : (
              <Shield className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </header>

        {/* Agent activity banners */}
        <AgentActivityBanner />

        {/* Messages */}
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          streamingText={streamingText}
          streamingThinking={streamingThinking}
          promptPending={promptPending}
        />

        {/* Suggestions */}
        {suggestions.length > 0 && !isRunning && (
          <div className="px-4 pb-1 flex gap-2 flex-wrap">
            {suggestions.map((s, i) => (
              <button
                key={i}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer"
                onClick={() => ws.sendPrompt(projectId, s, { providerId: activeProviderId || undefined })}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Permission request */}
        {pendingPermission && viewingSessionId && (
          <PermissionRequestUI
            permission={pendingPermission}
            onAllow={() => ws.respondPermission(viewingSessionId!, pendingPermission!.requestId, true)}
            onDeny={() => ws.respondPermission(viewingSessionId!, pendingPermission!.requestId, false)}
          />
        )}

        {/* User question */}
        {pendingQuestion && viewingSessionId && (
          <UserQuestionForm
            pending={pendingQuestion}
            onSubmit={(answers) => ws.respondQuestion(viewingSessionId!, pendingQuestion!.toolId, answers)}
            onDismiss={() => ws.dismissQuestion(viewingSessionId!, pendingQuestion!.toolId)}
          />
        )}

        {/* Query queue */}
        <QueryQueueBar
          items={queryQueue}
          onDequeue={ws.dequeue}
          onExecuteNow={ws.executeNow}
        />

        {/* Agent CLAUDE.md save banner */}
        {editingAgent && extractedClaudeMd && !isRunning && (
          <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center gap-2">
            {editSaved ? (
              <>
                <Check className="h-4 w-4 text-green-500 shrink-0" />
                <span className="text-sm text-green-600">
                  CLAUDE.md saved for {editingAgent.agentEmoji} {editingAgent.agentName}
                </span>
              </>
            ) : (
              <>
                <Save className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="text-sm text-muted-foreground flex-1">
                  Agent definition ready to save
                </span>
                <Button size="sm" className="h-7 text-xs" onClick={handleSaveClaudeMd}>
                  Save to {editingAgent.agentEmoji} {editingAgent.agentName}
                </Button>
              </>
            )}
          </div>
        )}

        <div>
          <InputBar
            isRunning={isRunning}
            isAborting={isAborting}
            agents={agents}
            onSend={handleSend}
            onAbort={() => ws.abort(projectId)}
          />
        </div>
      </div>
    </div>
  )
}
