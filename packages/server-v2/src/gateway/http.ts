import { Router, type Request, type Response } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { CoreEngine } from '../core/index.js'
import type { CronScheduler } from '../cron/scheduler.js'
import type { CronJob } from '../types/index.js'
import { registerDevice, unregisterDevice, getDevices } from '../push/store.js'
import { isApnsConfigured } from '../push/apns.js'
import { ProjectValidationError, ProjectConflictError, ProjectNotFoundError } from '../core/project.js'
import { authMiddleware, getToken, validateToken, generateToken, readConfig, writeConfig } from './auth.js'
import { getImageFilePath } from '../images.js'
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

export function createRouter(core: CoreEngine, opts?: { cronScheduler?: CronScheduler }): Router {
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

  // ====== Images (public — served by URL with content-hash filenames) ======

  const MIME_MAP: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }

  router.get('/api/images/:filename', async (req: Request, res: Response) => {
    const filename = (req.params.filename as string).replace(/[^a-zA-Z0-9._-]/g, '')
    const filepath = getImageFilePath(filename)
    try {
      const data = await fs.readFile(filepath)
      const ext = filename.split('.').pop() || ''
      res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.send(data)
    } catch {
      res.status(404).json({ error: 'Image not found' })
    }
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
  const cronScheduler = opts?.cronScheduler

  // Transform v2 CronJob to legacy-compatible response format (iOS expects this shape)
  function toClientCronJob(job: CronJob) {
    const jobType = job.type || 'cron'
    const isCompletedOneShot = jobType === 'at' && !job.enabled && !!job.lastRunAt

    const status = isCompletedOneShot
      ? 'completed'
      : job.enabled
        ? (job.lastRunStatus === 'failure' ? 'failed' : 'pending')
        : 'disabled'

    // Build schedule object matching iOS CronSchedule model
    let schedule: { kind: string; expr?: string; at?: string }
    if (jobType === 'at' && job.runAt) {
      schedule = { kind: 'at', at: new Date(job.runAt).toISOString() }
    } else {
      schedule = { kind: 'cron', expr: job.schedule }
    }

    return {
      id: job.id,
      name: job.name,
      description: null,
      schedule,
      prompt: job.prompt,
      context: { projectId: job.projectId, sessionId: job.sessionId },
      status,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
      nextRunAt: (jobType === 'at' && job.runAt && job.enabled) ? new Date(job.runAt).toISOString() : null,
      runCount: job.lastRunAt ? 1 : 0,
      maxRuns: jobType === 'at' ? 1 : null,
      deleteAfterRun: false,
    }
  }

  router.get('/api/cron/jobs', async (req: Request, res: Response) => {
    if (!cronScheduler) { res.json([]); return }
    const projectId = req.query.projectId as string | undefined
    const status = req.query.status as string | undefined
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined

    let jobs = await cronScheduler.list(projectId)

    // Filter by status (legacy-compatible values)
    if (status === 'enabled' || status === 'pending') {
      jobs = jobs.filter(j => j.enabled)
    } else if (status === 'completed') {
      jobs = jobs.filter(j => !j.enabled && (j.type || 'cron') === 'at' && !!j.lastRunAt)
    } else if (status === 'disabled') {
      jobs = jobs.filter(j => !j.enabled)
    } else if (status === 'failed') {
      jobs = jobs.filter(j => j.lastRunStatus === 'failure')
    }

    // Sort by createdAt descending (newest first)
    jobs.sort((a, b) => b.createdAt - a.createdAt)

    if (limit && limit > 0) {
      jobs = jobs.slice(0, limit)
    }

    res.json(jobs.map(toClientCronJob))
  })

  router.get('/api/cron/jobs/:id', async (req: Request, res: Response) => {
    if (!cronScheduler) { res.status(404).json({ error: 'Cron scheduler not initialized' }); return }
    const job = await cronScheduler.get(req.params.id as string)
    if (!job) { res.status(404).json({ error: 'Job not found' }); return }
    res.json(toClientCronJob(job))
  })

  router.get('/api/cron/jobs/:id/history', async (req: Request, res: Response) => {
    if (!cronScheduler) { res.json([]); return }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50
    const history = await cronScheduler.getHistory(req.params.id as string, limit)
    res.json(history)
  })

  router.get('/api/cron/summary', async (_req: Request, res: Response) => {
    if (!cronScheduler) {
      res.json({
        totalActive: 0, totalAll: 0,
        statusCounts: { pending: 0, running: 0, disabled: 0, failed: 0, completed: 0, deprecated: 0 },
        nextJob: null,
      })
      return
    }
    const jobs = await cronScheduler.list()
    const enabledJobs = jobs.filter(j => j.enabled)
    const disabledJobs = jobs.filter(j => !j.enabled)
    const failedJobs = enabledJobs.filter(j => j.lastRunStatus === 'failure')
    const pendingJobs = enabledJobs.filter(j => j.lastRunStatus !== 'failure')
    const completedJobs = disabledJobs.filter(j => (j.type || 'cron') === 'at' && !!j.lastRunAt)
    const pureDisabled = disabledJobs.filter(j => !((j.type || 'cron') === 'at' && !!j.lastRunAt))

    res.json({
      totalActive: enabledJobs.length,
      totalAll: jobs.length,
      statusCounts: {
        pending: pendingJobs.length,
        running: 0,
        disabled: pureDisabled.length,
        failed: failedJobs.length,
        completed: completedJobs.length,
        deprecated: 0,
      },
      nextJob: null,
    })
  })

  router.get('/api/cron/health', async (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      schedulerInitialized: !!cronScheduler,
    })
  })

  // ====== Push notifications ======

  router.use('/api/push', authMiddleware)

  router.post('/api/push/register', (req: Request, res: Response) => {
    const { token, label } = req.body as { token?: string; label?: string }
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Missing or invalid device token' })
      return
    }
    const device = registerDevice(token, label)
    res.json({ ok: true, device })
  })

  router.post('/api/push/unregister', (req: Request, res: Response) => {
    const { token } = req.body as { token?: string }
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Missing or invalid device token' })
      return
    }
    const removed = unregisterDevice(token)
    res.json({ ok: true, removed })
  })

  router.get('/api/push/devices', (_req: Request, res: Response) => {
    const devices = getDevices()
    res.json({ devices, apnsConfigured: isApnsConfigured() })
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
