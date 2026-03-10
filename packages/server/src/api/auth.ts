import { Router, type Router as RouterType } from 'express'
import { validateToken, getToken, ensureToken } from '../auth/index.js'

const router: RouterType = Router()

// GET /api/auth/status — check if auth is configured and if provided token is valid
// This endpoint is public (no auth required) to allow checking status
router.get('/status', async (req, res) => {
  const token = await getToken()
  const authHeader = req.headers.authorization

  // No token configured on server — auth is disabled
  if (!token) {
    res.json({
      configured: false,
      valid: false,
      message: 'Auth not configured on server',
    })
    return
  }

  // Check if provided token is valid
  if (authHeader) {
    const parts = authHeader.split(' ')
    const providedToken = parts.length === 2 && parts[0].toLowerCase() === 'bearer'
      ? parts[1]
      : authHeader
    const isValid = await validateToken(providedToken)
    res.json({
      configured: true,
      valid: isValid,
    })
    return
  }

  // Token configured but none provided
  res.json({
    configured: true,
    valid: false,
  })
})

// POST /api/auth/verify — verify a token (for login page)
router.post('/verify', async (req, res) => {
  const { token } = req.body as { token?: string }

  if (!token) {
    res.status(400).json({ error: 'Token is required' })
    return
  }

  const isValid = await validateToken(token)
  if (!isValid) {
    res.status(401).json({ error: 'Invalid token' })
    return
  }

  res.json({ valid: true })
})

// POST /api/auth/refresh — generate a new token (for future admin use)
router.post('/refresh', async (req, res) => {
  const { currentToken } = req.body as { currentToken?: string }

  if (!currentToken) {
    res.status(400).json({ error: 'Current token is required' })
    return
  }

  const isValid = await validateToken(currentToken)
  if (!isValid) {
    res.status(401).json({ error: 'Invalid current token' })
    return
  }

  const newToken = await ensureToken()
  res.json({ token: newToken })
})

export default router
