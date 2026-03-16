// useCron — Hook for fetching cron job data from the server

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/auth'

export interface CronSchedule {
  kind: 'at' | 'every' | 'cron'
  at?: string
  everyMs?: number
  expr?: string
  tz?: string
}

export interface CronJobContext {
  projectId?: string
  clientId?: string
  sessionId?: string
}

export interface CronJobItem {
  id: string
  name: string
  description?: string
  schedule: CronSchedule
  prompt: string
  context: CronJobContext
  status: string
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  runCount: number
  maxRuns?: number
  deleteAfterRun?: boolean
}

export interface CronSummary {
  totalActive: number
  totalAll: number
  statusCounts: {
    pending: number
    running: number
    disabled: number
    failed: number
    completed: number
    deprecated: number
  }
  nextJob: {
    id: string
    name: string
    nextRunAt?: string
    status: string
  } | null
}

export function useCronSummary(onUnauthorized?: () => void) {
  const [summary, setSummary] = useState<CronSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await authFetch('/api/cron/summary', {}, onUnauthorized)
      if (res.ok) setSummary(await res.json())
    } catch {
      // Silent fail — dashboard should degrade gracefully
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  return { summary, loading, refresh: fetchSummary }
}

export function useCronJobs(onUnauthorized?: () => void) {
  const [jobs, setJobs] = useState<CronJobItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await authFetch('/api/cron/jobs?includeDeprecated=true', {}, onUnauthorized)
      if (res.ok) setJobs(await res.json())
    } catch {
      // Silent fail
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  return { jobs, loading, refresh: fetchJobs }
}
