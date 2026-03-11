// Engine registry — register and resolve engine adapters
//
// Responsibilities:
//   1. Register available engine adapters (claude, opencode, ...)
//   2. Resolve adapter by model config
//   3. Manage adapter lifecycle (init/dispose)
//
// Usage:
//   import { executeQuery, createClientState } from './claude.js'
//   const clientState = createClientState(clientId, projectId, cwd)
//   const stream = executeQuery(clientState, prompt, callbacks)

export {
  executeQuery,
  createClientState,
  getClientState,
  removeClientState,
  getOrCreateProjectState,
  getProjectState,
  storeAssistantMessage,
  handlePermissionResponse,
  abortQuery,
  getSessionStatuses,
  getCachedModels,
  generateSessionId,
  type ClientState,
  type ProjectState,
  type SessionStatus,
  type ModelConfig,
} from './claude.js'

export type {
  EngineAdapter,
  EngineConfig,
  CreateSessionOpts,
  EngineSession,
  QueryOpts,
  PermissionRequest,
  PermissionResponse,
  StreamEvent,
  McpServerConfig,
} from './types.js'
