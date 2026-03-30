import { authFetch } from './auth'
import type { ThreadInfo, ThreadMessageInfo } from '@/store/types'

export async function fetchThreads(
  filters?: { status?: string; agentId?: string },
  onUnauthorized?: () => void,
): Promise<ThreadInfo[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set('status', filters.status)
  if (filters?.agentId) params.set('agentId', filters.agentId)
  const qs = params.toString()
  const res = await authFetch(`/api/threads${qs ? `?${qs}` : ''}`, {}, onUnauthorized)
  if (!res.ok) return []
  const data = await res.json()
  return (data.threads ?? []).map(mapThread)
}

export async function fetchThreadMessages(
  threadId: string,
  limit = 50,
  onUnauthorized?: () => void,
): Promise<ThreadMessageInfo[]> {
  const res = await authFetch(`/api/threads/${threadId}/messages?limit=${limit}`, {}, onUnauthorized)
  if (!res.ok) return []
  const data = await res.json()
  return (data.messages ?? []).map(mapMessage)
}

export interface ArtifactInfo {
  id: string
  name: string
  mimeType: string
  createdBy: { agentId: string; agentName: string }
  path: string
  size: number
  createdAt: number
}

export async function fetchArtifacts(
  threadId: string,
  onUnauthorized?: () => void,
): Promise<ArtifactInfo[]> {
  const res = await authFetch(`/api/threads/${threadId}/artifacts`, {}, onUnauthorized)
  if (!res.ok) return []
  const data = await res.json()
  return data.artifacts ?? []
}

export interface ArtifactContent {
  content: string
  mimeType: string
  name: string
  size: number
}

export async function fetchArtifactContent(
  threadId: string,
  artifactId: string,
  onUnauthorized?: () => void,
): Promise<ArtifactContent | null> {
  const res = await authFetch(`/api/threads/${threadId}/artifacts/${artifactId}/content`, {}, onUnauthorized)
  if (!res.ok) return null
  return res.json()
}

export function getArtifactRawUrl(threadId: string, artifactId: string): string {
  return `/api/threads/${threadId}/artifacts/${artifactId}/raw`
}

export async function completeThread(
  threadId: string,
  onUnauthorized?: () => void,
): Promise<boolean> {
  const res = await authFetch(`/api/threads/${threadId}/complete`, { method: 'POST' }, onUnauthorized)
  return res.ok
}

export async function updateThreadConfig(
  threadId: string,
  config: { maxTurns?: number },
  onUnauthorized?: () => void,
): Promise<boolean> {
  const res = await authFetch(`/api/threads/${threadId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }, onUnauthorized)
  return res.ok
}

function mapThread(t: any): ThreadInfo {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    parentThreadId: t.parentThreadId ?? null,
    participants: t.participants ?? [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    stalledReason: t.stalledReason,
    messages: [],
  }
}

function mapMessage(m: any): ThreadMessageInfo {
  return {
    id: m.id,
    from: typeof m.from === 'string' ? m.from : m.from?.agentName ?? 'unknown',
    to: typeof m.to === 'string' ? m.to : m.to?.agentName ?? 'broadcast',
    content: m.content,
    artifacts: m.artifacts ?? [],
    timestamp: m.createdAt ?? m.timestamp ?? Date.now(),
  }
}
