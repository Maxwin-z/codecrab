import { Router, type Request, type Response } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { CoreEngine } from '../core/index.js'
import { ProjectValidationError, ProjectConflictError, ProjectNotFoundError } from '../core/project.js'
import { authMiddleware, getToken, validateToken, generateToken, readConfig, writeConfig } from './auth.js'
import type { ModelConfig, ModelSettings, DetectResult } from '@codecrab/shared'

const execFileAsync = promisify(execFile)
const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json')
const CLAUDE_DIR = path.join(os.homedir(), '.claude')

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output',
])

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

export function createRouter(core: CoreEngine): Router {
  const router = Router()

  // ====== Public routes (no auth) ======

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '2.0.0' })
  })

  router.get('/api/discovery', (_req: Request, res: Response) => {
    res.json({ service: 'codecrab', version: '2.0.0' })
  })

  router.get('/api/auth/status', async (_req: Request, res: Response) => {
    const config = await readConfig()
    res.json({ hasToken: !!config.token })
  })

  router.post('/api/auth/verify', async (req: Request, res: Response) => {
    const { token } = req.body as { token?: string }
    if (!token) {
      res.status(400).json({ valid: false })
      return
    }
    const valid = await validateToken(token)
    res.json({ valid })
  })

  router.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const { token } = req.body as { token?: string }
    if (!token || !(await validateToken(token))) {
      res.status(401).json({ error: 'Invalid current token' })
      return
    }
    const newToken = generateToken()
    const config = await readConfig()
    await writeConfig({ ...config, token: newToken })
    res.json({ token: newToken })
  })

  // Setup detect (public)
  router.get('/api/setup/detect', async (_req: Request, res: Response) => {
    let claudeCodeInstalled = false
    try {
      await fs.access(CLAUDE_DIR)
      claudeCodeInstalled = true
    } catch {}
    res.json({ claudeCodeInstalled })
  })

  router.get('/api/setup/detect/probe', async (_req: Request, res: Response) => {
    const result: DetectResult = {
      claudeCodeInstalled: false,
      cliAvailable: false,
      configDir: CLAUDE_DIR,
    }
    try {
      await fs.access(CLAUDE_DIR)
      result.claudeCodeInstalled = true
    } catch {
      res.json(result)
      return
    }
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 })
      result.cliAvailable = true
      result.cliVersion = stdout.trim().split(' ')[0]
    } catch {
      res.json(result)
      return
    }
    try {
      const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 5000 })
      const authData = JSON.parse(stdout.trim())
      result.auth = {
        loggedIn: authData.loggedIn ?? false,
        authMethod: authData.authMethod,
        subscriptionType: authData.subscriptionType,
      }
    } catch {
      result.auth = { loggedIn: false }
    }
    res.json(result)
  })

  // ====== Protected routes (require auth) ======

  router.use('/api/projects', authMiddleware)
  router.use('/api/sessions', authMiddleware)
  router.use('/api/models', authMiddleware)
  router.use('/api/setup', authMiddleware)

  // Projects
  router.get('/api/projects', (_req: Request, res: Response) => {
    const projects = core.projects.list()
    res.json(projects)
  })

  router.post('/api/projects', async (req: Request, res: Response) => {
    const { name, path: projectPath, icon } = req.body as {
      name?: string
      path?: string
      icon?: string
    }
    try {
      const project = await core.projects.create({
        name: name || '',
        path: projectPath || '',
        icon,
      })
      res.status(201).json(project)
    } catch (err) {
      if (err instanceof ProjectValidationError) {
        res.status(400).json({ error: err.message })
      } else if (err instanceof ProjectConflictError) {
        res.status(409).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.get('/api/projects/:id', (req: Request, res: Response) => {
    const id = req.params.id as string
    const project = core.projects.get(id)
    if (!project) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json(project)
  })

  router.patch('/api/projects/:id', async (req: Request, res: Response) => {
    const { name, icon } = req.body as { name?: string; icon?: string }
    try {
      const project = await core.projects.update(req.params.id as string, { name, icon })
      res.json(project)
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.delete('/api/projects/:id', async (req: Request, res: Response) => {
    try {
      await core.projects.delete(req.params.id as string)
      res.status(204).end()
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  // Sessions
  router.get('/api/sessions', async (req: Request, res: Response) => {
    const projectId = req.query.projectId as string | undefined
    if (projectId) {
      const projectPath = core.projects.getPath(projectId)
      if (projectPath) {
        const sessions = await core.sessions.listForProject(projectId, projectPath)
        res.json(sessions)
        return
      }
    }
    // Fallback: return metas from in-memory cache
    const sessions = core.sessions.list(projectId)
    res.json(sessions)
  })

  router.get('/api/sessions/:id/history', async (req: Request, res: Response) => {
    const sessionId = req.params.id as string
    // Find project path for the session (check meta first, then try all projects)
    const meta = core.sessions.getMeta(sessionId)
    const projectPath = meta?.projectId ? core.projects.getPath(meta.projectId) : undefined
    try {
      const messages = await core.sessions.getHistory(sessionId, projectPath || undefined)
      res.json({ sessionId, messages })
    } catch {
      res.json({ sessionId, messages: [] })
    }
  })

  router.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string
    await core.sessions.delete(id)
    res.json({ ok: true })
  })

  // Setup — model management
  router.get('/api/setup/status', async (_req: Request, res: Response) => {
    const settings = await readModels()
    res.json({ initialized: settings.models.length > 0, modelCount: settings.models.length })
  })

  router.get('/api/setup/models', async (_req: Request, res: Response) => {
    const settings = await readModels()
    const masked = settings.models.map((m: ModelConfig) => ({
      ...m,
      apiKey: m.apiKey ? `${m.apiKey.slice(0, 8)}...${m.apiKey.slice(-4)}` : undefined,
    }))
    res.json({ models: masked, defaultModelId: settings.defaultModelId })
  })

  router.post('/api/setup/models', async (req: Request, res: Response) => {
    const { name, provider, apiKey, baseUrl, modelId } = req.body as Partial<ModelConfig>
    if (!name || !provider) {
      res.status(400).json({ error: 'name and provider are required' })
      return
    }
    const settings = await readModels()
    const id = crypto.randomUUID()
    const model: ModelConfig = { id, name, provider, apiKey, baseUrl, modelId }
    settings.models.push(model)
    if (!settings.defaultModelId) settings.defaultModelId = id
    await writeModels(settings)
    res.status(201).json({ id })
  })

  router.put('/api/setup/models/:id', async (req: Request, res: Response) => {
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

  router.delete('/api/setup/models/:id', async (req: Request, res: Response) => {
    const settings = await readModels()
    settings.models = settings.models.filter((m: ModelConfig) => m.id !== req.params.id)
    if (settings.defaultModelId === req.params.id) {
      settings.defaultModelId = settings.models[0]?.id
    }
    await writeModels(settings)
    res.json({ ok: true })
  })

  router.put('/api/setup/default-model', async (req: Request, res: Response) => {
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

  router.post('/api/setup/use-claude', async (req: Request, res: Response) => {
    const { subscriptionType } = req.body as { subscriptionType?: string }
    const settings = await readModels()
    const exists = settings.models.some(
      (m: ModelConfig) => m.provider === 'anthropic' && !m.apiKey
    )
    if (exists) {
      res.json({ ok: true, message: 'Already configured' })
      return
    }
    const label = subscriptionType ? `Claude Code (${subscriptionType})` : 'Claude Code'
    const id = crypto.randomUUID()
    const model: ModelConfig = { id, name: label, provider: 'anthropic' }
    settings.models.push(model)
    if (!settings.defaultModelId) settings.defaultModelId = id
    await writeModels(settings)
    res.status(201).json({ id })
  })

  router.post('/api/setup/models/:id/test', async (req: Request, res: Response) => {
    const settings = await readModels()
    const model = settings.models.find((m: ModelConfig) => m.id === req.params.id)
    if (!model) {
      res.status(404).json({ ok: false, error: 'Model not found' })
      return
    }
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
      const response = await fetch(testUrl, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) })
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
      res.json({ ok: false, error: err instanceof Error ? err.message : 'Connection failed' })
    }
  })

  // ====== Files API (directory browsing for project creation) ======

  router.use('/api/files', authMiddleware)

  router.get('/api/files', async (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || os.homedir()
    try {
      const resolved = path.resolve(dirPath)
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .filter(e => !e.isDirectory() || !SKIP_DIRS.has(e.name))
        .map(e => ({
          name: e.name,
          path: path.join(resolved, e.name),
          isDirectory: e.isDirectory(),
        }))
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      res.json({ current: resolved, parent: path.dirname(resolved), items })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.post('/api/files/mkdir', async (req: Request, res: Response) => {
    const { path: dirPath, name } = req.body as { path?: string; name?: string }
    if (!dirPath || !name) {
      res.status(400).json({ error: 'Missing path or name' })
      return
    }
    try {
      const resolved = path.resolve(dirPath)
      const newDirPath = path.join(resolved, name)
      await fs.mkdir(newDirPath, { recursive: true })
      res.json({ success: true, path: newDirPath })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}
