// executeChannelQuery — bridge between channel plugins and the engine query pipeline
//
// Creates independent query execution path that:
// 1. Enqueues through the shared QueryQueue
// 2. Calls plugin callbacks for platform-specific responses
// 3. Broadcasts events to WS clients (like cron does)

import type {
  ChannelPlugin,
  ChannelConfig,
  ChannelEngineContext,
  ChannelPromptParams,
  ChannelQueryResult,
  ConversationState,
} from './types.js'
import type { Question } from '@codecrab/shared'

function autoSelectFirstOptions(questions: Question[]): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {}
  for (const q of questions) {
    if (q.options.length > 0) {
      if (q.multiSelect) {
        answers[q.question] = [q.options[0].label]
      } else {
        answers[q.question] = q.options[0].label
      }
    }
  }
  return answers
}

export async function executeChannelQuery(
  params: ChannelPromptParams,
  plugin: ChannelPlugin,
  config: ChannelConfig,
  engine: ChannelEngineContext,
  conversation: ConversationState,
): Promise<ChannelQueryResult> {
  const { projectId, prompt, conversationId, images } = params
  const sessionId = conversation.sessionId

  const projState = engine.getOrCreateProjectState(projectId)
  const channelClientId = `channel-${config.instanceId}-${conversationId}`
  const clientState = engine.createClientState(channelClientId, projectId, projState.cwd)

  // Set permission mode based on interactive mode
  if (config.interactiveMode === 'auto_allow') {
    clientState.permissionMode = 'bypassPermissions'
  }

  const { queryId, promise } = engine.queryQueue.enqueue({
    type: 'channel' as any,
    projectId,
    sessionId,
    prompt,
    priority: 0, // Same priority as user queries
    metadata: {
      channelId: config.id,
      channelInstanceId: config.instanceId,
      conversationId,
    },
    executor: async (queuedQuery) => {
      const startTime = Date.now()
      let fullText = ''
      let costUsd: number | undefined
      let durationMs: number | undefined

      try {
        // Notify plugin and WS clients of query start
        plugin.onQueryStart(conversationId, queuedQuery.id)
        engine.broadcastToProject(projectId, {
          type: 'query_start',
          queryId: queuedQuery.id,
          projectId,
          sessionId,
        })

        const stream = engine.executeQuery(
          clientState,
          prompt,
          {
            onTextDelta: (text) => {
              fullText += text
              engine.queryQueue.touchActivity(queuedQuery.id, 'text_delta', undefined, text.slice(0, 50))

              if (config.responseMode === 'streaming') {
                plugin.onTextDelta(conversationId, text)
              }

              engine.broadcastToProject(projectId, {
                type: 'stream_delta',
                deltaType: 'text',
                text,
                projectId,
                sessionId,
              })
            },
            onThinkingDelta: (_thinking) => {
              engine.queryQueue.touchActivity(queuedQuery.id, 'thinking_delta')
              engine.broadcastToProject(projectId, {
                type: 'stream_delta',
                deltaType: 'thinking',
                text: _thinking,
                projectId,
                sessionId,
              })
            },
            onToolUse: (toolName, toolId, input) => {
              engine.queryQueue.touchActivity(queuedQuery.id, 'tool_use', toolName)
              plugin.onToolUse(conversationId, toolName, toolId)
              engine.broadcastToProject(projectId, {
                type: 'tool_use',
                toolName,
                toolId,
                input,
                projectId,
                sessionId,
              })
            },
            onToolResult: (toolId, content, isError) => {
              engine.queryQueue.touchActivity(queuedQuery.id, 'tool_result')
              const preview = content.length > 300
                ? content.slice(0, 300) + `... (${content.length} chars total)`
                : content
              plugin.onToolResult(conversationId, toolId, preview, isError)
              engine.broadcastToProject(projectId, {
                type: 'tool_result',
                toolId,
                content: preview,
                isError,
                projectId,
                sessionId,
              })
            },
            onSessionInit: (sdkSessionId) => {
              // Store SDK session ID on client state if needed
              clientState.sessionId = sdkSessionId
            },
            onPermissionRequest: (requestId, toolName, input, reason) => {
              if (config.interactiveMode === 'auto_allow') {
                engine.handlePermissionResponse(clientState, requestId, true)
              } else if (config.interactiveMode === 'auto_deny') {
                engine.handlePermissionResponse(clientState, requestId, false)
              } else {
                // Forward to plugin and WS clients
                engine.queryQueue.pauseTimeout(queuedQuery.id)
                plugin.onPermissionRequest(conversationId, requestId, toolName, input, reason)
                engine.broadcastToProject(projectId, {
                  type: 'permission_request',
                  requestId,
                  toolName,
                  input,
                  reason,
                  projectId,
                  sessionId,
                })
              }
            },
            onAskUserQuestion: (toolId, questions) => {
              if (config.interactiveMode === 'forward') {
                engine.queryQueue.pauseTimeout(queuedQuery.id)
                plugin.onAskUserQuestion(conversationId, toolId, questions as Question[])
                engine.broadcastToProject(projectId, {
                  type: 'ask_user_question',
                  toolId,
                  questions,
                  projectId,
                  sessionId,
                })
              } else if (config.interactiveMode === 'auto_allow') {
                const answers = autoSelectFirstOptions(questions as Question[])
                engine.handleQuestionResponse(clientState, answers)
              } else {
                // auto_deny: skip with empty answers
                engine.handleQuestionResponse(clientState, {})
              }
            },
            onUsage: (usage) => {
              // Accumulate usage for cost tracking if needed
            },
          },
          images,
        )

        // Consume the stream
        for await (const event of stream) {
          if (event.type === 'result') {
            const data = event.data as { costUsd?: number; durationMs?: number } | undefined
            costUsd = data?.costUsd
            durationMs = data?.durationMs
          }
        }

        // Store the assistant message
        engine.storeAssistantMessage(clientState)

        durationMs = durationMs || (Date.now() - startTime)

        // Notify plugin of final result
        plugin.onResult(conversationId, fullText, costUsd, durationMs)

        // Broadcast result to WS clients
        engine.broadcastToProject(projectId, {
          type: 'result',
          subtype: 'success',
          costUsd,
          durationMs,
          projectId,
          sessionId,
        })

        engine.broadcastToProject(projectId, {
          type: 'query_end',
          queryId: queuedQuery.id,
          projectId,
          sessionId,
        })

        return {
          success: true,
          output: fullText,
          queryId: queuedQuery.id,
        }
      } catch (err: any) {
        const errorMsg = err.message || String(err)
        plugin.onError(conversationId, errorMsg)
        engine.broadcastToProject(projectId, {
          type: 'error',
          message: errorMsg,
          projectId,
          sessionId,
        })

        return {
          success: false,
          error: errorMsg,
          queryId: queuedQuery.id,
        }
      }
    },
  })

  const result = await promise

  return {
    success: result.success,
    queryId: result.queryId,
    output: result.output,
    error: result.error,
    costUsd: undefined,
    durationMs: undefined,
  }
}
