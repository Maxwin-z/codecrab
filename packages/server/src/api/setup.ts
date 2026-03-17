import { Router, type Router as RouterType } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { ModelConfig, ModelSettings, SetupStatus } from '@codecrab/shared'

const router: RouterType = Router()

const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json')
const CLAUDE_DIR = path.join(os.homedir(), '.claude')

async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

async function readModels(): Promise<ModelSettings> {
  try {
    const data = await fs.readFile(MODELS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { models: [] }
  }
}

async function writeModels(settings: ModelSettings) {
  await ensureConfigDir()
  await fs.writeFile(MODELS_FILE, JSON.stringify(settings, null, 2))
}


// GET /api/setup/status — check if initialized
router.get('/status', async (_req, res) => {
  const settings = await readModels()
  const status: SetupStatus = {
    initialized: settings.models.length > 0,
    modelCount: settings.models.length,
  }
  res.json(status)
})

// Note: /api/setup/detect and /api/setup/detect/probe are public endpoints
// defined in setup-detect.ts and mounted in index.ts before auth middleware

// GET /api/setup/models — list configured models (keys masked)
router.get('/models', async (_req, res) => {
  const settings = await readModels()
  const masked = settings.models.map((m: ModelConfig) => ({
    ...m,
    apiKey: m.apiKey ? `${m.apiKey.slice(0, 8)}...${m.apiKey.slice(-4)}` : undefined,
  }))
  res.json({ models: masked, defaultModelId: settings.defaultModelId })
})

// POST /api/setup/models — add a model
router.post('/models', async (req, res) => {
  const { name, provider, apiKey, baseUrl, modelId } = req.body as Partial<ModelConfig>
  if (!name || !provider) {
    res.status(400).json({ error: 'name and provider are required' })
    return
  }

  const settings = await readModels()
  const id = crypto.randomUUID()
  const model: ModelConfig = { id, name, provider, apiKey, baseUrl, modelId }
  settings.models.push(model)

  if (!settings.defaultModelId) {
    settings.defaultModelId = id
  }

  await writeModels(settings)
  res.status(201).json({ id })
})

// PUT /api/setup/models/:id — update a model
router.put('/models/:id', async (req, res) => {
  const settings = await readModels()
  const idx = settings.models.findIndex((m: ModelConfig) => m.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'model not found' })
    return
  }

  const { name, provider, apiKey, baseUrl, modelId } = req.body as Partial<ModelConfig>
  if (name) settings.models[idx].name = name
  if (provider) settings.models[idx].provider = provider
  if (apiKey !== undefined) settings.models[idx].apiKey = apiKey
  if (baseUrl !== undefined) settings.models[idx].baseUrl = baseUrl
  if (modelId !== undefined) settings.models[idx].modelId = modelId

  await writeModels(settings)
  res.json({ ok: true })
})

// DELETE /api/setup/models/:id — remove a model
router.delete('/models/:id', async (req, res) => {
  const settings = await readModels()
  settings.models = settings.models.filter((m: ModelConfig) => m.id !== req.params.id)
  if (settings.defaultModelId === req.params.id) {
    settings.defaultModelId = settings.models[0]?.id
  }
  await writeModels(settings)
  res.json({ ok: true })
})

// PUT /api/setup/default-model — set the default model
router.put('/default-model', async (req, res) => {
  const { modelId } = req.body as { modelId: string }
  const settings = await readModels()
  const exists = settings.models.some((m: ModelConfig) => m.id === modelId)
  if (!exists) {
    res.status(404).json({ error: 'Model not found' })
    return
  }
  settings.defaultModelId = modelId
  await writeModels(settings)
  res.json({ ok: true })
})

// POST /api/setup/use-claude — register CLI subscription as a model account
// Auth is always via ~/.claude (OAuth) — no configDir needed in model config
router.post('/use-claude', async (req, res) => {
  const { subscriptionType } = req.body as { subscriptionType?: string }

  const settings = await readModels()

  // Avoid duplicate: check if a subscription model already exists
  // (legacy: check configDir; new: check provider=anthropic with no apiKey)
  const exists = settings.models.some(
    (m: ModelConfig) => m.configDir === CLAUDE_DIR || (m.provider === 'anthropic' && !m.apiKey)
  )
  if (exists) {
    res.json({ ok: true, message: 'Already configured' })
    return
  }

  const label = subscriptionType
    ? `Claude Code (${subscriptionType})`
    : 'Claude Code'

  const id = crypto.randomUUID()
  const model: ModelConfig = {
    id,
    name: label,
    provider: 'anthropic',
  }
  settings.models.push(model)
  if (!settings.defaultModelId) {
    settings.defaultModelId = id
  }

  await writeModels(settings)
  res.status(201).json({ id })
})

// POST /api/setup/models/:id/test — test if a model's API key is valid
router.post('/models/:id/test', async (req, res) => {
  const settings = await readModels()
  const model = settings.models.find((m: ModelConfig) => m.id === req.params.id)
  if (!model) {
    res.status(404).json({ ok: false, error: 'Model not found' })
    return
  }

  // No API key = CLI OAuth-managed auth — nothing to test via HTTP
  if (!model.apiKey) {
    res.json({ ok: true, skipped: true, message: 'Using CLI OAuth session' })
    return
  }

  try {
    let testUrl: string
    const headers: Record<string, string> = {}

    switch (model.provider) {
      case 'anthropic':
        testUrl = `${model.baseUrl || 'https://api.anthropic.com'}/v1/models`
        headers['x-api-key'] = model.apiKey
        headers['anthropic-version'] = '2023-06-01'
        break
      case 'openai':
        testUrl = `${model.baseUrl || 'https://api.openai.com'}/v1/models`
        headers['Authorization'] = `Bearer ${model.apiKey}`
        break
      case 'google':
        testUrl = `${model.baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models?key=${model.apiKey}`
        break
      case 'custom':
        if (!model.baseUrl) {
          res.json({ ok: false, error: 'No base URL configured' })
          return
        }
        testUrl = `${model.baseUrl.replace(/\/+$/, '')}/v1/models`
        headers['Authorization'] = `Bearer ${model.apiKey}`
        break
      default:
        res.json({ ok: false, error: `Unknown provider: ${model.provider}` })
        return
    }

    const response = await fetch(testUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      res.json({ ok: true })
    } else {
      const text = await response.text()
      let message = `HTTP ${response.status}`
      try {
        const json = JSON.parse(text)
        message = json.error?.message || json.error?.type || json.error || message
      } catch {}
      res.json({ ok: false, error: message })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed'
    res.json({ ok: false, error: message })
  }
})

export default router
