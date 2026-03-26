import type { ServerMessage } from '@codecrab/shared'
import type { Store } from './types'
import { stripMetaTags } from '@/lib/utils'

type HandlerFn = (msg: any, store: Store) => void

function genId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

const handlers: Record<string, HandlerFn> = {
  query_start: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    if (sessionId) {
      store.updateSession(projectId, sessionId, s => {
        s.status = 'processing'
        s.isStreaming = true
        s.streamingText = ''
        s.streamingThinking = ''
        s.pendingPermission = null
        s.pendingQuestion = null
      })
    }
    store.updateProject(projectId, p => {
      p.isAborting = false
      p.promptPending = false
    })
  },

  stream_delta: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      if (msg.deltaType === 'text') {
        s.streamingText += msg.text
      } else if (msg.deltaType === 'thinking') {
        s.streamingThinking += msg.text
      }
    })
  },

  assistant_text: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    const cleanText = stripMetaTags(msg.text)
    if (!cleanText) return
    store.updateSession(projectId, sessionId, s => {
      const lastMsg = s.messages[s.messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.content !== cleanText) {
        if (lastMsg?.role === 'assistant' && !lastMsg.content && s.isStreaming) {
          lastMsg.content = cleanText
        } else if (!msg.parentToolUseId) {
          s.messages.push({
            id: genId(),
            role: 'assistant',
            content: cleanText,
            timestamp: Date.now(),
          })
        }
      }
      s.streamingText = ''
    })
  },

  thinking: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.streamingThinking = ''
      const lastMsg = s.messages[s.messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        s.messages.push({
          id: genId(),
          role: 'assistant',
          content: '',
          thinking: msg.thinking,
          timestamp: Date.now(),
        })
      } else {
        lastMsg.thinking = msg.thinking
      }
    })
  },

  tool_use: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      let lastMsg = s.messages[s.messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        lastMsg = {
          id: genId(),
          role: 'assistant',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
        }
        s.messages.push(lastMsg)
      }
      if (!lastMsg.toolCalls) lastMsg.toolCalls = []
      lastMsg.toolCalls.push({
        name: msg.toolName,
        id: msg.toolId,
        input: msg.input,
      })
    })
  },

  tool_result: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i]
        if (m.toolCalls) {
          const tc = m.toolCalls.find(t => t.id === msg.toolId)
          if (tc) {
            tc.result = msg.content
            tc.isError = msg.isError
            break
          }
        }
      }
    })
  },

  result: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    if (sessionId) {
      store.updateSession(projectId, sessionId, s => {
        s.isStreaming = false
        s.streamingText = ''
        s.streamingThinking = ''
      })
    }
  },

  query_end: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    if (sessionId) {
      store.updateSession(projectId, sessionId, s => {
        s.activityHeartbeat = null
        if (msg.hasBackgroundTasks && msg.backgroundTaskIds) {
          for (const taskId of msg.backgroundTaskIds) {
            if (!s.backgroundTasks[taskId]) {
              s.backgroundTasks[taskId] = { taskId, status: 'started' }
            }
          }
        }
      })
    }
  },

  query_summary: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.summary = msg.summary
    })
  },

  query_suggestions: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.suggestions = msg.suggestions
    })
  },

  session_id_resolved: (msg, store) => {
    const { projectId, sessionId } = msg
    const tempId = msg.tempSessionId
    if (!projectId || !tempId || !sessionId) return
    console.log(`[store] session_id_resolved: tempId=${tempId} → realId=${sessionId}`)
    store.resolveSessionId(tempId, sessionId)
  },

  session_created: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.getOrCreateSession(projectId, sessionId)
    // If viewing session is still temp/pending, update it
    const project = store.projects[projectId]
    if (project) {
      const vid = project.viewingSessionId
      if (!vid || vid.startsWith('temp-') || vid.startsWith('pending-')) {
        store.setViewingSession(projectId, sessionId)
      }
    }
  },

  session_resumed: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    const project = store.projects[projectId]
    // Don't overwrite if we have a pending prompt or a running session
    if (project?.promptPending) return
    const hasRunning = Object.values(project?.sessions || {}).some(s => s.status === 'processing')
    if (hasRunning) return
    store.setViewingSession(projectId, sessionId)
    if (msg.providerId) {
      store.updateSession(projectId, sessionId, s => {
        s.providerId = msg.providerId
      })
    }
  },

  session_status_changed: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.status = msg.status
    })
  },

  permission_mode_changed: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.permissionMode = msg.mode || 'default'
    })
  },

  provider_changed: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    if (sessionId) {
      store.getOrCreateSession(projectId, sessionId)
      store.updateSession(projectId, sessionId, s => {
        s.providerId = msg.providerId || null
      })
      store.setViewingSession(projectId, sessionId)
    }
  },

  ask_user_question: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.pendingQuestion = {
        toolId: msg.toolId,
        questions: msg.questions,
      }
    })
  },

  permission_request: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.pendingPermission = {
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        reason: msg.reason,
      }
    })
  },

  permission_resolved: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.pendingPermission = null
    })
  },

  question_resolved: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.pendingQuestion = null
    })
  },

  activity_heartbeat: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.activityHeartbeat = {
        queryId: msg.queryId,
        elapsedMs: msg.elapsedMs,
        lastActivityType: msg.lastActivityType,
        lastToolName: msg.lastToolName,
        textSnippet: msg.textSnippet,
        paused: msg.paused,
      }
    })
  },

  session_usage: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.usage = {
        totalInputTokens: msg.totalInputTokens,
        totalOutputTokens: msg.totalOutputTokens,
        totalCacheReadTokens: msg.totalCacheReadTokens,
        totalCacheCreateTokens: msg.totalCacheCreateTokens,
        totalCostUsd: msg.totalCostUsd,
        totalDurationMs: msg.totalDurationMs,
        queryCount: msg.queryCount,
        contextWindowUsed: msg.contextWindowUsed,
        contextWindowMax: msg.contextWindowMax,
      }
    })
  },

  project_statuses: (msg, store) => {
    store.setProjectStatuses(msg.statuses)
  },

  query_queue_status: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    store.updateProject(projectId, p => {
      const existing = p.queryQueue.findIndex(q => q.queryId === msg.queryId)
      const item = {
        queryId: msg.queryId,
        status: msg.status,
        position: msg.position ?? 0,
        prompt: msg.prompt ?? '',
        queryType: msg.queryType ?? 'user' as const,
        sessionId: sessionId ?? undefined,
        cronJobName: msg.cronJobName,
      }
      if (['completed', 'failed', 'timeout', 'cancelled'].includes(msg.status)) {
        if (existing >= 0) p.queryQueue.splice(existing, 1)
      } else if (existing >= 0) {
        p.queryQueue[existing] = item
      } else {
        p.queryQueue.push(item)
      }
    })
  },

  query_queue_snapshot: (msg, store) => {
    const { projectId } = msg
    if (!projectId) return
    store.updateProject(projectId, p => {
      p.queryQueue = msg.items ?? []
    })
  },

  sdk_event: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.sdkEvents.push(msg.event)
    })
  },

  background_task_update: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.backgroundTasks[msg.taskId] = {
        taskId: msg.taskId,
        status: msg.status,
        description: msg.description,
        summary: msg.summary,
        usage: msg.usage,
      }
    })
  },

  user_message: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId || !sessionId) return
    store.updateSession(projectId, sessionId, s => {
      s.messages.push(msg.message)
    })
  },

  error: (msg, store) => {
    const { projectId, sessionId } = msg
    if (!projectId) return
    if (sessionId) {
      store.updateSession(projectId, sessionId, s => {
        s.messages.push({
          id: `err-${Date.now()}`,
          role: 'system',
          content: msg.message,
          timestamp: Date.now(),
        })
        s.isStreaming = false
        s.status = 'idle'
      })
    }
  },

  prompt_received: () => {
    // Sync ack — no action needed
  },
}

export function dispatchMessage(msg: ServerMessage, store: Store): void {
  const handler = handlers[msg.type]
  if (handler) {
    handler(msg, store)
  }
}
