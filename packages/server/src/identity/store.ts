// Identity Store — Persistence for SOUL, evolution logs, and insights
//
// Layer 1a in the architecture: long-term, cross-project, per-user.
// Stored in ~/.codeclaws/soul/, ~/.codeclaws/insights/

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { SoulDocument, EvolutionEntry } from '../soul/types.js'
import { createDefaultSoul } from '../soul/types.js'

const CODECLAWS_DIR = path.join(os.homedir(), '.codeclaws')
const SOUL_DIR = path.join(CODECLAWS_DIR, 'soul')
const SOUL_FILE = path.join(SOUL_DIR, 'SOUL.json')
const EVOLUTION_LOG_FILE = path.join(SOUL_DIR, 'evolution-log.jsonl')
const INSIGHTS_DIR = path.join(CODECLAWS_DIR, 'insights')

export class IdentityStore {
  private ensuredDirs = false

  private ensureDirs(): void {
    if (this.ensuredDirs) return
    for (const dir of [SOUL_DIR, INSIGHTS_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.ensuredDirs = true
  }

  // --- SOUL ---

  async loadSoul(): Promise<SoulDocument> {
    this.ensureDirs()
    try {
      if (!fs.existsSync(SOUL_FILE)) {
        return createDefaultSoul()
      }
      const data = fs.readFileSync(SOUL_FILE, 'utf-8')
      return JSON.parse(data) as SoulDocument
    } catch (err) {
      console.error('[IdentityStore] Failed to load SOUL:', err)
      return createDefaultSoul()
    }
  }

  async saveSoul(soul: SoulDocument): Promise<void> {
    this.ensureDirs()
    fs.writeFileSync(SOUL_FILE, JSON.stringify(soul, null, 2))
  }

  // --- Evolution Log ---

  async appendEvolutionLog(entry: EvolutionEntry): Promise<void> {
    this.ensureDirs()
    const line = JSON.stringify(entry) + '\n'
    fs.appendFileSync(EVOLUTION_LOG_FILE, line)
  }

  async getEvolutionLog(limit = 50): Promise<EvolutionEntry[]> {
    this.ensureDirs()
    if (!fs.existsSync(EVOLUTION_LOG_FILE)) {
      return []
    }
    const content = fs.readFileSync(EVOLUTION_LOG_FILE, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim()).slice(-limit)
    return lines.map((l) => JSON.parse(l) as EvolutionEntry)
  }

  // --- Insights ---

  async saveInsight(topic: string, content: string): Promise<void> {
    this.ensureDirs()
    const filePath = path.join(INSIGHTS_DIR, `${sanitizeFilename(topic)}.md`)
    fs.writeFileSync(filePath, content)
  }

  async loadInsight(topic: string): Promise<string | null> {
    this.ensureDirs()
    const filePath = path.join(INSIGHTS_DIR, `${sanitizeFilename(topic)}.md`)
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  }

  async listInsights(): Promise<string[]> {
    this.ensureDirs()
    if (!fs.existsSync(INSIGHTS_DIR)) return []
    return fs.readdirSync(INSIGHTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  }

  // --- Status ---

  async getStatus(): Promise<{
    hasSoul: boolean
    soulVersion: number
    evolutionCount: number
    insightCount: number
  }> {
    const soul = await this.loadSoul()
    const log = await this.getEvolutionLog(0)
    const insights = await this.listInsights()
    return {
      hasSoul: fs.existsSync(SOUL_FILE),
      soulVersion: soul.meta.version,
      evolutionCount: log.length,
      insightCount: insights.length,
    }
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '-').toLowerCase()
}
