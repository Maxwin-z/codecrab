import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Agent } from '@codecrab/shared'
import type { ProjectManager } from './project.js'
import type { ProjectConfig, PermissionMode } from '../types/index.js'

const CONFIG_DIR = join(homedir(), '.codecrab')
const AGENTS_FILE = join(CONFIG_DIR, 'agents.json')
const AGENTS_DIR = join(CONFIG_DIR, 'agents')

const SYSTEM_AGENT_ID = '__system-agent'
const SYSTEM_AGENT_NAME = 'system-agent'

const SYSTEM_AGENT_CLAUDE_MD = `# System Agent — Agent Definition Helper

You are a specialized assistant that helps users define and configure AI agents. Your sole purpose is to help the user craft a clear, effective CLAUDE.md that defines an agent's role, capabilities, and behavior.

## Workflow

### For existing agents (user provides current CLAUDE.md):
1. **Summarize first**: Read the provided CLAUDE.md and present a concise summary to the user, covering: the agent's role, key capabilities, constraints, and any notable behavior rules.
2. **Let the user speak freely**: After the summary, ask the user in plain text: "What adjustments would you like to make?" — do NOT use the AskUserQuestion tool yet. Do NOT suggest changes proactively. Let the user describe their vision in their own words first.
3. **Confirm details with AskUserQuestion**: Once the user's general direction is clear from their free-form response, use the AskUserQuestion tool to confirm specific details, options, or trade-offs before making changes.
4. **Apply and finalize**: Once you have enough information, generate the updated CLAUDE.md.

### For new agents (empty CLAUDE.md):
1. **Let the user express freely**: Respond with a brief, warm plain-text message inviting the user to describe what the agent should do. Do NOT use the AskUserQuestion tool in this first response. Let the user define the direction in their own words first.
2. **Confirm details with AskUserQuestion**: After the user describes their vision, use the AskUserQuestion tool to clarify specifics: target tasks, tone, constraints, output format, etc.
3. **Generate**: Create the initial CLAUDE.md based on the user's answers.

## Guidelines
- **First turn rule**: In the very first response of a session, ALWAYS use plain text to let the user freely express their ideas. Do NOT use the AskUserQuestion tool in the first turn. This is critical — users need space to articulate their vision before being constrained by structured forms.
- **After direction is clear**: Once the user's general direction is understood (typically from their second message onward), use the AskUserQuestion tool to confirm details and gather structured input.
- The user is on a chat interface and can respond through both text messages and the AskUserQuestion tool's interactive form.
- Prefer select/multi-select question types when there are discrete options, and free-text when open-ended input is needed.
- Be concise and practical in your suggestions.
- Structure the CLAUDE.md with clear sections: Role, Capabilities, Constraints, Output Format, etc.
- Tailor instructions to the agent's specific domain.
- If the user's message is not about defining the agent's role or capabilities, politely redirect them.

## Finalization
When the user is satisfied or when asked to finalize, output the complete CLAUDE.md content wrapped in special markers:

<agent-claude-md>
... complete CLAUDE.md content here ...
</agent-claude-md>

Always include these markers so the system can extract the content automatically.
`

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
}

export class AgentManager {
  private agents = new Map<string, Agent>()

  constructor(private projects: ProjectManager) {}

  async load(): Promise<void> {
    try {
      const data = await readFile(AGENTS_FILE, 'utf-8')
      const agents: Agent[] = JSON.parse(data)
      for (const a of agents) {
        this.agents.set(a.id, a)
      }
    } catch {
      // No agents file yet
    }
  }

  /** Ensure system-agent exists on startup */
  async ensureSystemAgent(): Promise<void> {
    if (!this.agents.has(SYSTEM_AGENT_ID)) {
      const now = Date.now()
      const agent: Agent = {
        id: SYSTEM_AGENT_ID,
        name: SYSTEM_AGENT_NAME,
        emoji: '🤖',
        createdAt: now,
        updatedAt: now,
      }
      this.agents.set(SYSTEM_AGENT_ID, agent)
      await this.persist()
    }

    // Ensure directory and CLAUDE.md — always overwrite to keep in sync with latest instructions
    const agentDir = this.getAgentDir(SYSTEM_AGENT_ID)
    await ensureDir(agentDir)
    const claudeMdPath = join(agentDir, 'CLAUDE.md')
    await writeFile(claudeMdPath, SYSTEM_AGENT_CLAUDE_MD)

    // Ensure internal project exists for system-agent
    await this.ensureAgentProject(SYSTEM_AGENT_ID)

    // Ensure editor projects exist for all user agents
    for (const agent of this.agents.values()) {
      if (agent.id !== SYSTEM_AGENT_ID) {
        await this.ensureAgentEditorProject(agent.id)
      }
    }
  }

  private async persist(): Promise<void> {
    await ensureDir(CONFIG_DIR)
    const agents = Array.from(this.agents.values())
    await writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2))
  }

  private getAgentDir(agentId: string): string {
    return join(AGENTS_DIR, agentId)
  }

  /** List all agents, excluding system-agent */
  list(): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.id !== SYSTEM_AGENT_ID)
  }

  get(agentId: string): Agent | null {
    return this.agents.get(agentId) ?? null
  }

  /** Find an agent by name (case-sensitive) */
  findByName(name: string): Agent | null {
    for (const agent of this.agents.values()) {
      if (agent.name === name) return agent
    }
    return null
  }

  /** Get the internal project ID for an agent */
  getProjectId(agentId: string): string {
    return `__agent-${agentId}`
  }

  /** Get the editor project ID for an agent (per-agent editing sessions) */
  getEditorProjectId(agentId: string): string {
    return `__agent-editor-${agentId}`
  }

  /** Get agent's directory path */
  getPath(agentId: string): string {
    return this.getAgentDir(agentId)
  }

  /** Read agent's CLAUDE.md content */
  async getClaudeMd(agentId: string): Promise<string> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError('Agent not found')
    const claudeMdPath = join(this.getAgentDir(agentId), 'CLAUDE.md')
    try {
      return await readFile(claudeMdPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /** Save agent's CLAUDE.md content */
  async saveClaudeMd(agentId: string, content: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError('Agent not found')
    const agentDir = this.getAgentDir(agentId)
    await ensureDir(agentDir)
    await writeFile(join(agentDir, 'CLAUDE.md'), content)
  }

  /** Create a new agent */
  async create(params: { name: string; emoji: string }): Promise<Agent> {
    if (!params.name || !params.name.trim()) {
      throw new AgentValidationError('Agent name is required')
    }

    const trimmedName = params.name.trim()

    // Check reserved name
    if (trimmedName.toLowerCase() === SYSTEM_AGENT_NAME) {
      throw new AgentConflictError(`"${SYSTEM_AGENT_NAME}" is a reserved agent name`)
    }

    // Check duplicate name
    for (const a of this.agents.values()) {
      if (a.id !== SYSTEM_AGENT_ID && a.name === trimmedName) {
        throw new AgentConflictError('An agent with this name already exists')
      }
    }

    const now = Date.now()
    const agent: Agent = {
      id: `agent-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      emoji: params.emoji || '🤖',
      createdAt: now,
      updatedAt: now,
    }

    // Create agent directory and empty CLAUDE.md
    const agentDir = this.getAgentDir(agent.id)
    await ensureDir(agentDir)
    await writeFile(join(agentDir, 'CLAUDE.md'), '')

    this.agents.set(agent.id, agent)
    await this.persist()

    // Create internal project for this agent
    await this.ensureAgentProject(agent.id)

    // Create editor project for this agent
    await this.ensureAgentEditorProject(agent.id)

    return agent
  }

  /** Update an existing agent's name and/or emoji */
  async update(agentId: string, params: { name?: string; emoji?: string }): Promise<Agent> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError('Agent not found')
    if (agentId === SYSTEM_AGENT_ID) throw new AgentValidationError('Cannot modify system agent')

    if (params.name) {
      const trimmedName = params.name.trim()
      if (trimmedName.toLowerCase() === SYSTEM_AGENT_NAME) {
        throw new AgentConflictError(`"${SYSTEM_AGENT_NAME}" is a reserved agent name`)
      }
      // Check duplicate name (excluding self)
      for (const a of this.agents.values()) {
        if (a.id !== agentId && a.id !== SYSTEM_AGENT_ID && a.name === trimmedName) {
          throw new AgentConflictError('An agent with this name already exists')
        }
      }
      agent.name = trimmedName

      // Also update the internal project name and editor project name
      const projectId = this.getProjectId(agentId)
      const project = this.projects.get(projectId)
      if (project) {
        await this.projects.update(projectId, { name: trimmedName })
      }
      const editorProjectId = this.getEditorProjectId(agentId)
      const editorProject = this.projects.get(editorProjectId)
      if (editorProject) {
        await this.projects.update(editorProjectId, { name: trimmedName })
      }
    }

    if (params.emoji) {
      agent.emoji = params.emoji

      // Also update the internal project icon and editor project icon
      const projectId = this.getProjectId(agentId)
      const project = this.projects.get(projectId)
      if (project) {
        await this.projects.update(projectId, { icon: params.emoji })
      }
      const editorProjectId = this.getEditorProjectId(agentId)
      const editorProject = this.projects.get(editorProjectId)
      if (editorProject) {
        await this.projects.update(editorProjectId, { icon: params.emoji })
      }
    }

    agent.updatedAt = Date.now()
    await this.persist()
    return agent
  }

  /** Delete an agent */
  async delete(agentId: string): Promise<void> {
    if (!this.agents.has(agentId)) throw new AgentNotFoundError('Agent not found')
    if (agentId === SYSTEM_AGENT_ID) throw new AgentValidationError('Cannot delete system agent')

    this.agents.delete(agentId)
    await this.persist()

    // Delete the internal project and editor project
    for (const pid of [this.getProjectId(agentId), this.getEditorProjectId(agentId)]) {
      try {
        await this.projects.delete(pid)
      } catch {
        // Project might not exist
      }
    }
  }

  /** Ensure an internal project exists for this agent (for session/WS infrastructure) */
  async ensureAgentProject(agentId: string): Promise<ProjectConfig> {
    const projectId = this.getProjectId(agentId)
    const existing = this.projects.get(projectId)
    if (existing) return existing

    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError('Agent not found')

    const agentDir = this.getAgentDir(agentId)
    await ensureDir(agentDir)

    // Create internal project with __ prefix (filtered out by iOS/web)
    return this.projects.create({
      name: agent.name,
      path: agentDir,
      icon: agent.emoji,
      id: projectId,
    })
  }

  /** Ensure an editor project exists for this agent (uses system-agent CLAUDE.md for editing sessions) */
  async ensureAgentEditorProject(agentId: string): Promise<ProjectConfig> {
    const editorProjectId = this.getEditorProjectId(agentId)
    const existing = this.projects.get(editorProjectId)
    if (existing) return existing

    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError('Agent not found')

    // Editor project points to system-agent dir so SDK loads system-agent CLAUDE.md
    const systemAgentDir = this.getAgentDir(SYSTEM_AGENT_ID)
    await ensureDir(systemAgentDir)

    return this.projects.create({
      name: agent.name,
      path: systemAgentDir,
      icon: agent.emoji,
      id: editorProjectId,
    })
  }

  /** Get the system-agent's internal project ID */
  getSystemAgentProjectId(): string {
    return this.getProjectId(SYSTEM_AGENT_ID)
  }
}

export class AgentValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentValidationError' }
}

export class AgentConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentConflictError' }
}

export class AgentNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentNotFoundError' }
}
