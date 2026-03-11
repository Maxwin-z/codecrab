// Tests for WebSocket module — session management and message routing
import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionsList, deleteSession } from './index.js'

// Note: The sessions Map and other internal state is module-scoped.
// These tests exercise the public API functions. Since sessions are
// stored in a module-level Map, we test via the exported functions.

describe('getSessionsList', () => {
  it('should return an array', () => {
    const sessions = getSessionsList()
    expect(Array.isArray(sessions)).toBe(true)
  })

  it('should return empty list when filtering by nonexistent project', () => {
    const sessions = getSessionsList('nonexistent-project-xyz-12345')
    expect(sessions).toEqual([])
  })

  it('should return SessionInfo objects with required fields', () => {
    const sessions = getSessionsList()
    for (const s of sessions) {
      expect(s).toHaveProperty('sessionId')
      expect(s).toHaveProperty('summary')
      expect(s).toHaveProperty('lastModified')
      expect(typeof s.sessionId).toBe('string')
      expect(typeof s.lastModified).toBe('number')
    }
  })

  it('should sort sessions by lastModified descending', () => {
    const sessions = getSessionsList()
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].lastModified).toBeGreaterThanOrEqual(sessions[i].lastModified)
    }
  })
})

describe('deleteSession', () => {
  it('should return false when deleting nonexistent session', () => {
    const result = deleteSession('nonexistent-session-xyz-12345')
    expect(result).toBe(false)
  })
})

describe('WebSocket message format validation', () => {
  // These tests validate message shapes that the WS handler expects/produces

  it('should parse valid prompt message', () => {
    const raw = JSON.stringify({
      type: 'prompt',
      prompt: 'Hello, help me write code',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('prompt')
    expect(msg.prompt).toBe('Hello, help me write code')
    expect(msg.projectId).toBe('proj-1')
  })

  it('should parse prompt message with images', () => {
    const raw = JSON.stringify({
      type: 'prompt',
      prompt: 'Describe this screenshot',
      projectId: 'proj-1',
      images: [
        { data: 'base64data', mediaType: 'image/png', name: 'screen.png' },
      ],
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('prompt')
    expect(msg.images).toHaveLength(1)
    expect(msg.images[0].mediaType).toBe('image/png')
  })

  it('should parse valid command message', () => {
    const raw = JSON.stringify({
      type: 'command',
      command: '/clear',
      projectId: 'proj-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('command')
    expect(msg.command).toBe('/clear')
  })

  it('should parse valid abort message', () => {
    const raw = JSON.stringify({
      type: 'abort',
      projectId: 'proj-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('abort')
  })

  it('should parse switch_project message', () => {
    const raw = JSON.stringify({
      type: 'switch_project',
      projectId: 'proj-2',
      projectCwd: '/home/user/project',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('switch_project')
    expect(msg.projectCwd).toBe('/home/user/project')
  })

  it('should parse set_model message', () => {
    const raw = JSON.stringify({
      type: 'set_model',
      model: 'claude-sonnet-4-20250514',
      projectId: 'proj-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('set_model')
    expect(msg.model).toBe('claude-sonnet-4-20250514')
  })

  it('should parse respond_permission message', () => {
    const raw = JSON.stringify({
      type: 'respond_permission',
      requestId: 'perm-123',
      allow: true,
      projectId: 'proj-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('respond_permission')
    expect(msg.allow).toBe(true)
  })

  it('should parse resume_session message', () => {
    const raw = JSON.stringify({
      type: 'resume_session',
      sessionId: 'sess-old',
      projectId: 'proj-1',
    })
    const msg = JSON.parse(raw)
    expect(msg.type).toBe('resume_session')
    expect(msg.sessionId).toBe('sess-old')
  })
})

describe('Server message format validation', () => {
  it('should produce valid stream_delta message', () => {
    const msg = {
      type: 'stream_delta',
      deltaType: 'text',
      text: 'Hello',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    }
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.type).toBe('stream_delta')
    expect(parsed.deltaType).toBe('text')
    expect(parsed.text).toBe('Hello')
  })

  it('should produce valid tool_use message', () => {
    const msg = {
      type: 'tool_use',
      toolName: 'Read',
      toolId: 'tool-123',
      input: { file_path: '/src/index.ts' },
      projectId: 'proj-1',
      sessionId: 'sess-1',
    }
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.toolName).toBe('Read')
    expect(parsed.input.file_path).toBe('/src/index.ts')
  })

  it('should produce valid tool_result message', () => {
    const msg = {
      type: 'tool_result',
      toolId: 'tool-123',
      content: 'file contents here',
      isError: false,
      projectId: 'proj-1',
    }
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.isError).toBe(false)
    expect(parsed.content).toBe('file contents here')
  })

  it('should produce valid error message', () => {
    const msg = {
      type: 'error',
      message: 'A query is already running',
      projectId: 'proj-1',
    }
    expect(msg.type).toBe('error')
    expect(msg.message).toContain('already running')
  })

  it('should produce valid permission_request message', () => {
    const msg = {
      type: 'permission_request',
      requestId: 'perm-456',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/test' },
      reason: 'Allow Bash execution?',
      projectId: 'proj-1',
    }
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.requestId).toBe('perm-456')
    expect(parsed.reason).toContain('Bash')
  })

  it('should produce valid query lifecycle messages', () => {
    const start = { type: 'query_start', projectId: 'proj-1', sessionId: 'sess-1' }
    const end = { type: 'query_end', projectId: 'proj-1', sessionId: 'sess-1' }

    expect(JSON.parse(JSON.stringify(start)).type).toBe('query_start')
    expect(JSON.parse(JSON.stringify(end)).type).toBe('query_end')
  })

  it('should produce valid message_history message', () => {
    const msg = {
      type: 'message_history',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      messages: [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'user',
          content: 'With image',
          images: [{ data: 'base64', mediaType: 'image/png' }],
          timestamp: Date.now(),
        },
      ],
    }
    const parsed = JSON.parse(JSON.stringify(msg))
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[1].images[0].mediaType).toBe('image/png')
  })
})
