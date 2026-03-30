import type { StoreState, SessionData, ProjectState, QueueItem, ThreadInfo, AutoResumeBanner } from './types'

// Stable empty references — reused across renders to avoid infinite re-render loops.
// Zustand uses Object.is to compare selector outputs; returning a new [] or {} each
// time makes it think the state changed, triggering a re-render, which creates another
// new [] or {}, ad infinitum.
const EMPTY_QUEUE: QueueItem[] = []
const EMPTY_STATUSES: Record<string, 'idle' | 'processing' | 'error'> = {}
const EMPTY_THREADS: ThreadInfo[] = []
const EMPTY_BANNERS: AutoResumeBanner[] = []

export const selectConnected = (s: StoreState) => s.connected

export const selectProjectStatuses = (s: StoreState) => s.projectStatuses

export function selectProjectState(projectId: string | null) {
  return (s: StoreState): ProjectState | undefined =>
    projectId ? s.projects[projectId] : undefined
}

export function selectViewingSessionId(projectId: string | null) {
  return (s: StoreState): string | null =>
    projectId ? s.projects[projectId]?.viewingSessionId ?? null : null
}

export function selectViewingSession(projectId: string | null) {
  return (s: StoreState): SessionData | undefined => {
    if (!projectId) return undefined
    const project = s.projects[projectId]
    if (!project?.viewingSessionId) return undefined
    return project.sessions[project.viewingSessionId]
  }
}

export function selectSessionStatuses(projectId: string | null) {
  return (s: StoreState): Record<string, 'idle' | 'processing' | 'error'> => {
    if (!projectId) return EMPTY_STATUSES
    const project = s.projects[projectId]
    if (!project) return EMPTY_STATUSES
    const entries = Object.entries(project.sessions)
    if (entries.length === 0) return EMPTY_STATUSES
    const result: Record<string, 'idle' | 'processing' | 'error'> = {}
    for (const [id, session] of entries) {
      result[id] = session.status
    }
    return result
  }
}

export function selectQueryQueue(projectId: string | null) {
  return (s: StoreState) =>
    (projectId ? s.projects[projectId]?.queryQueue : undefined) ?? EMPTY_QUEUE
}

export function selectIsAborting(projectId: string | null) {
  return (s: StoreState) =>
    projectId ? s.projects[projectId]?.isAborting ?? false : false
}

export function selectPromptPending(projectId: string | null) {
  return (s: StoreState) =>
    projectId ? s.projects[projectId]?.promptPending ?? false : false
}

// ── Thread selectors ──

// Memoize by threads record reference — Immer replaces it only on real changes,
// so we can use Object.is as a cheap cache key to avoid returning a new array
// every render (which would cause Zustand's Object.is check to infinite-loop).
let _threadsRef: Record<string, ThreadInfo> = {}
let _threadsCached: ThreadInfo[] = EMPTY_THREADS

export const selectThreads = (s: StoreState): ThreadInfo[] => {
  if (s.threads === _threadsRef) return _threadsCached
  _threadsRef = s.threads
  const entries = Object.values(s.threads)
  if (entries.length === 0) {
    _threadsCached = EMPTY_THREADS
    return EMPTY_THREADS
  }
  _threadsCached = entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return _threadsCached
}

export function selectThread(threadId: string | null) {
  return (s: StoreState): ThreadInfo | undefined =>
    threadId ? s.threads[threadId] : undefined
}

export const selectAutoResumeBanners = (s: StoreState): AutoResumeBanner[] =>
  s.autoResumeBanners.length === 0 ? EMPTY_BANNERS : s.autoResumeBanners
