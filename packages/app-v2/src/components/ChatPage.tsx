import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useWs } from '@/hooks/WebSocketContext'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { authFetch } from '@/lib/auth'
import { formatDuration, formatCost } from '@/lib/utils'
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
  defaultModel: string
  defaultPermissionMode: string
}

interface ModelOption {
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
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)

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

  // Load models list
  useEffect(() => {
    authFetch('/api/setup/models', {}, onUnauthorized)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.models) {
          setModels(data.models.map((m: any) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
          })))
          if (data.defaultModelId) {
            setDefaultModelId(data.defaultModelId)
          }
        }
      })
      .catch(() => {})
  }, [onUnauthorized])

  // Handle session param
  useEffect(() => {
    if (projectId && sessionParam) {
      ws.resumeSession(projectId, sessionParam)
    }
  }, [projectId, sessionParam])

  if (!projectId || !project) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Select a project from the sidebar</p>
      </div>
    )
  }

  const ps = ws.getProjectState(projectId)
  const ss = ps.sessionState
  const usage = ps.sessionUsage
  const heartbeat = ps.activityHeartbeat

  const handleSend = (prompt: string, images?: any[]) => {
    ws.sendPrompt(projectId, prompt, { images })
  }

  const handleNewSession = () => {
    const state = ws.getProjectState(projectId)
    state.sessionId = null
    state.sessionState = {
      messages: [],
      sdkEvents: [],
      streamingText: '',
      streamingThinking: '',
      isStreaming: false,
      suggestions: [],
      summary: '',
    }
  }

  const handleSelectSession = (sessionId: string) => {
    ws.resumeSession(projectId, sessionId)
    setSearchParams({ project: projectId, session: sessionId })
    setShowSessions(false)
  }

  const handleModelChange = (modelConfigId: string) => {
    ws.setModel(projectId, modelConfigId)
  }

  const togglePermissionMode = () => {
    if (!ps.sessionId) return
    const newMode = ps.permissionMode === 'bypassPermissions' ? 'default' : 'bypassPermissions'
    ws.setPermissionMode(projectId, ps.sessionId, newMode)
  }

  // Determine current model for display
  const activeModelId = ps.currentModel || project.defaultModel || defaultModelId

  return (
    <div className="h-full flex">
      {/* Session sidebar (toggleable) */}
      {isDesktop && showSessions && (
        <SessionSidebar
          projectId={projectId}
          currentSessionId={ps.sessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onUnauthorized={onUnauthorized}
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

          {/* Model selector */}
          {models.length > 1 && (
            <Select
              value={activeModelId || undefined}
              onValueChange={handleModelChange}
            >
              <SelectTrigger className="h-7 w-auto min-w-[100px] max-w-[180px] border-none shadow-none text-xs text-muted-foreground hover:text-foreground ml-1">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="text-xs">{m.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Activity heartbeat */}
          {heartbeat && ps.isRunning && (
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
            title={ps.permissionMode === 'bypassPermissions' ? 'Bypass mode (click to switch)' : 'Default mode (click to switch)'}
          >
            {ps.permissionMode === 'bypassPermissions' ? (
              <Zap className="h-4 w-4 text-amber-500" />
            ) : (
              <Shield className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </header>

        {/* Messages */}
        <MessageList
          messages={ss.messages}
          isStreaming={ss.isStreaming}
          streamingText={ss.streamingText}
          streamingThinking={ss.streamingThinking}
        />

        {/* Suggestions */}
        {ss.suggestions.length > 0 && !ps.isRunning && (
          <div className="px-4 pb-1 flex gap-2 flex-wrap">
            {ss.suggestions.map((s, i) => (
              <button
                key={i}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer"
                onClick={() => ws.sendPrompt(projectId, s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Permission request */}
        {ps.pendingPermission && ps.sessionId && (
          <PermissionRequestUI
            permission={ps.pendingPermission}
            onAllow={() => ws.respondPermission(ps.sessionId!, ps.pendingPermission!.requestId, true)}
            onDeny={() => ws.respondPermission(ps.sessionId!, ps.pendingPermission!.requestId, false)}
          />
        )}

        {/* User question */}
        {ps.pendingQuestion && ps.sessionId && (
          <UserQuestionForm
            pending={ps.pendingQuestion}
            onSubmit={(answers) => ws.respondQuestion(ps.sessionId!, ps.pendingQuestion!.toolId, answers)}
          />
        )}

        {/* Query queue */}
        <QueryQueueBar
          items={ps.queryQueue}
          onDequeue={ws.dequeue}
          onExecuteNow={ws.executeNow}
        />

        <div>
          <InputBar
            isRunning={ps.isRunning}
            isAborting={ps.isAborting}
            onSend={handleSend}
            onAbort={() => ws.abort(projectId)}
          />
        </div>
      </div>
    </div>
  )
}
