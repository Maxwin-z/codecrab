// SOUL API — Identity Store and evolution management
//
// Endpoints:
//   GET    /api/soul           — Get current SOUL document
//   PUT    /api/soul           — Update SOUL document manually
//   POST   /api/soul/evolve    — Trigger SOUL evolution from recent conversations
//   GET    /api/soul/log       — Get evolution history
//   GET    /api/soul/status    — Get identity store status
//   GET    /api/soul/insights  — List insights
//   GET    /api/soul/insights/:topic — Get a specific insight

import { Router, type Router as RouterType } from 'express'
import { IdentityStore } from '../identity/store.js'
import { SoulPipeline } from '../pipeline/soul.js'
import { PromptEvolution } from '../soul/evolution/prompt.js'
import { getDefaultModelConfig } from '../engine/claude.js'

const router: RouterType = Router()
const store = new IdentityStore()

// GET /api/soul — current SOUL document
router.get('/', async (_req, res) => {
  try {
    const soul = await store.loadSoul()
    res.json(soul)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load SOUL', details: String(err) })
  }
})

// PUT /api/soul — manual update
router.put('/', async (req, res) => {
  try {
    const soul = req.body
    if (!soul?.identity || !soul?.preferences || !soul?.meta) {
      res.status(400).json({ error: 'Invalid SOUL document: missing required fields' })
      return
    }
    soul.meta.lastUpdated = new Date().toISOString()
    await store.saveSoul(soul)
    res.json(soul)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save SOUL', details: String(err) })
  }
})

// POST /api/soul/evolve — trigger evolution
router.post('/evolve', async (req, res) => {
  try {
    const { conversations } = req.body
    if (!Array.isArray(conversations) || conversations.length === 0) {
      res.status(400).json({ error: 'conversations array is required and must not be empty' })
      return
    }

    const apiKey = resolveApiKey()
    if (!apiKey) {
      res.status(500).json({ error: 'No API key configured for SOUL evolution' })
      return
    }

    const strategy = new PromptEvolution({ apiKey })
    const pipeline = new SoulPipeline({ strategy, store, apiKey })
    const result = await pipeline.run({ conversations })

    res.json({
      version: result.updatedSoul.meta.version,
      changes: result.changes,
      reasoning: result.reasoning,
    })
  } catch (err) {
    console.error('[SoulAPI] Evolution failed:', err)
    res.status(500).json({ error: 'Evolution failed', details: String(err) })
  }
})

// GET /api/soul/log — evolution history
router.get('/log', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50
    const log = await store.getEvolutionLog(limit)
    res.json(log)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load evolution log', details: String(err) })
  }
})

// GET /api/soul/status — identity store status
router.get('/status', async (_req, res) => {
  try {
    const status = await store.getStatus()
    res.json(status)
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status', details: String(err) })
  }
})

// GET /api/soul/insights — list all insights
router.get('/insights', async (_req, res) => {
  try {
    const topics = await store.listInsights()
    res.json(topics)
  } catch (err) {
    res.status(500).json({ error: 'Failed to list insights', details: String(err) })
  }
})

// GET /api/soul/insights/:topic — get specific insight
router.get('/insights/:topic', async (req, res) => {
  try {
    const content = await store.loadInsight(req.params.topic)
    if (!content) {
      res.status(404).json({ error: 'Insight not found' })
      return
    }
    res.json({ topic: req.params.topic, content })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load insight', details: String(err) })
  }
})

function resolveApiKey(): string | null {
  // Try to get API key from models.json default model config
  const modelConfig = getDefaultModelConfig()
  if (modelConfig?.apiKey) return modelConfig.apiKey

  // Fall back to environment variable
  return process.env.ANTHROPIC_API_KEY || null
}

export default router
