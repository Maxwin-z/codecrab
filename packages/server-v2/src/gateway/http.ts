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
import { AgentValidationError, AgentConflictError, AgentNotFoundError } from '../core/agent-manager.js'
import { authMiddleware, getToken, validateToken, generateToken, readConfig, writeConfig } from './auth.js'
import { getImageFilePath } from '../images.js'
import { isSoulEnabled, setSoulEnabled } from '../soul/settings.js'
import type { ProviderConfig, ProviderSettings, DetectResult } from '@codecrab/shared'

const execFileAsync = promisify(execFile)
const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json')
const CLAUDE_DIR = path.join(os.homedir(), '.claude')

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output',
])

function hasNullByte(buf: Buffer, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

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

  // ====== Agents API ======

  router.use('/api/agents', authMiddleware)

  router.get('/api/agents', (_req: Request, res: Response) => {
    const agents = core.agents.list()
    res.json(agents)
  })

  router.post('/api/agents', async (req: Request, res: Response) => {
    const { name, emoji } = req.body as { name?: string; emoji?: string }
    try {
      const agent = await core.agents.create({ name: name || '', emoji: emoji || '🤖' })
      res.status(201).json(agent)
    } catch (err) {
      if (err instanceof AgentValidationError) {
        res.status(400).json({ error: err.message })
      } else if (err instanceof AgentConflictError) {
        res.status(409).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.get('/api/agents/:id', (req: Request, res: Response) => {
    const agent = core.agents.get(req.params.id as string)
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    res.json(agent)
  })

  router.patch('/api/agents/:id', async (req: Request, res: Response) => {
    const { name, emoji } = req.body as { name?: string; emoji?: string }
    try {
      const agent = await core.agents.update(req.params.id as string, { name, emoji })
      res.json(agent)
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else if (err instanceof AgentValidationError) {
        res.status(400).json({ error: err.message })
      } else if (err instanceof AgentConflictError) {
        res.status(409).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.delete('/api/agents/:id', async (req: Request, res: Response) => {
    try {
      await core.agents.delete(req.params.id as string)
      res.status(204).end()
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else if (err instanceof AgentValidationError) {
        res.status(400).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.get('/api/agents/:id/claude-md', async (req: Request, res: Response) => {
    try {
      const content = await core.agents.getClaudeMd(req.params.id as string)
      res.json({ content })
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  router.put('/api/agents/:id/claude-md', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string }
    if (content === undefined) {
      res.status(400).json({ error: 'Missing content' })
      return
    }
    try {
      await core.agents.saveClaudeMd(req.params.id as string, content)
      res.json({ content })
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  /** Start editing an agent — returns per-agent editor project info */
  router.post('/api/agents/:id/edit', async (req: Request, res: Response) => {
    const agentId = req.params.id as string
    try {
      const agent = core.agents.get(agentId)
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' })
        return
      }
      const currentClaudeMd = await core.agents.getClaudeMd(agentId)
      const editorProject = await core.agents.ensureAgentEditorProject(agentId)

      let initialPrompt: string
      if (!currentClaudeMd) {
        initialPrompt = `I want to create a new agent called "${agent.name}". This agent doesn't have any instructions yet.`
      } else {
        initialPrompt = `I want to edit the agent "${agent.name}". Here is its current CLAUDE.md:\n\n\`\`\`\n${currentClaudeMd}\n\`\`\``
      }

      res.json({
        projectId: editorProject.id,
        projectPath: editorProject.path,
        agentId,
        agentName: agent.name,
        agentEmoji: agent.emoji,
        currentClaudeMd,
        initialPrompt,
      })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /** Complete editing — save updated CLAUDE.md */
  router.post('/api/agents/:id/edit/complete', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string }
    if (content === undefined) {
      res.status(400).json({ error: 'Missing content' })
      return
    }
    try {
      await core.agents.saveClaudeMd(req.params.id as string, content)
      res.json({ content })
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  /** Get the internal project for an agent (for starting chat sessions) */
  router.post('/api/agents/:id/use', async (req: Request, res: Response) => {
    try {
      const project = await core.agents.ensureAgentProject(req.params.id as string)
      res.json(project)
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        res.status(404).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
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

  // ====== Soul API ======

  const SOUL_DIR = path.join(os.homedir(), '.codecrab', 'soul')
  const SOUL_MD_PATH = path.join(SOUL_DIR, 'SOUL.md')
  const EVOLUTION_LOG_PATH = path.join(SOUL_DIR, 'evolution-log.jsonl')
  const MAX_SOUL_LENGTH = 4000

  function parseSoulMd(raw: string): { meta: { version: number; lastUpdated: string }; content: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!match) return { meta: { version: 0, lastUpdated: '' }, content: raw.trim() }
    const fm = match[1]
    const versionMatch = fm.match(/version:\s*(\d+)/)
    const dateMatch = fm.match(/lastUpdated:\s*(.+)/)
    return {
      meta: {
        version: versionMatch ? parseInt(versionMatch[1]) : 0,
        lastUpdated: dateMatch ? dateMatch[1].trim() : '',
      },
      content: match[2].trim(),
    }
  }

  function buildSoulMd(version: number, content: string): string {
    return `---\nversion: ${version}\nlastUpdated: ${new Date().toISOString()}\n---\n${content}\n`
  }

  async function readEvolutionLog(limit: number): Promise<Array<{ timestamp: string; summary: string }>> {
    try {
      const raw = await fs.readFile(EVOLUTION_LOG_PATH, 'utf-8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const entries: Array<{ timestamp: string; summary: string }> = []
      for (const line of lines) {
        try { entries.push(JSON.parse(line)) } catch { /* skip malformed */ }
      }
      return entries.slice(-limit)
    } catch {
      return []
    }
  }

  router.use('/api/soul', authMiddleware)

  // GET /api/soul — soul document
  router.get('/api/soul', async (_req: Request, res: Response) => {
    try {
      const raw = await fs.readFile(SOUL_MD_PATH, 'utf-8')
      const { meta, content } = parseSoulMd(raw)
      res.json({ content, meta })
    } catch {
      res.status(404).json({ error: 'No soul document found' })
    }
  })

  // GET /api/soul/status — soul status overview
  router.get('/api/soul/status', async (_req: Request, res: Response) => {
    let hasSoul = false
    let version = 0
    let contentLength = 0
    let insightCount = 0

    try {
      const raw = await fs.readFile(SOUL_MD_PATH, 'utf-8')
      const { meta, content } = parseSoulMd(raw)
      hasSoul = content.length > 0
      version = meta.version
      contentLength = content.length
      // Count bullet points as insights
      insightCount = content.split('\n').filter(l => /^\s*[-*]\s/.test(l)).length
    } catch { /* no soul file */ }

    const log = await readEvolutionLog(10000) // count all

    res.json({
      hasSoul,
      soulVersion: version,
      evolutionCount: log.length,
      insightCount,
      contentLength,
      maxLength: MAX_SOUL_LENGTH,
    })
  })

  // GET /api/soul/log — evolution history
  router.get('/api/soul/log', async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 10
    const entries = await readEvolutionLog(limit)
    res.json(entries)
  })

  // PUT /api/soul — update soul content
  router.put('/api/soul', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string }
    if (content === undefined) {
      res.status(400).json({ error: 'Missing content' })
      return
    }
    if (content.length > MAX_SOUL_LENGTH) {
      res.status(400).json({ error: `Content exceeds ${MAX_SOUL_LENGTH} character limit` })
      return
    }

    // Read current version to increment
    let currentVersion = 0
    try {
      const raw = await fs.readFile(SOUL_MD_PATH, 'utf-8')
      const { meta } = parseSoulMd(raw)
      currentVersion = meta.version
    } catch { /* new file */ }

    const newVersion = currentVersion + 1
    await fs.mkdir(SOUL_DIR, { recursive: true })
    await fs.writeFile(SOUL_MD_PATH, buildSoulMd(newVersion, content))

    const meta = { version: newVersion, lastUpdated: new Date().toISOString() }
    res.json({ content, meta })
  })

  // GET /api/soul/settings — soul enable/disable state
  router.get('/api/soul/settings', (_req: Request, res: Response) => {
    res.json({ enabled: isSoulEnabled() })
  })

  // PUT /api/soul/settings — toggle soul
  router.put('/api/soul/settings', (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'Missing enabled boolean' })
      return
    }
    setSoulEnabled(enabled)
    res.json({ enabled: isSoulEnabled() })
  })

  // ====== Files API (directory browsing for project creation) ======

  router.use('/api/files', authMiddleware)

  router.get('/api/files', async (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || os.homedir()
    const showHidden = req.query.showHidden === '1'
    try {
      const resolved = path.resolve(dirPath)
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const filtered = entries
        .filter(e => showHidden || !e.name.startsWith('.'))
        .filter(e => !e.isDirectory() || !SKIP_DIRS.has(e.name))
      const items = await Promise.all(
        filtered.map(async (e) => {
          const fullPath = path.join(resolved, e.name)
          let size: number | undefined
          let modifiedAt: number | undefined
          try {
            const stat = await fs.stat(fullPath)
            size = stat.size
            modifiedAt = stat.mtimeMs / 1000
          } catch { /* ignore stat errors */ }
          return {
            name: e.name,
            path: fullPath,
            isDirectory: e.isDirectory(),
            size,
            modifiedAt,
          }
        })
      )
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      res.json({ current: resolved, parent: path.dirname(resolved), items })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Read file content with metadata
  const MAX_FILE_SIZE = 512 * 1024 // 512 KB
  router.get('/api/files/read', async (req: Request, res: Response) => {
    const filePath = req.query.path as string
    if (!filePath) { res.status(400).json({ error: 'Missing path' }); return }
    try {
      const resolved = path.resolve(filePath)
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory' }); return }
      const name = path.basename(resolved)
      const size = stat.size
      const modifiedAt = stat.mtimeMs / 1000

      // Check if binary by reading first bytes
      let binary = false
      let content: string | null = null
      let lineCount: number | null = null
      let truncated = false

      if (size > MAX_FILE_SIZE) {
        // Try to detect binary from first chunk
        const fd = await fs.open(resolved, 'r')
        const buf = Buffer.alloc(8192)
        const { bytesRead } = await fd.read(buf, 0, 8192, 0)
        await fd.close()
        binary = hasNullByte(buf, bytesRead)
        truncated = !binary
      } else {
        const buf = await fs.readFile(resolved)
        binary = hasNullByte(buf, Math.min(buf.length, 8192))
        if (!binary) {
          content = buf.toString('utf-8')
          lineCount = content.split('\n').length
        }
      }

      res.json({ path: resolved, name, size, modifiedAt, binary, content, lineCount, truncated })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Serve raw file data (images, videos, etc.)
  router.get('/api/files/raw', async (req: Request, res: Response) => {
    const filePath = req.query.path as string
    if (!filePath) { res.status(400).json({ error: 'Missing path' }); return }
    try {
      const resolved = path.resolve(filePath)
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory' }); return }
      const ext = path.extname(resolved).toLowerCase().slice(1)
      const mimeTypes: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
        mkv: 'video/x-matroska', webm: 'video/webm',
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
      }
      const contentType = mimeTypes[ext] || 'application/octet-stream'
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', stat.size)
      const data = await fs.readFile(resolved)
      res.send(data)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Search files recursively within a project root
  router.get('/api/files/search', async (req: Request, res: Response) => {
    const query = ((req.query.q as string) || '').toLowerCase()
    const root = req.query.root as string
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 2000)
    if (!root) { res.status(400).json({ error: 'Missing root' }); return }
    try {
      const resolved = path.resolve(root)
      const results: { name: string; path: string; relativePath: string; isDirectory: boolean }[] = []
      const walk = async (dir: string) => {
        if (results.length >= limit) return
        let entries: import('node:fs').Dirent[]
        try { entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' }) as unknown as import('node:fs').Dirent[] } catch { return }
        for (const e of entries) {
          if (results.length >= limit) break
          if (e.name.startsWith('.')) continue
          const fullPath = path.join(dir, e.name)
          const relativePath = path.relative(resolved, fullPath)
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue
            results.push({ name: e.name, path: fullPath, relativePath, isDirectory: true })
            await walk(fullPath)
          } else {
            if (!query || e.name.toLowerCase().includes(query) || relativePath.toLowerCase().includes(query)) {
              results.push({ name: e.name, path: fullPath, relativePath, isDirectory: false })
            }
          }
        }
      }
      await walk(resolved)
      res.json(results)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Batch probe file existence
  router.post('/api/files/probe', async (req: Request, res: Response) => {
    const { paths: filePaths } = req.body as { paths?: string[] }
    if (!filePaths || !Array.isArray(filePaths)) {
      res.status(400).json({ error: 'Missing paths array' }); return
    }
    const results: Record<string, { exists: boolean; isFile: boolean; size: number | null }> = {}
    await Promise.all(
      filePaths.slice(0, 200).map(async (p) => {
        try {
          const resolved = path.resolve(p)
          const stat = await fs.stat(resolved)
          results[p] = { exists: true, isFile: stat.isFile(), size: stat.size }
        } catch {
          results[p] = { exists: false, isFile: false, size: null }
        }
      })
    )
    res.json({ results })
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

  // ====== Threads API ======

  // Raw artifact download — registered before authMiddleware because
  // browser <a>/<img> cannot send Bearer headers; supports ?token= query param instead.
  router.get('/api/threads/:threadId/artifacts/:artifactId/raw', async (req, res) => {
    const queryToken = req.query.token as string | undefined
    if (queryToken) {
      const valid = await validateToken(queryToken)
      if (!valid) return res.status(401).json({ error: 'Invalid token' })
    } else {
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authorization token' })
      }
      const valid = await validateToken(authHeader.slice(7))
      if (!valid) return res.status(401).json({ error: 'Invalid token' })
    }

    const artifact = core.threads.getArtifactById(req.params.artifactId)
    if (!artifact || artifact.threadId !== req.params.threadId) {
      return res.status(404).json({ error: 'Artifact not found' })
    }
    try {
      await fs.access(artifact.path)
      res.setHeader('Content-Type', artifact.mimeType)
      res.setHeader('Content-Disposition', `inline; filename="${artifact.name}"`)
      const data = await fs.readFile(artifact.path)
      res.send(data)
    } catch {
      res.status(404).json({ error: 'Artifact file not found on disk' })
    }
  })

  router.use('/api/threads', authMiddleware)

  // List all threads
  router.get('/api/threads', (req, res) => {
    const status = req.query.status as string | undefined
    const agentId = req.query.agentId as string | undefined
    const threads = core.threads.list({
      status: status as any,
      agentId,
    })
    res.json({ threads })
  })

  // Get thread by ID
  router.get('/api/threads/:threadId', (req, res) => {
    const thread = core.threads.get(req.params.threadId)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    res.json(thread)
  })

  // Get thread messages
  router.get('/api/threads/:threadId/messages', (req, res) => {
    const limitParam = req.query.limit
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : 20
    const messages = core.threads.getMessages(req.params.threadId, limit)
    res.json({ messages })
  })

  // List thread artifacts
  router.get('/api/threads/:threadId/artifacts', (req, res) => {
    const artifacts = core.threads.listArtifacts(req.params.threadId)
    res.json({ artifacts })
  })

  // Get artifact content
  router.get('/api/threads/:threadId/artifacts/:artifactId/content', async (req, res) => {
    const artifact = core.threads.getArtifactById(req.params.artifactId)
    if (!artifact || artifact.threadId !== req.params.threadId) {
      return res.status(404).json({ error: 'Artifact not found' })
    }
    try {
      const content = await fs.readFile(artifact.path, 'utf-8')
      res.json({ content, mimeType: artifact.mimeType, name: artifact.name, size: artifact.size })
    } catch {
      res.status(404).json({ error: 'Artifact file not found on disk' })
    }
  })

  // Complete a thread
  router.post('/api/threads/:threadId/complete', async (req, res) => {
    const thread = core.threads.get(req.params.threadId)
    if (!thread) return res.status(404).json({ error: 'Thread not found' })
    core.threads.complete(req.params.threadId)
    core.emit('thread:completed', { thread })
    res.json({ threadId: req.params.threadId, status: 'completed' })
  })

  // Update thread config
  router.patch('/api/threads/:threadId/config', (req, res) => {
    const updated = core.threads.updateConfig(req.params.threadId, req.body)
    if (!updated) return res.status(404).json({ error: 'Thread not found' })
    res.json(updated)
  })

  // Get threads by agent
  router.get('/api/agents/:agentId/threads', authMiddleware, (req, res) => {
    const agentId = req.params.agentId as string
    const threads = core.threads.getThreadsByAgent(agentId)
    res.json({ threads })
  })

  return router
}
