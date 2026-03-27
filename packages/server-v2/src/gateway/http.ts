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
import type { ProviderConfig, ProviderSettings, DetectResult } from '@codecrab/shared'

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

async function readProviders(): Promise<ProviderSettings> {
  try {
    const data = await fs.readFile(MODELS_FILE, 'utf-8')
    const raw = JSON.parse(data)
    // Backward compat: normalize old field names
    return {
      providers: raw.providers || raw.models || [],
      defaultProviderId: raw.defaultProviderId || raw.defaultModelId,
    }
  } catch {
    return { providers: [] }
  }
}

async function writeProviders(settings: ProviderSettings) {
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
    if (!valid) {
      res.status(401).json({ valid: false })
      return
    }
    res.json({ valid: true })
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
  router.use('/api/providers', authMiddleware)
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

  // Setup — provider management
  router.get('/api/setup/status', async (_req: Request, res: Response) => {
    const settings = await readProviders()
    res.json({ initialized: settings.providers.length > 0, providerCount: settings.providers.length })
  })

  router.get('/api/setup/providers', async (_req: Request, res: Response) => {
    const settings = await readProviders()
    const masked = settings.providers.map((p: ProviderConfig) => ({
      ...p,
      apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}...${p.apiKey.slice(-4)}` : undefined,
    }))
    res.json({ providers: masked, defaultProviderId: settings.defaultProviderId })
  })

  router.post('/api/setup/providers', async (req: Request, res: Response) => {
    const { name, provider, apiKey, baseUrl, modelId } = req.body as Partial<ProviderConfig>
    if (!name || !provider) {
      res.status(400).json({ error: 'name and provider are required' })
      return
    }
    const settings = await readProviders()
    const id = crypto.randomUUID()
    const entry: ProviderConfig = { id, name, provider, apiKey, baseUrl, modelId }
    settings.providers.push(entry)
    if (!settings.defaultProviderId) settings.defaultProviderId = id
    await writeProviders(settings)
    res.status(201).json({ id })
  })

  router.put('/api/setup/providers/:id', async (req: Request, res: Response) => {
    const settings = await readProviders()
    const idx = settings.providers.findIndex((p: ProviderConfig) => p.id === req.params.id)
    if (idx === -1) {
      res.status(404).json({ error: 'Provider not found' })
      return
    }
    const { name, provider, apiKey, baseUrl, modelId } = req.body as Partial<ProviderConfig>
    if (name) settings.providers[idx].name = name
    if (provider) settings.providers[idx].provider = provider
    if (apiKey !== undefined) settings.providers[idx].apiKey = apiKey
    if (baseUrl !== undefined) settings.providers[idx].baseUrl = baseUrl
    if (modelId !== undefined) settings.providers[idx].modelId = modelId
    await writeProviders(settings)
    res.json({ ok: true })
  })

  router.delete('/api/setup/providers/:id', async (req: Request, res: Response) => {
    const settings = await readProviders()
    settings.providers = settings.providers.filter((p: ProviderConfig) => p.id !== req.params.id)
    if (settings.defaultProviderId === req.params.id) {
      settings.defaultProviderId = settings.providers[0]?.id
    }
    await writeProviders(settings)
    res.json({ ok: true })
  })

  router.put('/api/setup/default-provider', async (req: Request, res: Response) => {
    const { providerId } = req.body as { providerId: string }
    const settings = await readProviders()
    const exists = settings.providers.some((p: ProviderConfig) => p.id === providerId)
    if (!exists) {
      res.status(404).json({ error: 'Provider not found' })
      return
    }
    settings.defaultProviderId = providerId
    await writeProviders(settings)
    res.json({ ok: true })
  })

  router.post('/api/setup/use-claude', async (req: Request, res: Response) => {
    const { subscriptionType } = req.body as { subscriptionType?: string }
    const settings = await readProviders()
    const exists = settings.providers.some(
      (p: ProviderConfig) => p.provider === 'anthropic' && !p.apiKey
    )
    if (exists) {
      res.json({ ok: true, message: 'Already configured' })
      return
    }
    const label = subscriptionType ? `Claude Code (${subscriptionType})` : 'Claude Code'
    const id = crypto.randomUUID()
    const entry: ProviderConfig = { id, name: label, provider: 'anthropic' }
    settings.providers.push(entry)
    if (!settings.defaultProviderId) settings.defaultProviderId = id
    await writeProviders(settings)
    res.status(201).json({ id })
  })

  router.post('/api/setup/providers/:id/test', async (req: Request, res: Response) => {
    const settings = await readProviders()
    const entry = settings.providers.find((p: ProviderConfig) => p.id === req.params.id)
    if (!entry) {
      res.status(404).json({ ok: false, error: 'Provider not found' })
      return
    }
    if (!entry.apiKey) {
      res.json({ ok: true, skipped: true, message: 'Using CLI OAuth session' })
      return
    }
    try {
      let testUrl: string
      const headers: Record<string, string> = {}
      switch (entry.provider) {
        case 'anthropic':
          testUrl = `${entry.baseUrl || 'https://api.anthropic.com'}/v1/models`
          headers['x-api-key'] = entry.apiKey
          headers['anthropic-version'] = '2023-06-01'
          break
        case 'openai':
          testUrl = `${entry.baseUrl || 'https://api.openai.com'}/v1/models`
          headers['Authorization'] = `Bearer ${entry.apiKey}`
          break
        case 'google':
          testUrl = `${entry.baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models?key=${entry.apiKey}`
          break
        case 'custom':
          if (!entry.baseUrl) {
            res.json({ ok: false, error: 'No base URL configured' })
            return
          }
          testUrl = `${entry.baseUrl.replace(/\/+$/, '')}/v1/models`
          headers['Authorization'] = `Bearer ${entry.apiKey}`
          break
        default:
          res.json({ ok: false, error: `Unknown provider: ${entry.provider}` })
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

  // ====== Cron API ======

  router.use('/api/cron', authMiddleware)

  router.get('/api/cron/jobs', (_req: Request, res: Response) => {
    // TODO: wire up CronScheduler to gateway
    res.json([])
  })

  router.get('/api/cron/summary', (_req: Request, res: Response) => {
    res.json({ totalJobs: 0, activeJobs: 0, pausedJobs: 0 })
  })

  // ====== Push notifications (stub) ======

  router.use('/api/push', authMiddleware)

  router.post('/api/push/register', (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  router.post('/api/push/unregister', (_req: Request, res: Response) => {
    res.json({ ok: true })
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
