import { Router } from 'express'
import { ensureChromeRunning, stopChrome, isChromeRunning } from './chrome.js'

const CHROME_DEBUG_PORT = 9222

const chromeRouter: Router = Router()

chromeRouter.get('/status', async (_req, res) => {
  const running = await isChromeRunning()
  res.json({ running, port: CHROME_DEBUG_PORT })
})

chromeRouter.post('/start', async (_req, res) => {
  try {
    await ensureChromeRunning()
    res.json({ running: true, port: CHROME_DEBUG_PORT })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

chromeRouter.post('/stop', async (_req, res) => {
  await stopChrome()
  res.json({ running: false })
})

export default chromeRouter
