import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionMeta, ProjectConfig, PermissionMode, SessionUsage } from '../types/index.js'
import { createEmptyUsage } from '../types/index.js'

const META_DIR = join(homedir(), '.codecrab', 'session-meta')

export class SessionManager {
  // In-memory cache: sdkSessionId -> SessionMeta
  private metas = new Map<string, SessionMeta>()

  /** Allow overriding the meta directory for testing */
  private metaDir: string

  constructor(metaDir?: string) {
    this.metaDir = metaDir || META_DIR
  }

  async load(): Promise<void> {
    try {
      await mkdir(this.metaDir, { recursive: true })
      const files = await readdir(this.metaDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = await readFile(join(this.metaDir, file), 'utf-8')
          const meta: SessionMeta = JSON.parse(data)
          if (meta.sdkSessionId) {
            this.metas.set(meta.sdkSessionId, meta)
          }
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // META_DIR doesn't exist yet
    }
  }

  /** Create a new session — model is locked at creation time */
  create(
    projectId: string,
    project: ProjectConfig,
    overrides?: {
      model?: string
      permissionMode?: PermissionMode
      cronJobId?: string
      cronJobName?: string
    },
  ): SessionMeta {
    const meta: SessionMeta = {
      sdkSessionId: '', // Will be filled when SDK initializes
      projectId,
      status: 'idle',
      model: overrides?.model || project.defaultModel,
      permissionMode: overrides?.permissionMode || project.defaultPermissionMode,
      cronJobId: overrides?.cronJobId,
      cronJobName: overrides?.cronJobName,
      createdAt: Date.now(),
      usage: createEmptyUsage(),
    }
    return meta
  }

  /** Register a session after SDK initialization provides the sdkSessionId */
  register(sdkSessionId: string, meta: SessionMeta): void {
    meta.sdkSessionId = sdkSessionId
    this.metas.set(sdkSessionId, meta)
  }

  getMeta(sessionId: string): SessionMeta | null {
    return this.metas.get(sessionId) ?? null
  }

  /** List all session metas, optionally filtered by projectId */
  list(projectId?: string): SessionMeta[] {
    const all = Array.from(this.metas.values())
    if (projectId) {
      return all.filter((m) => m.projectId === projectId)
    }
    return all
  }

  /** Update session metadata */
  update(sessionId: string, partial: Partial<SessionMeta>): void {
    const meta = this.metas.get(sessionId)
    if (!meta) return
    Object.assign(meta, partial)
  }

  /** Set session status */
  setStatus(sessionId: string, status: 'idle' | 'processing' | 'error'): void {
    this.update(sessionId, { status })
  }

  /** Set pending question */
  setPendingQuestion(sessionId: string, toolId: string, questions: any[]): void {
    this.update(sessionId, { pendingQuestion: { toolId, questions } })
  }

  /** Clear pending question */
  clearPendingQuestion(sessionId: string): void {
    this.update(sessionId, { pendingQuestion: null })
  }

  /** Set pending permission request */
  setPendingPermission(
    sessionId: string,
    request: {
      requestId: string
      toolName: string
      input: unknown
      reason?: string
    },
  ): void {
    this.update(sessionId, { pendingPermissionRequest: request })
  }

  /** Clear pending permission request */
  clearPendingPermission(sessionId: string): void {
    this.update(sessionId, { pendingPermissionRequest: null })
  }

  /** Update cumulative usage after a turn completes */
  addUsage(
    sessionId: string,
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreateTokens: number
      costUsd: number
      durationMs: number
      contextWindowUsed: number
      contextWindowMax: number
    },
  ): void {
    const meta = this.metas.get(sessionId)
    if (!meta) return
    meta.usage.totalInputTokens += usage.inputTokens
    meta.usage.totalOutputTokens += usage.outputTokens
    meta.usage.totalCacheReadTokens += usage.cacheReadTokens
    meta.usage.totalCacheCreateTokens += usage.cacheCreateTokens
    meta.usage.totalCostUsd += usage.costUsd
    meta.usage.totalDurationMs += usage.durationMs
    meta.usage.queryCount += 1
    meta.usage.contextWindowUsed = usage.contextWindowUsed
    meta.usage.contextWindowMax = usage.contextWindowMax
  }

  /** Delete a session's metadata */
  async delete(sessionId: string): Promise<void> {
    this.metas.delete(sessionId)
    try {
      await unlink(join(this.metaDir, `${sessionId}.json`))
    } catch {
      // File may not exist
    }
  }

  /** Persist a session's metadata to disk */
  async persist(sessionId: string): Promise<void> {
    const meta = this.metas.get(sessionId)
    if (!meta) return
    await mkdir(this.metaDir, { recursive: true })
    await writeFile(join(this.metaDir, `${sessionId}.json`), JSON.stringify(meta, null, 2))
  }

  /** Find active session for a project (status === 'processing') */
  findActive(projectId: string): SessionMeta | null {
    for (const meta of this.metas.values()) {
      if (meta.projectId === projectId && meta.status === 'processing') {
        return meta
      }
    }
    return null
  }

  /** Find or get the most recent session for a project */
  findLatest(projectId: string): SessionMeta | null {
    let latest: SessionMeta | null = null
    for (const meta of this.metas.values()) {
      if (meta.projectId === projectId) {
        if (!latest || meta.createdAt > latest.createdAt) {
          latest = meta
        }
      }
    }
    return latest
  }
}
