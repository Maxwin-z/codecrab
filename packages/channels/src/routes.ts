// Channel REST API routes

import { Router } from 'express'
import type { ChannelManager } from './manager.js'
import { channelRegistry } from './index.js'
import * as store from './store.js'
import type { ChannelConfig } from './types.js'

/** Create the protected channel management router (requires auth) */
export function createChannelRouter(manager: ChannelManager): Router {
  const router = Router()

  // GET /api/channels — List available channel types (from registry)
  router.get('/', (_req, res) => {
    const types = Array.from(channelRegistry.values()).map(def => ({
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      configSchema: def.configSchema,
    }))
    res.json(types)
  })

  // GET /api/channels/instances — List all configured instances + status
  router.get('/instances', (_req, res) => {
    const instances = manager.listInstances()
    res.json(instances.map(inst => ({
      ...inst.config,
      status: inst.status,
    })))
  })

  // POST /api/channels/instances — Create new instance
  router.post('/instances', (req, res) => {
    const { id, config: platformConfig, defaultProjectId, projectMapping, interactiveMode, responseMode, maxMessageLength } = req.body as {
      id?: string
      config?: Record<string, unknown>
      defaultProjectId?: string
      projectMapping?: ChannelConfig['projectMapping']
      interactiveMode?: ChannelConfig['interactiveMode']
      responseMode?: ChannelConfig['responseMode']
      maxMessageLength?: number
    }

    if (!id) {
      res.status(400).json({ error: 'Missing channel type id' })
      return
    }

    const definition = channelRegistry.get(id)
    if (!definition) {
      res.status(404).json({ error: `Unknown channel type: ${id}` })
      return
    }

    // Validate required config fields
    for (const field of definition.configSchema) {
      if (field.required && (!platformConfig || platformConfig[field.key] === undefined)) {
        res.status(400).json({ error: `Missing required config field: ${field.key}` })
        return
      }
    }

    const now = new Date().toISOString()
    const channelConfig: ChannelConfig = {
      id,
      instanceId: store.generateInstanceId(id),
      enabled: false,
      config: platformConfig || {},
      projectMapping: projectMapping || [],
      defaultProjectId,
      interactiveMode: interactiveMode || 'forward',
      responseMode: responseMode || 'streaming',
      maxMessageLength,
      createdAt: now,
      updatedAt: now,
    }

    manager.createInstance(channelConfig)
    res.status(201).json(channelConfig)
  })

  // GET /api/channels/instances/:id — Instance details + status
  router.get('/instances/:id', (req, res) => {
    const instanceId = req.params.id
    const config = store.getConfig(instanceId)
    if (!config) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }

    const instance = manager.getInstance(instanceId)
    res.json({
      ...config,
      status: instance?.plugin.status || 'stopped',
    })
  })

  // PATCH /api/channels/instances/:id — Update config
  router.patch('/instances/:id', (req, res) => {
    const instanceId = req.params.id
    const existing = store.getConfig(instanceId)
    if (!existing) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }

    const updates = req.body as Partial<ChannelConfig>
    const updated: ChannelConfig = {
      ...existing,
      ...updates,
      id: existing.id,               // Cannot change type
      instanceId: existing.instanceId, // Cannot change instance ID
      createdAt: existing.createdAt,   // Cannot change creation time
      updatedAt: new Date().toISOString(),
    }

    store.saveConfig(updated)
    res.json(updated)
  })

  // DELETE /api/channels/instances/:id — Delete (stops if running)
  router.delete('/instances/:id', async (req, res) => {
    const instanceId = req.params.id
    const deleted = await manager.deleteInstance(instanceId)
    if (!deleted) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }
    res.json({ deleted: true })
  })

  // POST /api/channels/instances/:id/start — Start channel
  router.post('/instances/:id/start', async (req, res) => {
    const instanceId = req.params.id
    const config = store.getConfig(instanceId)
    if (!config) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }

    try {
      config.enabled = true
      config.updatedAt = new Date().toISOString()
      store.saveConfig(config)
      await manager.startInstance(config)
      res.json({ status: 'running' })
    } catch (err: any) {
      config.enabled = false
      store.saveConfig(config)
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/channels/instances/:id/stop — Stop channel
  router.post('/instances/:id/stop', async (req, res) => {
    const instanceId = req.params.id
    const config = store.getConfig(instanceId)
    if (!config) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }

    config.enabled = false
    config.updatedAt = new Date().toISOString()
    store.saveConfig(config)
    await manager.stopInstance(instanceId)
    res.json({ status: 'stopped' })
  })

  // GET /api/channels/instances/:id/health — Health check
  router.get('/instances/:id/health', async (req, res) => {
    const instanceId = req.params.id
    const instance = manager.getInstance(instanceId)
    if (!instance) {
      res.status(404).json({ error: 'Instance not running' })
      return
    }

    try {
      const health = await instance.plugin.healthCheck()
      res.json(health)
    } catch (err: any) {
      res.status(500).json({ healthy: false, message: err.message })
    }
  })

  // GET /api/channels/instances/:id/conversations — List conversation mappings
  router.get('/instances/:id/conversations', (req, res) => {
    const instanceId = req.params.id
    const config = store.getConfig(instanceId)
    if (!config) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }

    const conversations = manager.getConversations(instanceId)
    res.json(conversations)
  })

  return router
}

/** Create the public webhook router (no auth required) */
export function createWebhookRouter(manager: ChannelManager): Router {
  const router = Router()

  // POST /api/channels/webhook/:instanceId — Public webhook receiver
  router.post('/:instanceId', async (req, res) => {
    const instanceId = req.params.instanceId
    const instance = manager.getInstance(instanceId)
    if (!instance) {
      res.status(404).json({ error: 'Channel instance not found' })
      return
    }

    if (!instance.plugin.handleWebhook) {
      res.status(405).json({ error: 'This channel does not support webhooks' })
      return
    }

    try {
      await instance.plugin.handleWebhook(req, res)
    } catch (err: any) {
      console.error(`[ChannelWebhook] Error handling webhook for ${instanceId}:`, err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Webhook handler error' })
      }
    }
  })

  return router
}
