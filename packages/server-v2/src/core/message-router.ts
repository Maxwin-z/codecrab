import type { CoreEngine } from './index.js'
import type { ThreadManager } from './thread.js'
import type { SessionManager } from './session.js'
import type { AgentManager } from './agent-manager.js'
import type {
  Thread, ThreadMessage, AgentRef, ArtifactRef, ThreadStatus,
} from '../types/index.js'
import { tsLog, C } from '../logger.js'

// ── Tool parameter interfaces ─────────────────────────────────────────────

export interface SendMessageParams {
  to: string              // "@agentName" or "broadcast"
  content: string
  artifacts?: string[]    // artifact IDs
  new_thread?: boolean
  thread_title?: string
  /** Block until the target agent finishes processing and returns to idle (default: false) */
  wait_for_reply?: boolean
}

export interface SendMessageResult {
  messageId: string
  threadId: string
  status: 'delivered' | 'queued' | 'thread_stalled'
}

export interface SaveArtifactParams {
  name: string
  content: string
}

export interface SaveArtifactResult {
  artifactId: string
  path: string
}

export interface ListThreadsParams {
  status?: ThreadStatus
}

export interface GetThreadMessagesParams {
  threadId: string
  limit?: number
}

export interface CompleteThreadParams {
  summary?: string
}

export interface CompleteThreadResult {
  threadId: string
  status: 'completed'
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ── MessageRouter ─────────────────────────────────────────────────────────

export class MessageRouter {
  constructor(
    private threads: ThreadManager,
    private sessions: SessionManager,
    private agents: AgentManager,
    private core: CoreEngine,
  ) {}

  // ── send_message ──────────────────────────────────────────────────────

  async handleSendMessage(
    fromAgentId: string,
    fromSessionId: string,
    params: SendMessageParams,
  ): Promise<SendMessageResult> {
    const tag = `${C.magenta}[thread]${C.reset}`
    const fromAgent = this.agents.get(fromAgentId)
    if (!fromAgent) throw new Error(`Agent not found: ${fromAgentId}`)

    const fromRef: AgentRef = { agentId: fromAgentId, agentName: fromAgent.name }

    // 1. Determine thread
    const sessionMeta = this.sessions.getMeta(fromSessionId)
    let thread: Thread | null = null

    if (params.new_thread) {
      // Create child thread
      const parentThreadId = sessionMeta?.threadId || undefined
      if (!params.thread_title) {
        throw new Error('thread_title is required when new_thread=true')
      }
      thread = this.threads.create(params.thread_title, parentThreadId)
      this.core.emit('thread:created', { thread })
      tsLog(`${tag} ${C.green}created${C.reset} thread="${thread.title}" id=${thread.id}`)
    } else if (sessionMeta?.threadId) {
      thread = this.threads.get(sessionMeta.threadId)
    }

    if (!thread) {
      // First send_message without a thread — create root thread
      const title = params.thread_title || `Collaboration ${new Date().toLocaleDateString()}`
      thread = this.threads.create(title)
      this.core.emit('thread:created', { thread })
      tsLog(`${tag} ${C.green}created${C.reset} root thread="${thread.title}" id=${thread.id}`)

      // Bind sender's session to this thread
      if (sessionMeta) {
        this.sessions.update(fromSessionId, { threadId: thread.id })
      }
    }

    // 2. Ensure sender is in thread (unless new_thread with lazy creation)
    if (!params.new_thread) {
      this.threads.addParticipant(thread.id, fromAgentId, fromAgent.name, fromSessionId)
      if (sessionMeta && !sessionMeta.threadId) {
        this.sessions.update(fromSessionId, { threadId: thread.id })
      }
    }

    // 3. Resolve targets
    const targets = this.resolveTargets(params.to, thread, fromAgentId)

    // 4. Check termination
    const termCheck = this.checkTermination(thread)
    if (termCheck.terminated) {
      this.threads.stall(thread.id, termCheck.reason!)
      this.core.emit('thread:stalled', { thread, reason: termCheck.reason! })
      tsLog(`${tag} ${C.red}stalled${C.reset} thread="${thread.title}" reason=${termCheck.reason}`)
      return { messageId: '', threadId: thread.id, status: 'thread_stalled' }
    }

    // 5. Resolve artifact references
    const artifactRefs: ArtifactRef[] = []
    if (params.artifacts?.length) {
      for (const artId of params.artifacts) {
        const art = this.threads.getArtifactById(artId)
        if (art) {
          artifactRefs.push({ id: art.id, name: art.name, path: art.path })
        }
      }
    }

    // 6. Create and save message
    const message: ThreadMessage = {
      id: generateId('msg'),
      threadId: thread.id,
      from: fromRef,
      to: targets.length === 1
        ? { agentId: targets[0].agentId, agentName: targets[0].agentName }
        : 'broadcast',
      content: params.content,
      artifacts: artifactRefs,
      status: 'pending',
      createdAt: Date.now(),
    }
    await this.threads.saveMessage(message)
    this.core.emit('message:sent', { message, threadId: thread.id })

    // 7. Deliver to each target
    for (const target of targets) {
      await this.deliverMessage(message, thread, target, params.wait_for_reply)
    }

    // Update sender's activity
    this.threads.updateParticipantActivity(thread.id, fromAgentId)

    tsLog(`${tag} ${C.blue}sent${C.reset} from=@${fromAgent.name} to=${params.to} thread="${thread.title}"`)

    return { messageId: message.id, threadId: thread.id, status: 'delivered' }
  }

  // ── deliver to single target ──────────────────────────────────────────

  private async deliverMessage(
    message: ThreadMessage,
    thread: Thread,
    target: AgentRef,
    waitForReply = false,
  ): Promise<void> {
    const tag = `${C.magenta}[thread]${C.reset}`

    // Check if target has a session in this thread
    let targetSessionId = this.threads.getParticipantSession(thread.id, target.agentId)

    if (!targetSessionId) {
      // Lazy session creation
      const project = await this.agents.ensureAgentProject(target.agentId)
      const session = this.sessions.create(project.id, project, {
        permissionMode: 'bypassPermissions',
      })
      targetSessionId = `pending-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      this.sessions.register(targetSessionId, session)
      this.sessions.update(targetSessionId, { threadId: thread.id })

      // Add as participant
      this.threads.addParticipant(thread.id, target.agentId, target.agentName, targetSessionId)

      this.core.emit('session:created', {
        projectId: project.id,
        sessionId: targetSessionId,
      })
      tsLog(`${tag} ${C.cyan}session created${C.reset} agent=@${target.agentName} session=${targetSessionId.slice(0, 20)}…`)
    }

    // Increment turn count
    this.threads.incrementTurnCount(thread.id)

    // Update auto-resume count on session
    const sessionMeta = this.sessions.getMeta(targetSessionId)
    if (sessionMeta) {
      this.sessions.update(targetSessionId, {
        autoResumeCount: (sessionMeta.autoResumeCount || 0) + 1,
      })
    }

    // Build resume prompt
    const prompt = this.buildResumePrompt(message, thread)

    // Build thread context for first-time participants
    const systemPromptAppend = this.buildThreadContext(thread, this.threads.getMessages(thread.id))

    // Submit auto-resume turn
    const projectId = this.agents.getProjectId(target.agentId)
    this.core.submitTurn({
      projectId,
      sessionId: targetSessionId,
      prompt,
      type: 'agent',
      metadata: {
        threadId: thread.id,
        fromAgentId: message.from.agentId,
        fromAgentName: message.from.agentName,
        systemPromptAppend,
      },
    })

    // If requested, block until the target agent finishes its turn.
    // This lets coordinator agents await worker results without polling,
    // mirroring the idle-callback pattern from Claude Code's swarm system.
    //
    // We pre-mark the session as 'processing' so that waitForIdle correctly
    // registers a callback and doesn't short-circuit — the newly created
    // session starts as 'idle' by default, but the turn hasn't executed yet.
    if (waitForReply) {
      this.sessions.setStatus(targetSessionId, 'processing')
      tsLog(`${tag} ${C.dim}waiting for @${target.agentName} to become idle…${C.reset}`)
      await this.sessions.waitForIdle(targetSessionId)
      tsLog(`${tag} ${C.dim}@${target.agentName} is idle${C.reset}`)
    }

    // Update message status
    message.status = 'delivered'

    // Emit events
    this.core.emit('message:delivered', {
      message,
      targetAgentId: target.agentId,
      targetSessionId,
    })
    this.core.emit('agent:auto_resume', {
      agentId: target.agentId,
      agentName: target.agentName,
      sessionId: targetSessionId,
      threadId: thread.id,
      threadTitle: thread.title,
      triggeredBy: message.from,
    })
  }

  // ── save_artifact ─────────────────────────────────────────────────────

  async handleSaveArtifact(
    agentId: string,
    sessionId: string,
    params: SaveArtifactParams,
  ): Promise<SaveArtifactResult> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)

    const sessionMeta = this.sessions.getMeta(sessionId)
    const threadId = sessionMeta?.threadId
    if (!threadId) {
      throw new Error('Cannot save artifact: session is not part of a thread. Call send_message first to create a thread.')
    }

    const createdBy: AgentRef = { agentId, agentName: agent.name }
    const artifact = await this.threads.saveArtifact(threadId, params.name, params.content, createdBy)

    return { artifactId: artifact.id, path: artifact.path }
  }

  // ── list_threads ──────────────────────────────────────────────────────

  handleListThreads(agentId: string, params: ListThreadsParams) {
    const threads = this.threads.list({ status: params.status, agentId })
    return {
      threads: threads.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        participants: t.participants.map(p => ({ agentName: p.agentName })),
        messageCount: this.threads.getMessages(t.id).length,
        lastActivity: t.updatedAt,
      })),
    }
  }

  // ── get_thread_messages ───────────────────────────────────────────────

  handleGetThreadMessages(_agentId: string, params: GetThreadMessagesParams) {
    const messages = this.threads.getMessages(params.threadId, params.limit || 20)
    return {
      messages: messages.map(m => ({
        id: m.id,
        from: typeof m.from === 'string' ? m.from : m.from.agentName,
        to: m.to === 'broadcast' ? 'broadcast' : m.to.agentName,
        content: m.content,
        artifacts: m.artifacts,
        timestamp: m.createdAt,
      })),
    }
  }

  // ── complete_thread ───────────────────────────────────────────────────

  async handleCompleteThread(
    sessionId: string,
    params: CompleteThreadParams,
  ): Promise<CompleteThreadResult> {
    const sessionMeta = this.sessions.getMeta(sessionId)
    const threadId = sessionMeta?.threadId
    if (!threadId) {
      throw new Error('Cannot complete thread: session is not part of a thread')
    }

    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    // Save summary as system message if provided
    if (params.summary) {
      const systemMessage: ThreadMessage = {
        id: generateId('msg'),
        threadId,
        from: { agentId: '__system', agentName: 'system' },
        to: 'broadcast',
        content: `[Thread completed] ${params.summary}`,
        artifacts: [],
        status: 'delivered',
        createdAt: Date.now(),
      }
      await this.threads.saveMessage(systemMessage)
    }

    this.threads.complete(threadId)
    this.core.emit('thread:completed', { thread })

    const tag = `${C.magenta}[thread]${C.reset}`
    tsLog(`${tag} ${C.green}completed${C.reset} thread="${thread.title}" id=${thread.id}`)

    return { threadId, status: 'completed' }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private resolveTargets(to: string, thread: Thread, excludeAgentId: string): AgentRef[] {
    if (to === 'broadcast') {
      return thread.participants
        .filter(p => p.agentId !== excludeAgentId)
        .map(p => ({ agentId: p.agentId, agentName: p.agentName }))
    }

    // Parse @name
    const name = to.startsWith('@') ? to.slice(1) : to
    const agent = this.agents.findByName(name)
    if (!agent) throw new Error(`Agent not found: @${name}`)

    // Prevent self-send
    if (agent.id === excludeAgentId) {
      throw new Error(`Cannot send message to yourself (@${name}). Use thread_save_artifact to save work products, or send to another agent.`)
    }

    return [{ agentId: agent.id, agentName: agent.name }]
  }

  private checkTermination(thread: Thread): { terminated: boolean; reason?: string } {
    const turnCount = this.threads.getTurnCount(thread.id)
    if (turnCount >= thread.config.maxTurns) {
      return {
        terminated: true,
        reason: `Thread auto-resume turn count reached limit (${thread.config.maxTurns})`,
      }
    }
    return { terminated: false }
  }

  private buildResumePrompt(message: ThreadMessage, thread: Thread): string {
    const turnCount = this.threads.getTurnCount(thread.id)
    const maxTurns = thread.config.maxTurns
    const remaining = maxTurns - turnCount

    const lines: string[] = []
    lines.push(`[Message from @${message.from.agentName}]`)
    lines.push(`Thread: ${thread.title}`)
    lines.push(`Turn budget: ${turnCount}/${maxTurns} used, ${remaining} remaining`)
    lines.push('')
    lines.push(message.content)

    if (message.artifacts.length > 0) {
      lines.push('')
      lines.push('Attachments:')
      for (const ref of message.artifacts) {
        lines.push(`- ${ref.name}: ${ref.path}`)
      }
    }

    // Urgency hint when turns are running low
    if (remaining <= 3 && remaining > 0) {
      lines.push('')
      lines.push(`⚠ Only ${remaining} turn(s) left. Wrap up discussion and produce deliverables now. Use thread_save_artifact for output and thread_complete_thread when done.`)
    }

    return lines.join('\n')
  }

  private buildThreadContext(thread: Thread, existingMessages: ThreadMessage[]): string {
    const turnCount = this.threads.getTurnCount(thread.id)
    const maxTurns = thread.config.maxTurns
    const remaining = maxTurns - turnCount

    const lines: string[] = []
    lines.push('\n## Current Collaboration Thread')
    lines.push(`- Thread: ${thread.title}`)
    lines.push(`- Participants: ${thread.participants.map(p => `@${p.agentName}`).join(', ')}`)
    lines.push(`- Turn budget: ${turnCount}/${maxTurns} used, ${remaining} remaining`)

    if (thread.parentThreadId) {
      const parent = this.threads.get(thread.parentThreadId)
      if (parent) lines.push(`- Source: ${parent.title}`)
    }

    // Collaboration protocol
    lines.push('')
    lines.push('### Collaboration Protocol')
    lines.push('- Be direct and concise. Skip pleasantries, flattery, and restatements of what the other agent said.')
    lines.push('- Batch all feedback, questions, and responses into a single message — avoid ping-ponging one point at a time.')
    lines.push('- Each message should either (a) provide actionable feedback/decisions, or (b) deliver a concrete work product via thread_save_artifact.')
    lines.push('- When you have enough direction, stop discussing and start producing. Use thread_save_artifact to deliver output.')
    lines.push('- Call thread_complete_thread when the objective is achieved or when you have delivered your final output.')
    if (remaining <= Math.ceil(maxTurns * 0.4)) {
      lines.push(`- ⚠ Budget is running low (${remaining} turns left). Prioritize producing deliverables over further discussion.`)
    }

    if (existingMessages.length > 0) {
      lines.push('')
      lines.push('### Message History')
      for (const msg of existingMessages.slice(-5)) {
        const fromName = typeof msg.from === 'string' ? msg.from : msg.from.agentName
        lines.push(`- @${fromName}: ${msg.content.slice(0, 200)}`)
      }
    }

    return lines.join('\n')
  }
}
