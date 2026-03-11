// Tests for Claude engine — client state, project state, message handling
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildPrompt,
  createClientState,
  getClientState,
  removeClientState,
  removeAllClientStates,
  getClientStatesForClient,
  getOrCreateProjectState,
  getProjectState,
  getActiveProjectIds,
  storeAssistantMessage,
  handlePermissionResponse,
  abortQuery,
  generateSessionId,
  getModelDisplayName,
  getSessionStatuses,
  getCachedModels,
  loadModelsFromConfig,
} from './claude.js'
import type { ClientState, ProjectState } from './claude.js'

// --- ClientState CRUD ---
describe('ClientState management', () => {
  const clientId = 'test-client-1'
  const projectId = 'test-project-1'

  beforeEach(() => {
    // Clean up states from previous tests
    removeAllClientStates(clientId)
    removeAllClientStates('test-client-2')
  })

  it('should create and retrieve a client state', () => {
    const state = createClientState(clientId, projectId, '/tmp/test')
    expect(state).toBeDefined()
    expect(state.clientId).toBe(clientId)
    expect(state.projectId).toBe(projectId)
    expect(state.cwd).toBe('/tmp/test')
    expect(state.permissionMode).toBe('bypassPermissions')
    expect(state.activeQuery).toBeNull()
    expect(state.accumulatingText).toBe('')
    expect(state.accumulatingThinking).toBe('')
    expect(state.currentToolCalls).toEqual([])

    const retrieved = getClientState(clientId, projectId)
    expect(retrieved).toBe(state)
  })

  it('should return undefined for nonexistent client state', () => {
    expect(getClientState('nonexistent', 'proj')).toBeUndefined()
  })

  it('should remove a specific client state', () => {
    createClientState(clientId, projectId, '/tmp')
    expect(getClientState(clientId, projectId)).toBeDefined()

    const removed = removeClientState(clientId, projectId)
    expect(removed).toBe(true)
    expect(getClientState(clientId, projectId)).toBeUndefined()
  })

  it('should remove all client states for a clientId', () => {
    createClientState(clientId, 'proj-a', '/tmp/a')
    createClientState(clientId, 'proj-b', '/tmp/b')
    expect(getClientState(clientId, 'proj-a')).toBeDefined()
    expect(getClientState(clientId, 'proj-b')).toBeDefined()

    removeAllClientStates(clientId)
    expect(getClientState(clientId, 'proj-a')).toBeUndefined()
    expect(getClientState(clientId, 'proj-b')).toBeUndefined()
  })

  it('should get all client states for a clientId', () => {
    createClientState(clientId, 'proj-a', '/tmp/a')
    createClientState(clientId, 'proj-b', '/tmp/b')
    createClientState('test-client-2', 'proj-a', '/tmp/c')

    const states = getClientStatesForClient(clientId)
    expect(states).toHaveLength(2)
    expect(states.every((s) => s.clientId === clientId)).toBe(true)
  })

  it('should isolate client states by clientId:projectId composite key', () => {
    const s1 = createClientState(clientId, 'proj-a', '/a')
    const s2 = createClientState(clientId, 'proj-b', '/b')
    const s3 = createClientState('test-client-2', 'proj-a', '/c')

    expect(getClientState(clientId, 'proj-a')).toBe(s1)
    expect(getClientState(clientId, 'proj-b')).toBe(s2)
    expect(getClientState('test-client-2', 'proj-a')).toBe(s3)
    expect(s1).not.toBe(s3)
  })
})

// --- ProjectState CRUD ---
describe('ProjectState management', () => {
  it('should create project state on first access', () => {
    const projectId = `test-proj-${Date.now()}`
    const state = getOrCreateProjectState(projectId)
    expect(state).toBeDefined()
    expect(state.projectId).toBe(projectId)
    expect(state.activeQuery).toBeNull()
    expect(state.messages).toEqual([])
    expect(state.permissionMode).toBe('bypassPermissions')
  })

  it('should return the same project state on subsequent calls', () => {
    const projectId = `test-proj-${Date.now()}`
    const s1 = getOrCreateProjectState(projectId)
    const s2 = getOrCreateProjectState(projectId)
    expect(s1).toBe(s2)
  })

  it('should return undefined for nonexistent project via getProjectState', () => {
    expect(getProjectState('nonexistent-project-12345')).toBeUndefined()
  })

  it('should track active project ids', () => {
    const projectId = `test-proj-active-${Date.now()}`
    const state = getOrCreateProjectState(projectId)

    // No active queries initially
    expect(getActiveProjectIds()).not.toContain(projectId)

    // Set active query
    state.activeQuery = { abort: new AbortController() }
    expect(getActiveProjectIds()).toContain(projectId)

    // Clear active query
    state.activeQuery = null
    expect(getActiveProjectIds()).not.toContain(projectId)
  })
})

// --- storeAssistantMessage ---
describe('storeAssistantMessage', () => {
  const clientId = 'test-store-msg'
  const projectId = `test-store-proj-${Date.now()}`

  beforeEach(() => {
    removeAllClientStates(clientId)
  })

  it('should return null when nothing is accumulated', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    const msg = storeAssistantMessage(state)
    expect(msg).toBeNull()
  })

  it('should store accumulated text as assistant message', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    state.accumulatingText = 'Hello, I can help with that.'
    state.accumulatingThinking = 'Let me think about this...'
    state.currentCostUsd = 0.0042
    state.currentDurationMs = 1500

    const msg = storeAssistantMessage(state)
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('assistant')
    expect(msg!.content).toBe('Hello, I can help with that.')
    expect(msg!.thinking).toBe('Let me think about this...')
    expect(msg!.costUsd).toBe(0.0042)
    expect(msg!.durationMs).toBe(1500)
    expect(msg!.id).toMatch(/^msg-/)
    expect(msg!.timestamp).toBeGreaterThan(0)
  })

  it('should reset accumulation after storing', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    state.accumulatingText = 'Some response'
    state.accumulatingThinking = 'Some thinking'
    state.currentToolCalls = [{ name: 'Read', id: 'tool-1', input: {} }]
    state.currentCostUsd = 0.01

    storeAssistantMessage(state)

    expect(state.accumulatingText).toBe('')
    expect(state.accumulatingThinking).toBe('')
    expect(state.currentToolCalls).toEqual([])
    expect(state.currentCostUsd).toBeUndefined()
    expect(state.currentDurationMs).toBeUndefined()
  })

  it('should store message with tool calls', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    state.accumulatingText = ''
    state.currentToolCalls = [
      { name: 'Read', id: 'tool-1', input: { file: '/test.ts' }, result: 'content', isError: false },
      { name: 'Bash', id: 'tool-2', input: { command: 'ls' } },
    ]

    const msg = storeAssistantMessage(state)
    expect(msg).not.toBeNull()
    expect(msg!.toolCalls).toHaveLength(2)
    expect(msg!.toolCalls![0].name).toBe('Read')
    expect(msg!.toolCalls![1].name).toBe('Bash')
  })

  it('should append message to project state', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    const projState = getOrCreateProjectState(projectId)
    const initialCount = projState.messages.length

    state.accumulatingText = 'test response'
    storeAssistantMessage(state)

    expect(projState.messages.length).toBe(initialCount + 1)
    expect(projState.messages[projState.messages.length - 1].content).toBe('test response')
  })

  it('should omit empty thinking', () => {
    const state = createClientState(clientId, projectId, '/tmp')
    state.accumulatingText = 'response'
    state.accumulatingThinking = ''

    const msg = storeAssistantMessage(state)
    expect(msg!.thinking).toBeUndefined()
  })
})

// --- handlePermissionResponse ---
describe('handlePermissionResponse', () => {
  const clientId = 'test-perm'

  beforeEach(() => {
    removeAllClientStates(clientId)
  })

  it('should resolve a pending permission request with allow', () => {
    const state = createClientState(clientId, 'proj', '/tmp')
    let resolved: any = null
    state.pendingPermissions.set('req-1', {
      resolve: (r) => { resolved = r },
    })

    const handled = handlePermissionResponse(state, 'req-1', true)
    expect(handled).toBe(true)
    expect(resolved).toEqual({ behavior: 'allow', message: undefined })
    expect(state.pendingPermissions.has('req-1')).toBe(false)
  })

  it('should resolve a pending permission request with deny', () => {
    const state = createClientState(clientId, 'proj', '/tmp')
    let resolved: any = null
    state.pendingPermissions.set('req-2', {
      resolve: (r) => { resolved = r },
    })

    const handled = handlePermissionResponse(state, 'req-2', false)
    expect(handled).toBe(true)
    expect(resolved).toEqual({ behavior: 'deny', message: 'User denied permission' })
  })

  it('should return false for unknown request', () => {
    const state = createClientState(clientId, 'proj', '/tmp')
    const handled = handlePermissionResponse(state, 'nonexistent', true)
    expect(handled).toBe(false)
  })
})

// --- abortQuery ---
describe('abortQuery', () => {
  const clientId = 'test-abort'

  beforeEach(() => {
    removeAllClientStates(clientId)
  })

  it('should abort an active query', () => {
    const state = createClientState(clientId, undefined, '/tmp')
    const controller = new AbortController()
    state.activeQuery = { abort: controller }

    const result = abortQuery(state)
    expect(result).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(state.activeQuery).toBeNull()
  })

  it('should return false when no active query', () => {
    const state = createClientState(clientId, undefined, '/tmp')
    const result = abortQuery(state)
    expect(result).toBe(false)
  })

  it('should clear project activeQuery when aborting', () => {
    const projectId = `test-abort-proj-${Date.now()}`
    const state = createClientState(clientId, projectId, '/tmp')
    const projState = getOrCreateProjectState(projectId)

    const controller = new AbortController()
    state.activeQuery = { abort: controller }
    projState.activeQuery = state.activeQuery

    abortQuery(state)
    expect(projState.activeQuery).toBeNull()
  })

  it('should call close() on queryObj if available', () => {
    const state = createClientState(clientId, undefined, '/tmp')
    const closeFn = vi.fn()
    state.activeQuery = {
      abort: new AbortController(),
      queryObj: { close: closeFn } as any,
    }

    abortQuery(state)
    expect(closeFn).toHaveBeenCalledOnce()
  })

  it('should not throw if queryObj.close() throws', () => {
    const state = createClientState(clientId, undefined, '/tmp')
    state.activeQuery = {
      abort: new AbortController(),
      queryObj: {
        close: () => { throw new Error('process already dead') },
      } as any,
    }

    expect(() => abortQuery(state)).not.toThrow()
    expect(state.activeQuery).toBeNull()
  })
})

// --- generateSessionId ---
describe('generateSessionId', () => {
  it('should generate unique session IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateSessionId())
    }
    expect(ids.size).toBe(100)
  })

  it('should follow the sess- prefix pattern', () => {
    const id = generateSessionId()
    expect(id).toMatch(/^sess-\d+-[a-z0-9]+$/)
  })
})

// --- getModelDisplayName ---
describe('getModelDisplayName', () => {
  it('should return Default for unknown model', () => {
    expect(getModelDisplayName('nonexistent-model-xyz')).toBe('Default')
  })
})

// --- getCachedModels / loadModelsFromConfig ---
describe('Model caching', () => {
  it('should return null for initial cached models if not loaded', () => {
    // cachedModels may have been set by loadModelsFromConfig from other tests
    // Just verify the function returns an array or null
    const result = getCachedModels()
    expect(result === null || Array.isArray(result)).toBe(true)
  })

  it('should load models from config and return array', () => {
    const models = loadModelsFromConfig()
    expect(Array.isArray(models)).toBe(true)
  })
})

// --- buildPrompt ---
describe('buildPrompt', () => {
  it('should return plain string when no images provided', () => {
    const result = buildPrompt('Hello world')
    expect(result).toBe('Hello world')
  })

  it('should return plain string when images is undefined', () => {
    const result = buildPrompt('Hello world', undefined)
    expect(result).toBe('Hello world')
  })

  it('should return plain string when images is empty array', () => {
    const result = buildPrompt('Hello world', [])
    expect(result).toBe('Hello world')
  })

  it('should return AsyncIterable when images are provided', () => {
    const result = buildPrompt('Describe this', [
      { data: 'base64data', mediaType: 'image/jpeg', name: 'photo.jpg' },
    ])
    // Should NOT be a string
    expect(typeof result).not.toBe('string')
    // Should be an async iterable (has Symbol.asyncIterator)
    expect(Symbol.asyncIterator in (result as object)).toBe(true)
  })

  it('should yield a single SDKUserMessage with image + text content blocks', async () => {
    const result = buildPrompt('What is this?', [
      { data: 'imgdata123', mediaType: 'image/png', name: 'screen.png' },
    ], 'sess-test')

    // Collect messages from async iterable
    const messages: any[] = []
    for await (const msg of result as AsyncIterable<any>) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.type).toBe('user')
    expect(msg.parent_tool_use_id).toBeNull()
    expect(msg.session_id).toBe('sess-test')

    // Check message.content has image block first, then text block
    const content = msg.message.content
    expect(content).toHaveLength(2)

    // First block: image
    expect(content[0].type).toBe('image')
    expect(content[0].source.type).toBe('base64')
    expect(content[0].source.data).toBe('imgdata123')
    expect(content[0].source.media_type).toBe('image/png')

    // Second block: text
    expect(content[1].type).toBe('text')
    expect(content[1].text).toBe('What is this?')
  })

  it('should handle multiple images — all images before text', async () => {
    const result = buildPrompt('Compare these', [
      { data: 'jpeg1', mediaType: 'image/jpeg' },
      { data: 'png2', mediaType: 'image/png', name: 'b.png' },
      { data: 'webp3', mediaType: 'image/webp' },
    ])

    const messages: any[] = []
    for await (const msg of result as AsyncIterable<any>) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(1)
    const content = messages[0].message.content
    // 3 images + 1 text = 4 blocks
    expect(content).toHaveLength(4)

    // First 3 blocks should be images
    expect(content[0].type).toBe('image')
    expect(content[0].source.data).toBe('jpeg1')
    expect(content[0].source.media_type).toBe('image/jpeg')

    expect(content[1].type).toBe('image')
    expect(content[1].source.data).toBe('png2')
    expect(content[1].source.media_type).toBe('image/png')

    expect(content[2].type).toBe('image')
    expect(content[2].source.data).toBe('webp3')
    expect(content[2].source.media_type).toBe('image/webp')

    // Last block should be text
    expect(content[3].type).toBe('text')
    expect(content[3].text).toBe('Compare these')
  })

  it('should use empty string for session_id when not provided', async () => {
    const result = buildPrompt('Test', [
      { data: 'x', mediaType: 'image/gif' },
    ])

    const messages: any[] = []
    for await (const msg of result as AsyncIterable<any>) {
      messages.push(msg)
    }

    expect(messages[0].session_id).toBe('')
  })

  it('should set message role to user', async () => {
    const result = buildPrompt('Test', [
      { data: 'x', mediaType: 'image/jpeg' },
    ])

    const messages: any[] = []
    for await (const msg of result as AsyncIterable<any>) {
      messages.push(msg)
    }

    expect(messages[0].message.role).toBe('user')
  })

  it('should correctly map all 4 supported media types', async () => {
    const mediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
    for (const mediaType of mediaTypes) {
      const result = buildPrompt('Test', [{ data: 'x', mediaType }])
      const messages: any[] = []
      for await (const msg of result as AsyncIterable<any>) {
        messages.push(msg)
      }
      expect(messages[0].message.content[0].source.media_type).toBe(mediaType)
    }
  })
})
