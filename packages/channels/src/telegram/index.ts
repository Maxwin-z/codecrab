// Telegram channel definition — factory + config schema

import type { ChannelDefinition } from '../types.js'
import { TelegramChannelPlugin } from './plugin.js'

export const telegramChannel: ChannelDefinition = {
  id: 'telegram',
  name: 'Telegram',
  description: 'Connect a Telegram bot to CodeCrab for bidirectional chat-based coding assistance.',
  icon: '✈️',
  configSchema: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'secret',
      required: true,
      description: 'Telegram bot token from @BotFather',
      placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    },
  ],
  factory: (config) => new TelegramChannelPlugin(config),
}
