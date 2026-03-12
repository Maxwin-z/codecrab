// Skills registry — framework for server-defined skill extensions
//
// Project-level skills from .claude/skills/ are loaded via settingSources: ["project"].
// This registry provides a pattern for programmatic server-defined skills
// that are registered as MCP tools using createSdkMcpServer.

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  icon: string
  tools: unknown[]
}

/** All registered skill definitions */
export const skillsRegistry: SkillDefinition[] = [
  // Future skills will be registered here.
]

/** Get available skills info for client consumption */
export function getAvailableSkills(): { id: string; name: string; description: string; icon: string; toolCount: number }[] {
  return skillsRegistry.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    icon: s.icon,
    toolCount: s.tools.length,
  }))
}

/** Build MCP servers for skills, to merge into the main mcpServers object.
 *  Skills are registered as MCP tool servers since that's how the SDK
 *  supports code-registered capabilities. */
export function buildSkillServers(): Record<string, unknown> {
  const servers: Record<string, unknown> = {}

  for (const def of skillsRegistry) {
    if (def.tools.length > 0) {
      servers[`skill_${def.id}`] = createSdkMcpServer({
        name: `skill_${def.id}`,
        tools: def.tools as any,
      })
    }
  }

  return servers
}
