import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProjectConfig, PermissionMode, ModelConfig } from '../types/index.js'

const CONFIG_DIR = join(homedir(), '.codecrab')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const MODELS_FILE = join(CONFIG_DIR, 'models.json')

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true })
}

const CLAUDE_DIR = join(homedir(), '.claude')

export class ProjectManager {
  private projects = new Map<string, ProjectConfig>()
  private projectModels = new Map<string, string>() // projectId -> model config ID override
  private defaultModelConfigId = 'claude-sonnet-4-6' // UUID or fallback model name
  private models: ModelConfig[] = [] // Full model configs from models.json

  async load(): Promise<void> {
    try {
      const data = await readFile(PROJECTS_FILE, 'utf-8')
      const projects: any[] = JSON.parse(data)
      for (const p of projects) {
        this.projects.set(p.id, this.toConfig(p))
      }
    } catch {
      // No projects file yet — start empty
    }

    try {
      const data = await readFile(MODELS_FILE, 'utf-8')
      const settings = JSON.parse(data)
      if (settings.defaultModelId) {
        this.defaultModelConfigId = settings.defaultModelId
      }
      if (Array.isArray(settings.models)) {
        this.models = settings.models
      }
      // Load per-project model overrides if they exist
      if (settings.projectModels) {
        for (const [pid, modelId] of Object.entries(settings.projectModels)) {
          this.projectModels.set(pid, modelId as string)
        }
      }
    } catch {
      // No models file — use defaults
    }

    // Re-apply model settings to already-loaded projects
    // (projects.json is loaded before models.json, so defaults may be stale)
    const defaultConfigId = this.defaultModelConfigId
    for (const [id, config] of this.projects) {
      const override = this.projectModels.get(id)
      config.defaultModel = override || defaultConfigId
    }
  }

  private toConfig(raw: any): ProjectConfig {
    const modelOverride = this.projectModels.get(raw.id)
    return {
      id: raw.id,
      name: raw.name,
      path: raw.path,
      icon: raw.icon || '',
      defaultModel: modelOverride || this.defaultModelConfigId,
      defaultPermissionMode: 'default' as PermissionMode,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now(),
      lastActivityAt: raw.lastActivityAt,
    }
  }

  private async persist(): Promise<void> {
    await ensureConfigDir()
    const projects = Array.from(this.projects.values()).map(p => ({
      id: p.id,
      name: p.name,
      path: p.path,
      icon: p.icon,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))
    await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2))
  }

  list(): ProjectConfig[] {
    return Array.from(this.projects.values())
  }

  get(projectId: string): ProjectConfig | null {
    return this.projects.get(projectId) ?? null
  }

  getPath(projectId: string): string | null {
    return this.projects.get(projectId)?.path ?? null
  }

  getDefaultModel(projectId: string): string {
    return this.projectModels.get(projectId) || this.defaultModelConfigId
  }

  /** Resolve a model config ID (UUID) to the full ModelConfig.
   *  Returns null if not found. */
  resolveModelConfig(modelConfigId: string): ModelConfig | null {
    return this.models.find((m) => m.id === modelConfigId) ?? null
  }

  /** Build SDK environment variables from a ModelConfig.
   *  Sets ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, clears nested-session vars. */
  buildModelEnv(modelConfig: ModelConfig): Record<string, string | undefined> {
    const apiKey = modelConfig.apiKey || process.env.ANTHROPIC_API_KEY
    const env: Record<string, string | undefined> = { ...process.env }

    // For API key models, set CLAUDE_CONFIG_DIR so skills/commands load from ~/.claude.
    // For OAuth models, DON'T set it — causes Keychain key mismatch.
    if (apiKey) {
      env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
      env.ANTHROPIC_API_KEY = apiKey
    } else {
      delete env.CLAUDE_CONFIG_DIR
      delete env.ANTHROPIC_API_KEY
    }

    if (modelConfig.baseUrl) {
      env.ANTHROPIC_BASE_URL = modelConfig.baseUrl
    } else {
      delete env.ANTHROPIC_BASE_URL
    }

    // Prevent nested-session detection when server runs inside a Claude Code terminal
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT

    return env
  }

  /** Create a new project. Returns the created project or throws on validation error. */
  async create(params: { name: string; path: string; icon?: string }): Promise<ProjectConfig> {
    if (!params.name || !params.path) {
      throw new ProjectValidationError('Missing name or path')
    }

    // Check for duplicate path
    for (const p of this.projects.values()) {
      if (p.path === params.path) {
        throw new ProjectConflictError('A project already exists for this directory')
      }
    }

    const now = Date.now()
    const config: ProjectConfig = {
      id: `proj-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: params.name,
      path: params.path,
      icon: params.icon || '📁',
      defaultModel: this.defaultModelConfigId,
      defaultPermissionMode: 'default' as PermissionMode,
      createdAt: now,
      updatedAt: now,
    }

    this.projects.set(config.id, config)
    await this.persist()
    return config
  }

  /** Update an existing project's name and/or icon. */
  async update(projectId: string, params: { name?: string; icon?: string }): Promise<ProjectConfig> {
    const config = this.projects.get(projectId)
    if (!config) {
      throw new ProjectNotFoundError('Project not found')
    }

    if (params.name) config.name = params.name
    if (params.icon) config.icon = params.icon
    config.updatedAt = Date.now()

    await this.persist()
    return config
  }

  /** Delete a project by ID. */
  async delete(projectId: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      throw new ProjectNotFoundError('Project not found')
    }
    this.projects.delete(projectId)
    await this.persist()
  }
}

export class ProjectValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectValidationError' }
}

export class ProjectConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectConflictError' }
}

export class ProjectNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectNotFoundError' }
}
