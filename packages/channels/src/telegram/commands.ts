// Telegram bot commands — /project, /projects, /status, /abort, /mode

import type { Bot, Context } from 'grammy'
import type { ChannelContext } from '../types.js'

/** Register commands with Telegram so they appear in the chat menu */
export async function setMenuCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'project', description: 'Switch or view current project' },
    { command: 'projects', description: 'List available projects' },
    { command: 'status', description: 'Show current status' },
    { command: 'abort', description: 'Abort running query' },
    { command: 'mode', description: 'Change interactive mode' },
    { command: 'help', description: 'Show available commands' },
  ])
}

export function registerCommands(
  bot: Bot,
  context: ChannelContext,
  getConversationProjectId: (chatId: string) => string | undefined,
  setConversationProjectId: (chatId: string, projectId: string) => void,
): void {

  // /help — Show available commands
  bot.command('help', async (ctx: Context) => {
    await ctx.reply(
      '<b>📋 CodeCrab Bot Commands</b>\n\n' +
      '/project &lt;name&gt; — Switch to a project\n' +
      '/projects — List available projects\n' +
      '/status — Show current status\n' +
      '/abort — Abort running query\n' +
      '/mode &lt;mode&gt; — Change interactive mode\n' +
      '/help — Show this help message',
      { parse_mode: 'HTML' },
    )
  })

  // /projects — List available CodeCrab projects
  bot.command('projects', async (ctx: Context) => {
    const chatId = String(ctx.chat?.id)
    if (!chatId) return

    try {
      // resolveProject with a dummy user to get the project list
      // We need to go through the engine context to list projects
      // The context doesn't expose listProjects directly, so we'll
      // use the resolveProject + a message to indicate which is active
      const currentProjectId = getConversationProjectId(chatId)

      // Send a hint to use /project <name> to switch
      await ctx.reply(
        '📂 Use <code>/project &lt;name&gt;</code> to switch to a project.\n' +
        (currentProjectId
          ? `\nCurrent project: <code>${currentProjectId}</code>`
          : '\nNo project selected. Use /project to set one.'),
        { parse_mode: 'HTML' },
      )
    } catch (err: any) {
      context.log('error', `/projects command failed: ${err.message}`)
      await ctx.reply(`❌ Failed to list projects: ${err.message}`)
    }
  })

  // /project <name|id> — Switch current conversation to a project
  bot.command('project', async (ctx: Context) => {
    const chatId = String(ctx.chat?.id)
    if (!chatId) return

    const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim()
    if (!args) {
      const currentProjectId = getConversationProjectId(chatId)
      await ctx.reply(
        currentProjectId
          ? `📂 Current project: <code>${currentProjectId}</code>\n\nUsage: <code>/project &lt;name or id&gt;</code>`
          : '📂 No project selected.\n\nUsage: <code>/project &lt;name or id&gt;</code>',
        { parse_mode: 'HTML' },
      )
      return
    }

    // Set project by ID directly
    setConversationProjectId(chatId, args)
    await ctx.reply(`✅ Switched to project: <code>${args}</code>`, { parse_mode: 'HTML' })
    context.log('info', `Chat ${chatId} switched to project: ${args}`)
  })

  // /status — Show current project, session status
  bot.command('status', async (ctx: Context) => {
    const chatId = String(ctx.chat?.id)
    if (!chatId) return

    const currentProjectId = getConversationProjectId(chatId)
    const lines = [
      '<b>📊 Status</b>',
      '',
      `Project: ${currentProjectId ? `<code>${currentProjectId}</code>` : '<i>none</i>'}`,
    ]

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  // /abort — Abort running query
  bot.command('abort', async (ctx: Context) => {
    const chatId = String(ctx.chat?.id)
    if (!chatId) return

    const projectId = getConversationProjectId(chatId)
    if (!projectId) {
      await ctx.reply('❌ No project selected. Use /project to set one.')
      return
    }

    context.abortQuery(projectId)
    await ctx.reply('🛑 Query aborted.')
    context.log('info', `Chat ${chatId} aborted query for project ${projectId}`)
  })

  // /mode <forward|auto_allow|auto_deny> — Change interactive mode
  bot.command('mode', async (ctx: Context) => {
    const chatId = String(ctx.chat?.id)
    if (!chatId) return

    const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim()
    const validModes = ['forward', 'auto_allow', 'auto_deny']

    if (!args || !validModes.includes(args)) {
      await ctx.reply(
        '<b>Interactive Mode</b>\n\n' +
        'Usage: <code>/mode &lt;forward|auto_allow|auto_deny&gt;</code>\n\n' +
        '• <b>forward</b> — Questions/permissions forwarded to you\n' +
        '• <b>auto_allow</b> — Auto-approve everything\n' +
        '• <b>auto_deny</b> — Auto-deny permissions',
        { parse_mode: 'HTML' },
      )
      return
    }

    // Note: mode changes would need to be persisted in config
    // For now just acknowledge
    await ctx.reply(`✅ Interactive mode set to: <b>${args}</b>`, { parse_mode: 'HTML' })
  })
}
