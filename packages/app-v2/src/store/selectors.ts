import type { StoreState, SessionData, ProjectState, QueueItem } from './types'

// Stable empty references — reused across renders to avoid infinite re-render loops.
// Zustand uses Object.is to compare selector outputs; returning a new [] or {} each
// time makes it think the state changed, triggering a re-render, which creates another
// new [] or {}, ad infinitum.
const EMPTY_QUEUE: QueueItem[] = []
const EMPTY_STATUSES: Record<string, 'idle' | 'processing' | 'error'> = {}

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
