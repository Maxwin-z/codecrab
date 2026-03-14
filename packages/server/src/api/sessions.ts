// Session management API
import { Router, type Router as RouterType } from 'express'
import { getSessionsList, deleteSession, getSessionMessages, getSessionDebugEvents } from '../ws/index.js'

const router: RouterType = Router()

// List all sessions with optional filtering
router.get('/', (req, res) => {
  const projectId = req.query.projectId as string | undefined
  const cwd = req.query.cwd as string | undefined

  const sessions = getSessionsList(projectId, cwd)
  res.json(sessions)
})

// Get full session messages (for expanding truncated history)
router.get('/:id/messages', (req, res) => {
  const sessionId = req.params.id
  const messages = getSessionMessages(sessionId)

  if (messages === null) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const debugEvents = getSessionDebugEvents(sessionId) || []
  res.json({ sessionId, messages, debugEvents })
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
