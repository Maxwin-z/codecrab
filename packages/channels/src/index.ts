// @codecrab/channels — Channel plugin registry and exports

import type { ChannelDefinition } from './types.js'
import { telegramChannel } from './telegram/index.js'

// ============ Channel Registry ============

export const channelRegistry = new Map<string, ChannelDefinition>()

// Register built-in channels
channelRegistry.set(telegramChannel.id, telegramChannel)

/** Register a custom channel definition */
export function registerChannel(definition: ChannelDefinition): void {
  channelRegistry.set(definition.id, definition)
}

// ============ Re-exports ============

export { ChannelManager } from './manager.js'
export { createChannelRouter, createWebhookRouter } from './routes.js'
export type {
  ChannelDefinition,
  ChannelPlugin,
  ChannelContext,
  ChannelConfig,
  ChannelConfigField,
  ChannelStatus,
  ChannelHealthResult,
  ChannelEngineContext,
  ChannelPromptParams,
  ChannelQueryResult,
  ChannelProjectMapping,
  ChannelProjectMappingRule,
  ConversationState,
} from './types.js'
