// Push notification REST endpoints
//
// POST /api/push/register    — register an APNs device token
// POST /api/push/unregister  — remove a device token
// GET  /api/push/devices     — list registered devices

import { Router } from 'express'
import { registerDevice, unregisterDevice, getDevices } from './store.js'
import { isApnsConfigured } from './apns.js'

const router: Router = Router()

router.post('/register', (req, res) => {
  const { token, label } = req.body
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Missing or invalid device token' })
    return
  }
  const device = registerDevice(token, label)
  res.json({ ok: true, device })
})

router.post('/unregister', (req, res) => {
  const { token } = req.body
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Missing or invalid device token' })
    return
  }
  const removed = unregisterDevice(token)
  res.json({ ok: true, removed })
})

router.get('/devices', (_req, res) => {
  const devices = getDevices()
  res.json({ devices, apnsConfigured: isApnsConfigured() })
})

export default router
