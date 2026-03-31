import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProjectConfig, PermissionMode, ProviderConfig } from '../types/index.js'

const CONFIG_DIR = join(homedir(), '.codecrab')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const MODELS_FILE = join(CONFIG_DIR, 'models.json')

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true })
}

const CLAUDE_DIR = join(homedir(), '.claude')

export class ProjectManager {
  private projects = new Map<string, ProjectConfig>()
  private projectProviders = new Map<string, string>() // projectId -> provider config ID override
  private defaultProviderConfigId = 'claude-sonnet-4-6' // UUID or fallback provider name
  private providers: ProviderConfig[] = [] // Full provider configs from models.json

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
      if (settings.defaultProviderId || settings.defaultModelId) {
        this.defaultProviderConfigId = settings.defaultProviderId || settings.defaultModelId
      }
      if (Array.isArray(settings.providers)) {
        this.providers = settings.providers
      } else if (Array.isArray(settings.models)) {
        this.providers = settings.models // backward compat
      }
      // Load per-project provider overrides if they exist
      if (settings.projectProviders || settings.projectModels) {
        const overrides = settings.projectProviders || settings.projectModels
        for (const [pid, providerId] of Object.entries(overrides)) {
          this.projectProviders.set(pid, providerId as string)
        }
      }
    } catch {
      // No models file — use defaults
    }

    // Re-apply provider settings to already-loaded projects
    // (projects.json is loaded before models.json, so defaults may be stale)
    const defaultConfigId = this.defaultProviderConfigId
    for (const [id, config] of this.projects) {
      const override = this.projectProviders.get(id)
      config.defaultProviderId = override || defaultConfigId
    }
  }

  private toConfig(raw: any): ProjectConfig {
    const providerOverride = this.projectProviders.get(raw.id)
    return {
      id: raw.id,
      name: raw.name,
      path: raw.path,
      icon: raw.icon || '',
      defaultProviderId: providerOverride || this.defaultProviderConfigId,
      defaultPermissionMode: 'bypassPermissions' as PermissionMode,
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

  getDefaultProvider(projectId: string): string {
    return this.projectProviders.get(projectId) || this.defaultProviderConfigId
  }

  /** Resolve a provider config ID (UUID) to the full ProviderConfig.
   *  Returns null if not found. */
  resolveProviderConfig(providerConfigId: string): ProviderConfig | null {
    return this.providers.find((p) => p.id === providerConfigId) ?? null
  }

  /** Build SDK environment variables from a ProviderConfig.
   *  Sets ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, clears nested-session vars. */
  buildProviderEnv(providerConfig: ProviderConfig): Record<string, string | undefined> {
    const apiKey = providerConfig.apiKey || process.env.ANTHROPIC_API_KEY
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

    if (providerConfig.baseUrl) {
      env.ANTHROPIC_BASE_URL = providerConfig.baseUrl
    } else {
      delete env.ANTHROPIC_BASE_URL
    }

    // Prevent nested-session detection when server runs inside a Claude Code terminal
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT

    return env
  }

  /** Create a new project. Returns the created project or throws on validation error. */
  async create(params: { name: string; path: string; icon?: string; id?: string }): Promise<ProjectConfig> {
    if (!params.name || !params.path) {
      throw new ProjectValidationError('Missing name or path')
    }

    // Check for duplicate path (skip for internal __ projects)
    if (!params.id?.startsWith('__')) {
      for (const p of this.projects.values()) {
        if (p.path === params.path) {
          throw new ProjectConflictError('A project already exists for this directory')
        }
      }
    }

    const now = Date.now()
    const config: ProjectConfig = {
      id: params.id || `proj-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: params.name,
      path: params.path,
      icon: params.icon || '📁',
      defaultProviderId: this.defaultProviderConfigId,
      defaultPermissionMode: 'bypassPermissions' as PermissionMode,
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
