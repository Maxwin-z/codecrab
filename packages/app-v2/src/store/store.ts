import { create } from 'zustand'
import { produce } from 'immer'
import type { Store, ProjectState, SessionData, StoreState, ThreadInfo, ThreadMessageInfo } from './types'

export function createEmptyProjectState(projectId: string): ProjectState {
  return {
    projectId,
    sessions: {},
    viewingSessionId: null,
    queryQueue: [],
    isAborting: false,
    promptPending: false,
  }
}

export function createEmptySessionData(projectId: string, sessionId: string): SessionData {
  return {
    sessionId,
    projectId,
    status: 'idle',
    providerId: null,
    permissionMode: 'bypassPermissions',
    messages: [],
    streamingText: '',
    streamingThinking: '',
    isStreaming: false,
    pendingPermission: null,
    pendingQuestion: null,
    suggestions: [],
    summary: '',
    usage: null,
    activityHeartbeat: null,
    backgroundTasks: {},
    currentQueryId: null,
    sdkEvents: [],
  }
}

function ensureProject(s: StoreState, projectId: string): void {
  if (!s.projects[projectId]) {
    s.projects[projectId] = createEmptyProjectState(projectId)
  }
}

function ensureSession(s: StoreState, projectId: string, sessionId: string): void {
  ensureProject(s, projectId)
  if (!s.projects[projectId].sessions[sessionId]) {
    s.projects[projectId].sessions[sessionId] = createEmptySessionData(projectId, sessionId)
  }
}

export const useStore = create<Store>((set, get) => ({
  // State
  connected: false,
  projectStatuses: [],
  projects: {},
  sessionIdMap: {},
  threads: {},
  autoResumeBanners: [],

  // Actions
  setConnected: (connected) => set({ connected }),

  setProjectStatuses: (statuses) => set({ projectStatuses: statuses }),

  getOrCreateProject: (projectId) => {
    const state = get()
    if (state.projects[projectId]) return state.projects[projectId]
    const project = createEmptyProjectState(projectId)
    set(produce((s: StoreState) => {
      s.projects[projectId] = project
    }))
    return get().projects[projectId]
  },

  getOrCreateSession: (projectId, sessionId) => {
    const state = get()
    if (state.projects[projectId]?.sessions[sessionId]) {
      return state.projects[projectId].sessions[sessionId]
    }
    set(produce((s: StoreState) => {
      ensureSession(s, projectId, sessionId)
    }))
    return get().projects[projectId].sessions[sessionId]
  },

  updateSession: (projectId, sessionId, mutator) => {
    set(produce((s: StoreState) => {
      ensureSession(s, projectId, sessionId)
      mutator(s.projects[projectId].sessions[sessionId])
    }))
  },

  updateProject: (projectId, mutator) => {
    set(produce((s: StoreState) => {
      ensureProject(s, projectId)
      mutator(s.projects[projectId])
    }))
  },

  setViewingSession: (projectId, sessionId) => {
    set(produce((s: StoreState) => {
      ensureProject(s, projectId)
      s.projects[projectId].viewingSessionId = sessionId
    }))
  },

  resolveSessionId: (tempId, realId) => {
    // No-op if IDs are identical (e.g. resumed session emits session_init with same ID)
    if (tempId === realId) return
    set(produce((s: StoreState) => {
      s.sessionIdMap[tempId] = realId
      // Find and migrate session data from tempId to realId
      for (const project of Object.values(s.projects)) {
        if (project.sessions[tempId]) {
          const sessionData = project.sessions[tempId]
          sessionData.sessionId = realId
          project.sessions[realId] = sessionData
          delete project.sessions[tempId]
          if (project.viewingSessionId === tempId) {
            project.viewingSessionId = realId
          }
          break
        }
      }
    }))
  },

  resetViewingSession: (projectId) => {
    set(produce((s: StoreState) => {
      ensureProject(s, projectId)
      s.projects[projectId].viewingSessionId = null
      s.projects[projectId].promptPending = false
      s.projects[projectId].isAborting = false
    }))
  },

  upsertThread: (thread: ThreadInfo) => {
    set(produce((s: StoreState) => {
      const existing = s.threads[thread.id]
      if (existing) {
        existing.title = thread.title
        existing.status = thread.status
        existing.participants = thread.participants
        existing.updatedAt = thread.updatedAt
        existing.stalledReason = thread.stalledReason
      } else {
        s.threads[thread.id] = thread
      }
    }))
  },

  addThreadMessage: (threadId: string, message: ThreadMessageInfo) => {
    set(produce((s: StoreState) => {
      const thread = s.threads[threadId]
      if (thread) {
        thread.messages.push(message)
        thread.updatedAt = message.timestamp
      }
    }))
  },

  addAutoResumeBanner: (banner) => {
    set(produce((s: StoreState) => {
      s.autoResumeBanners.push(banner)
    }))
  },

  dismissAutoResumeBanner: (id) => {
    set(produce((s: StoreState) => {
      s.autoResumeBanners = s.autoResumeBanners.filter(b => b.id !== id)
    }))
  },
}))
