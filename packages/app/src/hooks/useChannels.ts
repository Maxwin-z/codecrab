// useChannels — Hooks and API helpers for channel plugin management

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/auth'

// Frontend types mirroring packages/channels/src/types.ts

export interface ChannelConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  required: boolean
  description?: string
  placeholder?: string
}

export interface ChannelType {
  id: string
  name: string
  description: string
  icon: string
  configSchema: ChannelConfigField[]
}

export interface ChannelInstance {
  id: string
  instanceId: string
  enabled: boolean
  config: Record<string, unknown>
  status: 'stopped' | 'starting' | 'running' | 'error'
  projectMapping: ChannelProjectMappingRule[]
  defaultProjectId?: string
  interactiveMode: 'forward' | 'auto_allow' | 'auto_deny'
  responseMode: 'streaming' | 'buffered'
  maxMessageLength?: number
  createdAt: string
  updatedAt: string
}

export interface ChannelProjectMappingRule {
  externalUserIds?: string[]
  conversationIds?: string[]
  pattern?: string
  projectId: string
  permissionMode?: string
}

export function useChannelTypes(onUnauthorized?: () => void) {
  const [types, setTypes] = useState<ChannelType[]>([])
  const [loading, setLoading] = useState(true)

  const fetchTypes = useCallback(async () => {
    try {
      const res = await authFetch('/api/channels', {}, onUnauthorized)
      if (res.ok) setTypes(await res.json())
    } catch {
      // Silent fail
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchTypes()
  }, [fetchTypes])

  return { types, loading, available: types.length > 0 }
}

export function useChannelInstances(onUnauthorized?: () => void) {
  const [instances, setInstances] = useState<ChannelInstance[]>([])
  const [loading, setLoading] = useState(true)

  const fetchInstances = useCallback(async () => {
    try {
      const res = await authFetch('/api/channels/instances', {}, onUnauthorized)
      if (res.ok) setInstances(await res.json())
    } catch {
      // Silent fail
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchInstances()
  }, [fetchInstances])

  return { instances, loading, refresh: fetchInstances }
}

export const channelApi = {
  async createInstance(body: {
    id: string
    config: Record<string, unknown>
    defaultProjectId?: string
    projectMapping?: ChannelProjectMappingRule[]
    interactiveMode?: string
    responseMode?: string
    maxMessageLength?: number
  }, onUnauthorized?: () => void) {
    return authFetch('/api/channels/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, onUnauthorized)
  },

  async updateInstance(instanceId: string, body: Partial<ChannelInstance>, onUnauthorized?: () => void) {
    return authFetch(`/api/channels/instances/${instanceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, onUnauthorized)
  },

  async deleteInstance(instanceId: string, onUnauthorized?: () => void) {
    return authFetch(`/api/channels/instances/${instanceId}`, {
      method: 'DELETE',
    }, onUnauthorized)
  },

  async startInstance(instanceId: string, onUnauthorized?: () => void) {
    return authFetch(`/api/channels/instances/${instanceId}/start`, {
      method: 'POST',
    }, onUnauthorized)
  },

  async stopInstance(instanceId: string, onUnauthorized?: () => void) {
    return authFetch(`/api/channels/instances/${instanceId}/stop`, {
      method: 'POST',
    }, onUnauthorized)
  },
}
