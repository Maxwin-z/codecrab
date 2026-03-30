import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { extname } from 'node:path'
import type {
  Thread, ThreadStatus, ThreadConfig, ThreadParticipant,
  ThreadMessage, AgentRef, ArtifactRef, Artifact,
} from '../types/index.js'

const DEFAULT_THREADS_DIR = join(homedir(), '.codecrab', 'threads')
const DEFAULT_MAX_TURNS = 10

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'text/typescript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
}

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_MAP[ext] || 'text/plain'
}

/**
 * Ensure a filename has a proper extension.
 * If no extension is present, infer from content or default to .md.
 */
function normalizeArtifactName(name: string, content: string): string {
  const ext = extname(name).toLowerCase()
  if (ext && MIME_MAP[ext]) return name // already has a known extension

  // Try to detect from content
  const trimmed = content.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(content); return `${name}.json` } catch { /* not json */ }
  }
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return `${name}.html`
  if (trimmed.startsWith('<?xml')) return `${name}.xml`

  // Default: markdown for documents
  return `${name}.md`
}

export class ThreadManager {
  private threads = new Map<string, Thread>()
  private messages = new Map<string, ThreadMessage[]>()
  private artifacts = new Map<string, Artifact[]>()
  private threadsDir: string

  constructor(threadsDir?: string) {
    this.threadsDir = threadsDir || DEFAULT_THREADS_DIR
  }

  // ── Load / Persist ──────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      await mkdir(this.threadsDir, { recursive: true })
      const indexPath = join(this.threadsDir, 'index.json')
      let indexEntries: Array<{ id: string }> = []
      try {
        const data = await readFile(indexPath, 'utf-8')
        indexEntries = JSON.parse(data)
      } catch {
        // No index yet
        return
      }

      for (const entry of indexEntries) {
        try {
          const threadDir = join(this.threadsDir, entry.id)
          const threadData = await readFile(join(threadDir, 'thread.json'), 'utf-8')
          const thread: Thread = JSON.parse(threadData)
          this.threads.set(thread.id, thread)

          // Load messages
          const messagesDir = join(threadDir, 'messages')
          try {
            const msgFiles = await readdir(messagesDir)
            const msgs: ThreadMessage[] = []
            for (const f of msgFiles.filter(f => f.endsWith('.json')).sort()) {
              try {
                const msgData = await readFile(join(messagesDir, f), 'utf-8')
                msgs.push(JSON.parse(msgData))
              } catch { /* skip corrupted */ }
            }
            this.messages.set(thread.id, msgs)
          } catch {
            this.messages.set(thread.id, [])
          }

          // Load artifacts metadata
          const artifactsMetaPath = join(threadDir, 'artifacts.json')
          try {
            const artData = await readFile(artifactsMetaPath, 'utf-8')
            this.artifacts.set(thread.id, JSON.parse(artData))
          } catch {
            this.artifacts.set(thread.id, [])
          }
        } catch {
          // Skip corrupted thread
        }
      }
    } catch {
      // Threads dir doesn't exist yet
    }
  }

  private async persistThread(thread: Thread): Promise<void> {
    const threadDir = join(this.threadsDir, thread.id)
    await mkdir(threadDir, { recursive: true })
    await writeFile(join(threadDir, 'thread.json'), JSON.stringify(thread, null, 2))
    await this.persistIndex()
  }

  private async persistIndex(): Promise<void> {
    const entries = Array.from(this.threads.values()).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      parentThreadId: t.parentThreadId,
      updatedAt: t.updatedAt,
    }))
    await mkdir(this.threadsDir, { recursive: true })
    await writeFile(join(this.threadsDir, 'index.json'), JSON.stringify(entries, null, 2))
  }

  private async persistArtifacts(threadId: string): Promise<void> {
    const threadDir = join(this.threadsDir, threadId)
    const arts = this.artifacts.get(threadId) || []
    await writeFile(join(threadDir, 'artifacts.json'), JSON.stringify(arts, null, 2))
  }

  // ── Thread CRUD ─────────────────────────────────────────────────────────

  create(title: string, parentThreadId?: string, config?: Partial<ThreadConfig>): Thread {
    const now = Date.now()
    const thread: Thread = {
      id: generateId('thread'),
      title,
      parentThreadId: parentThreadId || null,
      status: 'active',
      participants: [],
      config: {
        maxTurns: config?.maxTurns ?? DEFAULT_MAX_TURNS,
      },
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.threads.set(thread.id, thread)
    this.messages.set(thread.id, [])
    this.artifacts.set(thread.id, [])
    // Fire-and-forget persist
    this.persistThread(thread).catch(() => {})
    return thread
  }

  get(threadId: string): Thread | null {
    return this.threads.get(threadId) ?? null
  }

  list(filters?: { status?: ThreadStatus; agentId?: string }): Thread[] {
    let result = Array.from(this.threads.values())
    if (filters?.status) {
      result = result.filter(t => t.status === filters.status)
    }
    if (filters?.agentId) {
      result = result.filter(t => t.participants.some(p => p.agentId === filters.agentId))
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ── Participant management ──────────────────────────────────────────────

  addParticipant(threadId: string, agentId: string, agentName: string, sessionId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return

    // Don't add duplicate
    if (thread.participants.some(p => p.agentId === agentId)) return

    const now = Date.now()
    thread.participants.push({ agentId, agentName, sessionId, joinedAt: now, lastActiveAt: now })
    thread.updatedAt = now
    this.persistThread(thread).catch(() => {})
  }

  getParticipantSession(threadId: string, agentId: string): string | null {
    const thread = this.threads.get(threadId)
    if (!thread) return null
    const p = thread.participants.find(p => p.agentId === agentId)
    return p?.sessionId ?? null
  }

  updateParticipantActivity(threadId: string, agentId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const p = thread.participants.find(p => p.agentId === agentId)
    if (p) {
      p.lastActiveAt = Date.now()
    }
  }

  // ── Status management ──────────────────────────────────────────────────

  complete(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    thread.status = 'completed'
    thread.updatedAt = Date.now()
    this.persistThread(thread).catch(() => {})
  }

  stall(threadId: string, _reason: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    thread.status = 'stalled'
    thread.updatedAt = Date.now()
    this.persistThread(thread).catch(() => {})
  }

  updateConfig(threadId: string, config: Partial<ThreadConfig>): Thread | null {
    const thread = this.threads.get(threadId)
    if (!thread) return null
    if (config.maxTurns !== undefined) {
      thread.config.maxTurns = config.maxTurns
    }
    thread.updatedAt = Date.now()
    this.persistThread(thread).catch(() => {})
    return thread
  }

  // ── Query ───────────────────────────────────────────────────────────────

  getThreadsByAgent(agentId: string): Thread[] {
    return this.list({ agentId })
  }

  getChildThreads(parentThreadId: string): Thread[] {
    return Array.from(this.threads.values())
      .filter(t => t.parentThreadId === parentThreadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ── Message management ──────────────────────────────────────────────────

  async saveMessage(message: ThreadMessage): Promise<void> {
    const msgs = this.messages.get(message.threadId)
    if (!msgs) return
    msgs.push(message)

    // Update thread timestamp
    const thread = this.threads.get(message.threadId)
    if (thread) {
      thread.updatedAt = Date.now()
      this.persistThread(thread).catch(() => {})
    }

    // Persist message file
    const messagesDir = join(this.threadsDir, message.threadId, 'messages')
    await mkdir(messagesDir, { recursive: true })
    const filename = `${message.createdAt}-${message.id}.json`
    await writeFile(join(messagesDir, filename), JSON.stringify(message, null, 2))
  }

  getMessages(threadId: string, limit?: number): ThreadMessage[] {
    const msgs = this.messages.get(threadId) || []
    if (limit && limit > 0) {
      return msgs.slice(-limit)
    }
    return [...msgs]
  }

  // ── Turn count ──────────────────────────────────────────────────────────

  getTurnCount(threadId: string): number {
    const thread = this.threads.get(threadId)
    return thread?.turnCount ?? 0
  }

  incrementTurnCount(threadId: string): number {
    const thread = this.threads.get(threadId)
    if (!thread) return 0
    thread.turnCount++
    thread.updatedAt = Date.now()
    this.persistThread(thread).catch(() => {})
    return thread.turnCount
  }

  // ── Artifact management ─────────────────────────────────────────────────

  async saveArtifact(
    threadId: string,
    name: string,
    content: string,
    createdBy: AgentRef,
  ): Promise<Artifact> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    // Ensure filename always has a proper extension
    const normalizedName = normalizeArtifactName(name, content)

    const artifactsDir = join(this.threadsDir, threadId, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })

    const filePath = join(artifactsDir, normalizedName)
    await writeFile(filePath, content)

    const mimeType = getMimeType(normalizedName)
    const artifact: Artifact = {
      id: generateId('artifact'),
      threadId,
      name: normalizedName,
      mimeType,
      createdBy,
      path: filePath,
      size: Buffer.byteLength(content),
      createdAt: Date.now(),
    }

    const arts = this.artifacts.get(threadId) || []
    // Replace existing artifact with same name (version update)
    const existingIdx = arts.findIndex(a => a.name === normalizedName)
    if (existingIdx >= 0) {
      arts[existingIdx] = artifact
    } else {
      arts.push(artifact)
    }
    this.artifacts.set(threadId, arts)
    await this.persistArtifacts(threadId)

    return artifact
  }

  listArtifacts(threadId: string): Artifact[] {
    return this.artifacts.get(threadId) || []
  }

  getArtifactById(artifactId: string): Artifact | null {
    for (const arts of this.artifacts.values()) {
      const found = arts.find(a => a.id === artifactId)
      if (found) return found
    }
    return null
  }
}
