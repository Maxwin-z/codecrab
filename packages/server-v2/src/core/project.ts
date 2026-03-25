import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProjectConfig, PermissionMode } from '../types/index.js'

const CONFIG_DIR = join(homedir(), '.codecrab')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const MODELS_FILE = join(CONFIG_DIR, 'models.json')

export class ProjectManager {
  private projects = new Map<string, ProjectConfig>()
  private projectModels = new Map<string, string>() // projectId -> model override
  private defaultModel = 'claude-sonnet-4-6'

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
        this.defaultModel = settings.defaultModelId
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
    for (const [id, config] of this.projects) {
      const override = this.projectModels.get(id)
      config.defaultModel = override || this.defaultModel
    }
  }

  private toConfig(raw: any): ProjectConfig {
    const modelOverride = this.projectModels.get(raw.id)
    return {
      id: raw.id,
      name: raw.name,
      path: raw.path,
      icon: raw.icon || '',
      defaultModel: modelOverride || this.defaultModel,
      defaultPermissionMode: 'default' as PermissionMode,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now(),
      lastActivityAt: raw.lastActivityAt,
    }
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
    return this.projectModels.get(projectId) || this.defaultModel
  }
}
