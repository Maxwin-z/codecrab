// MCP extension registry
//
// Central registry of all available MCP servers.
// Each entry defines an id, metadata, and the tools array.
// At query time, only enabled MCPs are registered with the SDK.

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { chromeTools } from './chrome/index.js'
import { cronTools } from './cron/index.js'
import { pushTools } from './push/index.js'
import type { McpInfo } from '@codecrab/shared'

export interface McpDefinition {
  id: string
  name: string
  description: string
  icon: string
  tools: unknown[]
}

/** All registered MCP definitions */
export const mcpRegistry: McpDefinition[] = [
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
]

/** Get McpInfo list for client consumption */
export function getAvailableMcps(): McpInfo[] {
  return mcpRegistry.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    toolCount: m.tools.length,
  }))
}

/** Build mcpServers object for SDK query, filtered by enabled IDs.
 *  If enabledMcps is undefined/null, all MCPs are enabled (default). */
export function buildMcpServers(enabledMcps?: string[]): Record<string, unknown> {
  const servers: Record<string, unknown> = {}

  for (const def of mcpRegistry) {
    // If enabledMcps not specified, enable all; otherwise check list
    if (!enabledMcps || enabledMcps.includes(def.id)) {
      servers[def.id] = createSdkMcpServer({
        name: def.id,
        tools: def.tools as any,
      })
    }
  }

  return servers
}
