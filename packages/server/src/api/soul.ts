// SOUL API — Read/write SOUL profile (Markdown) and trigger evolution
//
// Endpoints:
//   GET    /api/soul           — Get current SOUL document (content + meta)
//   PUT    /api/soul           — Update SOUL document manually
//   POST   /api/soul/evolve    — Trigger SOUL evolution via SoulAgent
//   GET    /api/soul/log       — Get evolution history
//   GET    /api/soul/status    — Get SOUL status
//   GET    /api/soul/settings  — Get SOUL settings (evolution toggle etc.)
//   PUT    /api/soul/settings  — Update SOUL settings
//   GET    /api/soul/insights  — List insights
//   GET    /api/soul/insights/:topic — Get a specific insight

import { Router, type Router as RouterType } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { ensureSoulProject, getSoulProjectDir } from '../soul/project.js'
import { parseSoulMarkdown, serializeSoulMarkdown } from '../soul/markdown.js'
import { SOUL_MAX_LENGTH } from '../soul/types.js'
import { triggerSoulEvolution } from '../soul/agent.js'
import { loadSoulSettings, saveSoulSettings } from '../soul/settings.js'
import type { SoulDocument, EvolutionEntry } from '../soul/types.js'

const router: RouterType = Router()

function soulPath(): string {
  return path.join(getSoulProjectDir(), 'SOUL.md')
}

function logPath(): string {
  return path.join(getSoulProjectDir(), 'evolution-log.jsonl')
}

function insightsDir(): string {
  return path.join(getSoulProjectDir(), 'insights')
}

function loadSoul(): SoulDocument {
  ensureSoulProject()
  const raw = fs.readFileSync(soulPath(), 'utf-8')
  return parseSoulMarkdown(raw)
}

function saveSoul(doc: SoulDocument): void {
  ensureSoulProject()
  fs.writeFileSync(soulPath(), serializeSoulMarkdown(doc), 'utf-8')
}

// GET /api/soul — current SOUL document
router.get('/', (_req, res) => {
  try {
    const soul = loadSoul()
    res.json(soul)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load SOUL', details: String(err) })
  }
})

// PUT /api/soul — manual update
router.put('/', (req, res) => {
  try {
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content field (string) is required' })
      return
    }
    if (content.length > SOUL_MAX_LENGTH) {
      res.status(400).json({ error: `Content exceeds ${SOUL_MAX_LENGTH} character limit (got ${content.length})` })
      return
    }

    // Load existing to get current version, then bump
    const existing = loadSoul()
    const doc: SoulDocument = {
      content,
      meta: {
        version: existing.meta.version + 1,
        lastUpdated: new Date().toISOString(),
      },
    }
    saveSoul(doc)
    res.json(doc)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save SOUL', details: String(err) })
  }
})

// POST /api/soul/evolve — trigger evolution via SoulAgent
router.post('/evolve', async (req, res) => {
  try {
    const { conversations } = req.body
    if (!Array.isArray(conversations) || conversations.length === 0) {
      res.status(400).json({ error: 'conversations array is required and must not be empty' })
      return
    }

    const result = await triggerSoulEvolution(conversations)

    res.json({
      triggered: result.triggered,
      output: result.output,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      error: result.error,
    })
  } catch (err) {
    console.error('[SoulAPI] Evolution failed:', err)
    res.status(500).json({ error: 'Evolution failed', details: String(err) })
  }
})

// GET /api/soul/log — evolution history
router.get('/log', (req, res) => {
  try {
    ensureSoulProject()
    const limit = Number(req.query.limit) || 50
    const content = fs.readFileSync(logPath(), 'utf-8').trim()
    if (!content) {
      res.json([])
      return
    }
    const entries: EvolutionEntry[] = content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean) as EvolutionEntry[]

    // Return the most recent entries
    res.json(entries.slice(-limit))
  } catch (err) {
    res.status(500).json({ error: 'Failed to load evolution log', details: String(err) })
  }
})

// GET /api/soul/status — SOUL status
router.get('/status', (_req, res) => {
  try {
    ensureSoulProject()
    const soul = loadSoul()
    // Consider soul as "active" if there's meaningful content beyond empty headings
    const meaningfulContent = soul.content.replace(/^#.*$/gm, '').trim()
    const hasSoul = meaningfulContent.length > 0

    // Count evolution log entries
    let evolutionCount = 0
    try {
      const content = fs.readFileSync(logPath(), 'utf-8').trim()
      if (content) {
        evolutionCount = content.split('\n').filter(Boolean).length
      }
    } catch { /* empty log */ }

    // Count insights
    let insightCount = 0
    try {
      const files = fs.readdirSync(insightsDir())
      insightCount = files.filter((f) => f.endsWith('.md')).length
    } catch { /* no insights dir */ }

    res.json({
      hasSoul,
      soulVersion: soul.meta.version,
      evolutionCount,
      insightCount,
      contentLength: soul.content.length,
      maxLength: SOUL_MAX_LENGTH,
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status', details: String(err) })
  }
})

// GET /api/soul/settings — get soul settings
router.get('/settings', (_req, res) => {
  try {
    ensureSoulProject()
    res.json(loadSoulSettings())
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings', details: String(err) })
  }
})

// PUT /api/soul/settings — update soul settings
router.put('/settings', (req, res) => {
  try {
    ensureSoulProject()
    const current = loadSoulSettings()
    if (typeof req.body.evolutionEnabled === 'boolean') {
      current.evolutionEnabled = req.body.evolutionEnabled
    }
    saveSoulSettings(current)
    res.json(current)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings', details: String(err) })
  }
})

// GET /api/soul/insights — list all insights
router.get('/insights', (_req, res) => {
  try {
    ensureSoulProject()
    const dir = insightsDir()
    const files = fs.readdirSync(dir)
    const topics = files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
    res.json(topics)
  } catch (err) {
    res.status(500).json({ error: 'Failed to list insights', details: String(err) })
  }
})

// GET /api/soul/insights/:topic — get specific insight
router.get('/insights/:topic', (req, res) => {
  try {
    ensureSoulProject()
    const filePath = path.join(insightsDir(), `${req.params.topic}.md`)
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Insight not found' })
      return
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    res.json({ topic: req.params.topic, content })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load insight', details: String(err) })
  }
})

export default router
