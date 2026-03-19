// TelegramChannelPlugin — grammY-based Telegram bot implementation

import { Bot } from 'grammy'
import type {
  ChannelPlugin,
  ChannelContext,
  ChannelConfig,
  ChannelStatus,
  ChannelHealthResult,
} from '../types.js'
import type { Question, ImageAttachment } from '@codecrab/shared'
import { registerCommands, setMenuCommands } from './commands.js'
import { formatForTelegram, splitMessage, formatToolUse, formatError, formatResult } from './formatter.js'
import * as store from '../store.js'
import type { ConversationState } from '../types.js'

// Pending interaction state machine
type PendingInteraction =
  | { type: 'question'; toolId: string; questions: Question[]; timeout: NodeJS.Timeout }
  | { type: 'permission'; requestId: string; timeout: NodeJS.Timeout }

const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Response buffer for streaming mode — edits a single Telegram message */
class ResponseBuffer {
  private buffer = ''
  private messageId: number | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private bot: Bot
  private chatId: string | number
  private readonly FLUSH_INTERVAL = 2000
  private readonly MAX_LENGTH = 4000
  private flushing = false

  constructor(bot: Bot, chatId: string | number) {
    this.bot = bot
    this.chatId = chatId
  }

  append(text: string): void {
    this.buffer += text
    if (this.buffer.length >= this.MAX_LENGTH) {
      this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL)
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.buffer) return
    this.flushing = true

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const text = this.buffer
    try {
      if (this.messageId) {
        // Edit existing message
        try {
          await this.bot.api.editMessageText(this.chatId, this.messageId, text)
        } catch {
          // If edit fails (e.g., content unchanged), ignore
        }
      } else {
        // Send new message
        const sent = await this.bot.api.sendMessage(this.chatId, text)
        this.messageId = sent.message_id
      }

      // If buffer exceeds max, start a new message next time
      if (this.buffer.length >= this.MAX_LENGTH) {
        this.messageId = null
        this.buffer = ''
      }
    } catch (err) {
      // Log but don't crash
      console.error('[TelegramPlugin] Flush error:', err)
    } finally {
      this.flushing = false
    }
  }

  async finalize(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
    this.reset()
  }

  reset(): void {
    this.buffer = ''
    this.messageId = null
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}

export class TelegramChannelPlugin implements ChannelPlugin {
  readonly id: string
  private _status: ChannelStatus = 'stopped'
  private bot: Bot | null = null
  private context: ChannelContext | null = null
  private config: ChannelConfig
  private pendingInteractions = new Map<string, PendingInteraction>()
  private responseBuffers = new Map<string, ResponseBuffer>()
  private conversations: Map<string, ConversationState>
  private lastMessageAt: number = 0

  constructor(config: ChannelConfig) {
    this.id = config.instanceId
    this.config = config
    this.conversations = store.loadConversations(config.instanceId)
  }

  get status(): ChannelStatus {
    return this._status
  }

  async start(context: ChannelContext): Promise<void> {
    this._status = 'starting'
    this.context = context

    const botToken = this.config.config.botToken as string
    if (!botToken) {
      this._status = 'error'
      throw new Error('Missing botToken in channel config')
    }

    this.bot = new Bot(botToken)

    // Register bot commands
    registerCommands(
      this.bot,
      context,
      (chatId) => this.getConversationProjectId(chatId),
      (chatId, projectId) => this.setConversationProjectId(chatId, projectId),
    )

    // Handle incoming text messages
    this.bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const userId = String(ctx.from?.id || 'unknown')
      const text = ctx.message.text

      this.lastMessageAt = Date.now()

      // Check for pending interaction
      const pending = this.pendingInteractions.get(chatId)
      if (pending) {
        await this.handlePendingInteractionResponse(chatId, text, pending)
        return
      }

      // Normal prompt
      await this.handleNewPrompt(chatId, userId, text)
    })

    // Handle incoming photos
    this.bot.on('message:photo', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const userId = String(ctx.from?.id || 'unknown')
      const caption = ctx.message.caption || ''

      this.lastMessageAt = Date.now()

      try {
        const images = await this.downloadPhotos(ctx.message.photo)
        const prompt = caption || 'What is in this image?'
        await this.handleNewPrompt(chatId, userId, prompt, images)
      } catch (err: any) {
        context.log('error', `Failed to process photo: ${err.message}`)
        await this.bot?.api.sendMessage(chatId, formatError('Failed to process image'), { parse_mode: 'HTML' })
      }
    })

    // Handle documents that are images (e.g. uncompressed photos sent as files)
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document
      const mime = doc.mime_type || ''
      if (!mime.startsWith('image/')) return // Only handle image documents

      const chatId = String(ctx.chat.id)
      const userId = String(ctx.from?.id || 'unknown')
      const caption = ctx.message.caption || ''

      this.lastMessageAt = Date.now()

      try {
        const image = await this.downloadFile(doc.file_id, mime, doc.file_name)
        const prompt = caption || 'What is in this image?'
        await this.handleNewPrompt(chatId, userId, prompt, [image])
      } catch (err: any) {
        context.log('error', `Failed to process document image: ${err.message}`)
        await this.bot?.api.sendMessage(chatId, formatError('Failed to process image'), { parse_mode: 'HTML' })
      }
    })

    // Handle callback queries (inline keyboard responses)
    this.bot.on('callback_query:data', async (ctx) => {
      const chatId = String(ctx.chat?.id)
      const data = ctx.callbackQuery.data

      if (data.startsWith('perm:')) {
        const [, action, requestId] = data.split(':')
        const allow = action === 'allow'

        const projectId = this.getConversationProjectId(chatId)
        if (projectId) {
          context.respondToPermission(projectId, requestId, allow)
        }

        // Remove pending interaction
        const pending = this.pendingInteractions.get(chatId)
        if (pending?.type === 'permission') {
          clearTimeout(pending.timeout)
          this.pendingInteractions.delete(chatId)
        }

        await ctx.answerCallbackQuery({ text: allow ? 'Allowed' : 'Denied' })
        await ctx.editMessageText(allow ? '✅ Permission granted' : '🚫 Permission denied')
      } else if (data.startsWith('q:')) {
        // Question answer via inline button: q:<toolIdPrefix>:<optionIndex>
        const parts = data.split(':')
        const optionIndex = parseInt(parts[2], 10)

        const pending = this.pendingInteractions.get(chatId)
        if (pending?.type === 'question') {
          clearTimeout(pending.timeout)
          this.pendingInteractions.delete(chatId)

          const projectId = this.getConversationProjectId(chatId)
          if (projectId) {
            // Find the option across all questions
            let idx = 0
            const answers: Record<string, string | string[]> = {}
            for (const q of pending.questions) {
              for (const opt of q.options) {
                if (idx === optionIndex) {
                  answers[q.question] = opt.label
                }
                idx++
              }
            }
            context.respondToQuestion(projectId, pending.toolId, answers)
          }

          const selectedLabel = ctx.callbackQuery.data
          await ctx.answerCallbackQuery({ text: 'Answer received' })
          // Update the message to show the selected option
          try {
            const original = (ctx.callbackQuery.message as any)?.text || ''
            await ctx.editMessageText(`${original}\n\n✅ Selected`, { parse_mode: 'HTML' })
          } catch {
            // ignore edit failures
          }
        } else {
          await ctx.answerCallbackQuery({ text: 'This question has expired' })
        }
      }
    })

    // Register commands with Telegram so they appear in the menu
    try {
      await setMenuCommands(this.bot)
      context.log('info', 'Telegram menu commands registered')
    } catch (err: any) {
      context.log('warn', `Failed to set menu commands: ${err.message}`)
    }

    // Start polling
    try {
      this.bot.start({
        onStart: () => {
          this._status = 'running'
          context.log('info', 'Telegram bot started polling')
        },
      })
    } catch (err: any) {
      this._status = 'error'
      context.log('error', `Failed to start bot: ${err.message}`)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }

    // Clear all pending interactions
    for (const [, pending] of this.pendingInteractions) {
      clearTimeout(pending.timeout)
    }
    this.pendingInteractions.clear()

    // Flush and clear all response buffers
    for (const [, buffer] of this.responseBuffers) {
      await buffer.finalize()
    }
    this.responseBuffers.clear()

    this._status = 'stopped'
    this.context?.log('info', 'Telegram bot stopped')
  }

  async healthCheck(): Promise<ChannelHealthResult> {
    if (!this.bot || this._status !== 'running') {
      return { healthy: false, message: `Status: ${this._status}` }
    }

    try {
      const me = await this.bot.api.getMe()
      return {
        healthy: true,
        message: `Bot @${me.username} is running`,
        lastMessageAt: this.lastMessageAt || undefined,
      }
    } catch (err: any) {
      return { healthy: false, message: err.message }
    }
  }

  // ============ Outbound Callbacks ============

  onQueryStart(conversationId: string, queryId: string): void {
    if (!this.bot) return

    // Initialize response buffer for streaming mode
    if (this.config.responseMode === 'streaming') {
      const buffer = new ResponseBuffer(this.bot, conversationId)
      this.responseBuffers.set(conversationId, buffer)
    }
  }

  onTextDelta(conversationId: string, text: string): void {
    if (this.config.responseMode === 'streaming') {
      const buffer = this.responseBuffers.get(conversationId)
      buffer?.append(text)
    }
  }

  onToolUse(conversationId: string, toolName: string, _toolId: string): void {
    if (!this.bot) return
    // Send a brief tool notification (don't await to avoid blocking)
    const msg = formatToolUse(toolName)
    this.bot.api.sendMessage(conversationId, msg, { parse_mode: 'HTML' }).catch(() => {})
  }

  onToolResult(conversationId: string, _toolId: string, _content: string, _isError: boolean): void {
    // Tool results are not sent to Telegram (too noisy)
  }

  onResult(conversationId: string, fullText: string, costUsd?: number, durationMs?: number): void {
    if (!this.bot) return

    if (this.config.responseMode === 'streaming') {
      // Finalize the streaming buffer
      const buffer = this.responseBuffers.get(conversationId)
      if (buffer) {
        buffer.finalize().catch(() => {})
        this.responseBuffers.delete(conversationId)
      }

      // Send cost/duration summary
      const summary = formatResult(costUsd, durationMs)
      if (summary) {
        this.bot.api.sendMessage(conversationId, summary, { parse_mode: 'HTML' }).catch(() => {})
      }
    } else {
      // Buffered mode: send full response now
      const formatted = formatForTelegram(fullText) + formatResult(costUsd, durationMs)
      const chunks = splitMessage(formatted)
      for (const chunk of chunks) {
        this.bot.api.sendMessage(conversationId, chunk, { parse_mode: 'HTML' }).catch(() => {})
      }
    }
  }

  onError(conversationId: string, error: string): void {
    if (!this.bot) return

    // Finalize any streaming buffer
    const buffer = this.responseBuffers.get(conversationId)
    if (buffer) {
      buffer.finalize().catch(() => {})
      this.responseBuffers.delete(conversationId)
    }

    const msg = formatError(error)
    this.bot.api.sendMessage(conversationId, msg, { parse_mode: 'HTML' }).catch(() => {})
  }

  // ============ Interactive Flows ============

  onAskUserQuestion(conversationId: string, toolId: string, questions: Question[]): void {
    if (!this.bot || !this.context) return

    // Format questions as Telegram message
    const lines = ['❓ <b>Question from CodeCrab:</b>', '']
    const allOptions: { label: string; questionKey: string }[] = []

    for (const q of questions) {
      lines.push(`<b>${q.question}</b>`)
      if (q.options.length > 0) {
        for (const opt of q.options) {
          lines.push(`• ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
          allOptions.push({ label: opt.label, questionKey: q.question })
        }
      }
    }

    // Build inline keyboard buttons for options (max 8 buttons in rows of 2)
    const hasOptions = allOptions.length > 0 && allOptions.length <= 8
    const replyMarkup = hasOptions ? {
      inline_keyboard: allOptions.reduce<Array<Array<{ text: string; callback_data: string }>>>((rows, opt, i) => {
        const btn = { text: opt.label, callback_data: `q:${toolId.slice(0, 16)}:${i}` }
        if (i % 2 === 0) rows.push([btn])
        else rows[rows.length - 1].push(btn)
        return rows
      }, []),
    } : undefined

    if (!hasOptions) {
      lines.push('')
      lines.push('<i>Reply with your answer:</i>')
    }

    this.bot.api.sendMessage(conversationId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }).catch(() => {})

    // Set up pending interaction with timeout
    const timeout = setTimeout(() => {
      this.pendingInteractions.delete(conversationId)
      this.context?.log('warn', `Question timeout for chat ${conversationId}, toolId=${toolId}`)
      // Auto-skip with empty answer on timeout
      const projectId = this.getConversationProjectId(conversationId)
      if (projectId) {
        this.context?.respondToQuestion(projectId, toolId, {})
      }
      this.bot?.api.sendMessage(conversationId, '⏰ Question timed out (5 min). Skipping.').catch(() => {})
    }, INTERACTION_TIMEOUT_MS)

    this.pendingInteractions.set(conversationId, { type: 'question', toolId, questions, timeout })
  }

  onPermissionRequest(conversationId: string, requestId: string, toolName: string, input: unknown, reason: string): void {
    if (!this.bot || !this.context) return

    const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    const preview = inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr
    const msg = [
      '🔐 <b>Permission Request</b>',
      '',
      `<b>Tool:</b> <code>${toolName}</code>`,
      reason ? `<b>Reason:</b> ${reason}` : '',
      `<b>Input:</b> <pre>${preview}</pre>`,
    ].filter(Boolean).join('\n')

    // Send with inline keyboard
    this.bot.api.sendMessage(conversationId, msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Allow', callback_data: `perm:allow:${requestId}` },
          { text: '🚫 Deny', callback_data: `perm:deny:${requestId}` },
        ]],
      },
    }).catch(() => {})

    // Set up timeout
    const timeout = setTimeout(() => {
      this.pendingInteractions.delete(conversationId)
      const projectId = this.getConversationProjectId(conversationId)
      if (projectId) {
        this.context?.respondToPermission(projectId, requestId, false)
      }
      this.bot?.api.sendMessage(conversationId, '⏰ Permission request timed out. Auto-denied.').catch(() => {})
    }, INTERACTION_TIMEOUT_MS)

    this.pendingInteractions.set(conversationId, { type: 'permission', requestId, timeout })
  }

  // ============ Internal Helpers ============

  private getConversationProjectId(chatId: string): string | undefined {
    return this.conversations.get(chatId)?.projectId
  }

  private setConversationProjectId(chatId: string, projectId: string): void {
    const existing = this.conversations.get(chatId)
    const conversation: ConversationState = {
      conversationId: chatId,
      sessionId: existing?.sessionId || `channel-${this.config.id}-${chatId}-${Date.now()}`,
      projectId,
      lastActivityAt: Date.now(),
    }
    // Create new session when project changes
    if (existing?.projectId !== projectId) {
      conversation.sessionId = `channel-${this.config.id}-${chatId}-${Date.now()}`
    }
    this.conversations.set(chatId, conversation)
    store.saveConversations(this.config.instanceId, this.conversations)
  }

  private async handlePendingInteractionResponse(chatId: string, text: string, pending: PendingInteraction): Promise<void> {
    clearTimeout(pending.timeout)
    this.pendingInteractions.delete(chatId)

    const projectId = this.getConversationProjectId(chatId)
    if (!projectId) {
      await this.bot?.api.sendMessage(chatId, '❌ No project selected.')
      return
    }

    if (pending.type === 'question') {
      // Parse answer from text
      const answers: Record<string, string | string[]> = {}
      for (const q of pending.questions) {
        if (q.options.length > 0) {
          // Try to parse as option number
          const num = parseInt(text.trim(), 10)
          if (!isNaN(num) && num >= 1 && num <= q.options.length) {
            answers[q.question] = q.options[num - 1].label
          } else {
            // Use raw text as answer
            answers[q.question] = text.trim()
          }
        } else {
          answers[q.question] = text.trim()
        }
      }

      this.context?.respondToQuestion(projectId, pending.toolId, answers)
      await this.bot?.api.sendMessage(chatId, '✅ Answer received.')
    } else if (pending.type === 'permission') {
      const lower = text.trim().toLowerCase()
      const allow = lower === 'allow' || lower === 'yes' || lower === 'y'
      this.context?.respondToPermission(projectId, pending.requestId, allow)
      await this.bot?.api.sendMessage(chatId, allow ? '✅ Permission granted' : '🚫 Permission denied')
    }
  }

  private async handleNewPrompt(chatId: string, userId: string, text: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.context) return

    // Resolve project for this conversation
    const mapping = await this.context.resolveProject(userId, chatId)
    if (!mapping) {
      await this.bot?.api.sendMessage(
        chatId,
        '❌ No project configured for this chat.\n\nUse <code>/project &lt;project-id&gt;</code> to select one.',
        { parse_mode: 'HTML' },
      )
      return
    }

    // Send typing indicator
    this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {})

    try {
      await this.context.submitPrompt({
        projectId: mapping.projectId,
        prompt: text,
        conversationId: chatId,
        externalUserId: userId,
        images,
      })
    } catch (err: any) {
      this.context.log('error', `Failed to submit prompt: ${err.message}`)
      await this.bot?.api.sendMessage(chatId, formatError(err.message), { parse_mode: 'HTML' })
    }
  }

  /** Download Telegram photos (picks the largest resolution) and convert to ImageAttachment */
  private async downloadPhotos(photoSizes: Array<{ file_id: string; width: number; height: number }>): Promise<ImageAttachment[]> {
    if (!this.bot || photoSizes.length === 0) return []

    // Telegram sends multiple sizes — pick the largest
    const largest = photoSizes[photoSizes.length - 1]
    const image = await this.downloadFile(largest.file_id, 'image/jpeg')
    return [image]
  }

  /** Download a file from Telegram by file_id and return as ImageAttachment */
  private async downloadFile(fileId: string, mimeType: string, fileName?: string): Promise<ImageAttachment> {
    if (!this.bot) throw new Error('Bot not initialized')

    const file = await this.bot.api.getFile(fileId)
    const filePath = file.file_path
    if (!filePath) throw new Error('Could not get file path from Telegram')

    const token = this.config.config.botToken as string
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`)

    const arrayBuffer = await response.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    // Map MIME type to supported media types
    let mediaType: ImageAttachment['mediaType'] = 'image/jpeg'
    if (mimeType === 'image/png') mediaType = 'image/png'
    else if (mimeType === 'image/gif') mediaType = 'image/gif'
    else if (mimeType === 'image/webp') mediaType = 'image/webp'

    return {
      data: base64,
      mediaType,
      name: fileName,
    }
  }
}
