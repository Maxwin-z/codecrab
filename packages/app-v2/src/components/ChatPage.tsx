import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useStore } from '@/store/store'
import { selectViewingSession, selectViewingSessionId, selectProjectState, selectPromptPending, selectIsAborting, selectQueryQueue } from '@/store/selectors'
import { authFetch } from '@/lib/auth'
import { cn, formatDuration, formatCost } from '@/lib/utils'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { SessionSidebar } from './SessionSidebar'
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

export function ChatPage({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const isDesktop = useIsDesktop()
  const ws = useWs()

  const projectId = searchParams.get('project')
  const sessionParam = searchParams.get('session')

  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null)

  // Store selectors
  const viewingSessionId = useStore(selectViewingSessionId(projectId))
  const session = useStore(selectViewingSession(projectId))
  const promptPending = useStore(selectPromptPending(projectId))
  const isAborting = useStore(selectIsAborting(projectId))
  const queryQueue = useStore(selectQueryQueue(projectId))

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

  if (!projectId || !project) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Select a project from the sidebar</p>
      </div>
    )
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

          <span className="text-base mr-1">{project.icon || '📁'}</span>
          <span className="font-medium text-sm truncate">{project.name}</span>

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
          />
        )}

        {/* Query queue */}
        <QueryQueueBar
          items={queryQueue}
          onDequeue={ws.dequeue}
          onExecuteNow={ws.executeNow}
        />

        <div>
          <InputBar
            isRunning={isRunning}
            isAborting={isAborting}
            onSend={handleSend}
            onAbort={() => ws.abort(projectId)}
          />
        </div>
      </div>
    </div>
  )
}
