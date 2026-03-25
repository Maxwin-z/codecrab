import { Router, type Request, type Response } from 'express'
import type { CoreEngine } from '../core/index.js'
import { authMiddleware, getToken, validateToken, generateToken, readConfig, writeConfig } from './auth.js'

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

  // ====== Protected routes (require auth) ======

  router.use('/api/projects', authMiddleware)
  router.use('/api/sessions', authMiddleware)
  router.use('/api/models', authMiddleware)

  // Projects
  router.get('/api/projects', (_req: Request, res: Response) => {
    const projects = core.projects.list()
    res.json(projects)
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

  // Sessions
  router.get('/api/sessions', (req: Request, res: Response) => {
    const projectId = req.query.projectId as string | undefined
    const sessions = core.sessions.list(projectId)
    res.json(sessions)
  })

  router.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string
    await core.sessions.delete(id)
    res.json({ ok: true })
  })

  return router
}
