// MCP extension registry for server-v2
//
// Central registry of all available MCP extension servers.
// Each entry defines an id, metadata, and the tools array.
// At query time, only enabled extensions are registered with the SDK.

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { tools as chromeTools } from './chrome/tools.js'
import { tools as cronTools } from './cron/tools.js'
import { tools as pushTools } from './push/tools.js'
import { tools as threadTools } from './threads/tools.js'
import { isApnsConfigured } from '../../push/apns.js'

export interface McpExtension {
  id: string
  name: string
  description: string
  icon: string
  tools: unknown[]
}

/** All registered MCP extension definitions */
const extensions: McpExtension[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    description: 'Browser automation via Chrome DevTools Protocol — navigate, screenshot, click, type, evaluate JS',
    icon: '🌐',
    tools: chromeTools,
  },
  {
    id: 'cron',
    name: 'Cron',
    description: 'Scheduled tasks — create reminders, recurring jobs, and timed actions via natural language',
    icon: '⏰',
    tools: cronTools,
  },
  {
    id: 'push',
    name: 'Push',
    description: 'Send push notifications to iOS devices via Apple Push Notification service',
    icon: '🔔',
    tools: pushTools,
  },
  {
    id: 'threads',
    name: 'Threads',
    description: 'Inter-agent communication — send messages, share artifacts, manage collaboration threads',
    icon: '🔗',
    tools: threadTools,
  },
]

/** Register a new extension at runtime */
export function registerExtension(ext: McpExtension): void {
  extensions.push(ext)
}

/** Get all registered extensions (copy) */
export function getExtensions(): McpExtension[] {
  return [...extensions]
}

/** Get extension info for client consumption */
export function getAvailableExtensions(): Array<{
  id: string
  name: string
  description: string
  icon: string
  toolCount: number
}> {
  return extensions
    .filter((ext) => ext.id !== 'push' || isApnsConfigured())
    .map((ext) => ({
      id: ext.id,
      name: ext.name,
      description: ext.description,
      icon: ext.icon,
      toolCount: ext.tools.length,
    }))
}

/**
 * Build mcpServers object for SDK query, filtered by enabled extension IDs.
 * If enabledMcps is undefined/null, all extensions are enabled (default).
 */
export function buildExtensionServers(enabledMcps?: string[]): Record<string, unknown> {
  const servers: Record<string, unknown> = {}

  for (const ext of extensions) {
    // If enabledMcps not specified, enable all; otherwise check list
    if (!enabledMcps || enabledMcps.includes(ext.id)) {
      // Skip push extension when APNs is not configured
      if (ext.id === 'push' && !isApnsConfigured()) continue

      // Only create server if extension has tools
      if (ext.tools.length > 0) {
        servers[ext.id] = createSdkMcpServer({
          name: ext.id,
          tools: ext.tools as any,
        })
      }
    }
  }

  return servers
}
