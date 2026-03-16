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

export function useSoul(onUnauthorized?: () => void) {
  const [soul, setSoul] = useState<SoulDocument | null>(null)
  const [status, setStatus] = useState<SoulStatus | null>(null)
  const [recentEvolution, setRecentEvolution] = useState<EvolutionEntry[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSoul = useCallback(async () => {
    try {
      const [soulRes, statusRes, logRes] = await Promise.all([
        authFetch('/api/soul', {}, onUnauthorized),
        authFetch('/api/soul/status', {}, onUnauthorized),
        authFetch('/api/soul/log?limit=5', {}, onUnauthorized),
      ])

      if (soulRes.ok) setSoul(await soulRes.json())
      if (statusRes.ok) setStatus(await statusRes.json())
      if (logRes.ok) setRecentEvolution(await logRes.json())
    } catch {
      // Silent fail — dashboard should degrade gracefully
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchSoul()
  }, [fetchSoul])

  return { soul, status, recentEvolution, loading, refresh: fetchSoul }
}
