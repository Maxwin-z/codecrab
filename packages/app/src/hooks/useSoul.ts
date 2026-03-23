// useSoul — Hook for fetching SOUL data from the server

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/auth'

export interface SoulDocument {
  content: string
  meta: {
    version: number
    lastUpdated: string
  }
}

export interface EvolutionEntry {
  timestamp: string
  summary: string
}

export interface SoulStatus {
  hasSoul: boolean
  soulVersion: number
  evolutionCount: number
  insightCount: number
  contentLength: number
  maxLength: number
}

export interface SoulSettings {
  evolutionEnabled: boolean
}

export function useSoul(onUnauthorized?: () => void) {
  const [soul, setSoul] = useState<SoulDocument | null>(null)
  const [status, setStatus] = useState<SoulStatus | null>(null)
  const [settings, setSettings] = useState<SoulSettings | null>(null)
  const [recentEvolution, setRecentEvolution] = useState<EvolutionEntry[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSoul = useCallback(async () => {
    try {
      const [soulRes, statusRes, logRes, settingsRes] = await Promise.all([
        authFetch('/api/soul', {}, onUnauthorized),
        authFetch('/api/soul/status', {}, onUnauthorized),
        authFetch('/api/soul/log?limit=5', {}, onUnauthorized),
        authFetch('/api/soul/settings', {}, onUnauthorized),
      ])

      if (soulRes.ok) setSoul(await soulRes.json())
      if (statusRes.ok) setStatus(await statusRes.json())
      if (logRes.ok) setRecentEvolution(await logRes.json())
      if (settingsRes.ok) setSettings(await settingsRes.json())
    } catch {
      // Silent fail — dashboard should degrade gracefully
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  const setEvolutionEnabled = useCallback(async (enabled: boolean) => {
    // Optimistic update
    setSettings((prev) => prev ? { ...prev, evolutionEnabled: enabled } : { evolutionEnabled: enabled })
    try {
      const res = await authFetch('/api/soul/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evolutionEnabled: enabled }),
      }, onUnauthorized)
      if (res.ok) {
        setSettings(await res.json())
      }
    } catch {
      // Revert on failure
      setSettings((prev) => prev ? { ...prev, evolutionEnabled: !enabled } : null)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchSoul()
  }, [fetchSoul])

  return { soul, status, settings, recentEvolution, loading, refresh: fetchSoul, setEvolutionEnabled }
}
