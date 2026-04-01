// Thread MCP tool definitions for inter-agent communication
//
// Provides 5 tools: send_message, save_artifact, list_threads, get_thread_messages, complete_thread.
// The MessageRouter and per-query context are injected via setters at startup / per-query.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRouter } from '../../../core/message-router.js'

// ── Injected state ─────────────────────────────────────────────────────────

let router: MessageRouter | null = null
let queryContext: { agentId?: string; sessionId?: string } = {}

export function setMessageRouter(r: MessageRouter): void {
  router = r
  console.log(`[threads] MessageRouter registered: ${!!r}`)
}

export function setThreadQueryContext(ctx: { agentId?: string; sessionId?: string }): void {
  queryContext = ctx
}

export function getThreadQueryContext(): { agentId?: string; sessionId?: string } {
  return queryContext
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function notReady() {
  console.error('[threads] ERROR: router is null — thread system not initialized')
  return { content: [{ type: 'text' as const, text: 'Thread system not initialized. The server may need to be restarted.' }], isError: true }
}

function noContext() {
  console.error(`[threads] ERROR: queryContext missing — agentId=${queryContext.agentId} sessionId=${queryContext.sessionId}`)
  return { content: [{ type: 'text' as const, text: `Agent context not available (agentId=${queryContext.agentId || 'undefined'}, sessionId=${queryContext.sessionId || 'undefined'}). This tool can only be used by agents in a collaboration context.` }], isError: true }
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const tools = [
  tool(
    'thread_send_message',
    'Send a message to another agent. Use @name to specify the target, or "broadcast" to send to all participants in the current thread. Set new_thread=true to create an independent sub-thread for this message. Use the artifacts parameter to attach previously saved work artifacts by their IDs (returned from thread_save_artifact).',
    {
      to: z.string().describe('Target: "@agentName" or "broadcast". IMPORTANT: You cannot send messages to yourself — always specify a different agent.'),
      content: z.string().describe('Message content'),
      artifacts: z.array(z.string()).optional().describe('Artifact IDs to attach (from thread_save_artifact)'),
      new_thread: z.boolean().optional().describe('Create a new sub-thread (default: false)'),
      thread_title: z.string().optional().describe('Title for new thread (required when new_thread=true)'),
      wait_for_reply: z.boolean().optional().describe('Block until the target agent finishes processing and goes idle. Use this when you need the result before continuing (default: false).'),
    },
    async (input) => {
      console.log(`[threads] thread_send_message called: to=${input.to} router=${!!router} agentId=${queryContext.agentId} sessionId=${queryContext.sessionId?.slice(0, 20)}`)
      if (!router) return notReady()
      const { agentId, sessionId } = queryContext
      if (!agentId || !sessionId) return noContext()

      try {
        const result = await router.handleSendMessage(agentId, sessionId, {
          to: input.to,
          content: input.content,
          artifacts: input.artifacts,
          new_thread: input.new_thread,
          thread_title: input.thread_title,
          wait_for_reply: input.wait_for_reply,
        })
        console.log(`[threads] thread_send_message success: messageId=${result.messageId} threadId=${result.threadId} status=${result.status}`)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err: any) {
        console.error(`[threads] thread_send_message error: ${err.message}`)
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  tool(
    'thread_save_artifact',
    'Save a work artifact (document, data, etc.) to the current collaboration thread. The artifact is stored on disk and can be referenced by ID in messages. Other agents can read it via the Read tool using the returned path. IMPORTANT: Always include a file extension in the name. Use .md (markdown) for any text documents, reports, analyses, or summaries.',
    {
      name: z.string().describe('File name with extension. Use .md for documents/reports/text (e.g. "report.md", "analysis.md"), .json for structured data, .csv for tabular data, etc.'),
      content: z.string().describe('File content. For .md files, use proper markdown formatting.'),
    },
    async (input) => {
      if (!router) return notReady()
      const { agentId, sessionId } = queryContext
      if (!agentId || !sessionId) return noContext()

      try {
        const result = await router.handleSaveArtifact(agentId, sessionId, {
          name: input.name,
          content: input.content,
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  tool(
    'thread_list_threads',
    'List collaboration threads that this agent is participating in.',
    {
      status: z.string().optional().describe('Filter by status: "active", "completed", or "stalled"'),
    },
    async (input) => {
      if (!router) return notReady()
      const { agentId } = queryContext
      if (!agentId) return noContext()

      const result = router.handleListThreads(agentId, { status: input.status as any })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    },
  ),

  tool(
    'thread_get_messages',
    'Get message history for a specific collaboration thread.',
    {
      threadId: z.string().describe('Thread ID'),
      limit: z.number().optional().describe('Max messages to return (default: 20)'),
    },
    async (input) => {
      if (!router) return notReady()
      const { agentId } = queryContext
      if (!agentId) return noContext()

      const result = router.handleGetThreadMessages(agentId, {
        threadId: input.threadId,
        limit: input.limit,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    },
  ),

  tool(
    'thread_complete_thread',
    'Mark the current collaboration thread as completed. Call this when your work in this thread is done. Optionally provide a summary of what was accomplished.',
    {
      summary: z.string().optional().describe('Summary of what was accomplished'),
    },
    async (input) => {
      if (!router) return notReady()
      const { sessionId } = queryContext
      if (!sessionId) return noContext()

      try {
        const result = await router.handleCompleteThread(sessionId, {
          summary: input.summary,
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),
]
