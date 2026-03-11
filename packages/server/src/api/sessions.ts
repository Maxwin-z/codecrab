// Session management API
import { Router, type Router as RouterType } from 'express'
import { getSessionsList, deleteSession } from '../ws/index.js'

const router: RouterType = Router()

// List all sessions with optional filtering
router.get('/', (req, res) => {
  const projectId = req.query.projectId as string | undefined
  const cwd = req.query.cwd as string | undefined

  const sessions = getSessionsList(projectId, cwd)
  res.json(sessions)
})

// Delete a session
router.delete('/:id', (req, res) => {
  const sessionId = req.params.id
  const deleted = deleteSession(sessionId)

  if (!deleted) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  res.status(204).end()
})

export default router
