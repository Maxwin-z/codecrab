// Test: Sessions API endpoints
// Tests: GET /api/sessions, GET /api/sessions?projectId=, DELETE /api/sessions/:id

const API_BASE = 'http://localhost:4200/api'
const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const WS_URL = `ws://localhost:4200/ws?token=${TOKEN}&clientId=test-sessions-${Date.now()}`

import WebSocket from 'ws'

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json().catch(() => null)
    : null
  return { status: res.status, data }
}

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
    return true
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`)
    return false
  }
}

function createWebSocket(projectId, projectCwd) {
  const wsUrl = `ws://localhost:4200/ws?token=${TOKEN}&clientId=test-sessions-${projectId}-${Date.now()}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const client = { ws, sessionId: null, messages: [] }
    let resolved = false

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'switch_project', projectId, projectCwd }))
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      client.messages.push(msg)
      if (msg.type === 'system' && msg.subtype === 'init') {
        client.sessionId = msg.sessionId
        if (!resolved) {
          resolved = true
          resolve(client)
        }
      }
    })

    ws.on('error', reject)
    ws.on('close', () => {})
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolve(client)
      }
    }, 3000)
  })
}

async function sendPromptAndWait(client, projectId, prompt, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout)
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.projectId === projectId && msg.type === 'query_end') {
        clearTimeout(timer)
        client.ws.off('message', onMessage)
        resolve(msg)
      }
    }
    client.ws.on('message', onMessage)
    client.ws.send(JSON.stringify({ type: 'prompt', prompt, projectId }))
  })
}

async function main() {
  console.log('=== Sessions API Tests ===\n')

  const PROJECT_A = 'proj-test-sessions-a'
  const PROJECT_B = 'proj-test-sessions-b'
  const CWD_A = '/Users/maxwin/workspace/test-projects/project-a'
  const CWD_B = '/Users/maxwin/workspace/test-projects/project-b'

  const results = []
  let clientA = null
  let clientB = null

  try {
    // Test 1: List sessions (empty initially)
    results.push(await test('GET /api/sessions - list all sessions', async () => {
      const { status, data } = await request('/sessions')
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      if (!Array.isArray(data)) throw new Error('Expected array')
      console.log(`  Found ${data.length} sessions`)
    }))

    // Create WebSocket connections to generate sessions
    console.log('\n[SETUP] Creating WebSocket connections...')
    clientA = await createWebSocket(PROJECT_A, CWD_A)
    clientB = await createWebSocket(PROJECT_B, CWD_B)

    // Send prompts to create active sessions
    console.log('[SETUP] Sending prompts to create sessions...')
    await sendPromptAndWait(clientA, PROJECT_A, 'Say "hello"')
    await sendPromptAndWait(clientB, PROJECT_B, 'Say "world"')

    // Wait for sessions to be tracked
    await new Promise(r => setTimeout(r, 500))

    // Test 2: List sessions after activity
    results.push(await test('GET /api/sessions - list sessions after activity', async () => {
      const { status, data } = await request('/sessions')
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      console.log(`  Found ${data.length} sessions`)
      if (data.length > 0) {
        console.log(`  Session 0: ${data[0].sessionId}, project: ${data[0].cwd || 'unknown'}`)
      }
    }))

    // Test 3: Filter sessions by projectId
    results.push(await test('GET /api/sessions?projectId= - filter by project', async () => {
      const { status, data } = await request(`/sessions?projectId=${PROJECT_A}`)
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      console.log(`  Found ${data.length} sessions for project A`)
    }))

    // Test 4: Filter sessions by cwd
    results.push(await test('GET /api/sessions?cwd= - filter by cwd', async () => {
      const encodedCwd = encodeURIComponent(CWD_A)
      const { status, data } = await request(`/sessions?cwd=${encodedCwd}`)
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      console.log(`  Found ${data.length} sessions for cwd ${CWD_A}`)
    }))

    // Test 5: Filter by non-existent project
    results.push(await test('GET /api/sessions?projectId= - empty result for unknown project', async () => {
      const { status, data } = await request('/sessions?projectId=nonexistent')
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      if (!Array.isArray(data) || data.length !== 0) throw new Error('Expected empty array')
      console.log(`  Correctly returned empty array`)
    }))

    // Get a session ID for deletion test
    const { data: sessions } = await request('/sessions')
    if (sessions.length > 0) {
      const sessionId = sessions[0].sessionId

      // Test 6: Delete session
      results.push(await test('DELETE /api/sessions/:id - delete session', async () => {
        const { status } = await request(`/sessions/${sessionId}`, { method: 'DELETE' })
        if (status !== 204) throw new Error(`Expected 204, got ${status}`)
        console.log(`  Deleted session: ${sessionId}`)

        // Verify deletion
        const { data: afterDelete } = await request('/sessions')
        const stillExists = afterDelete.some(s => s.sessionId === sessionId)
        if (stillExists) throw new Error('Session should be deleted')
      }))
    }

    // Test 7: Delete non-existent session
    results.push(await test('DELETE /api/sessions/:id - return 404 for non-existent', async () => {
      const { status } = await request('/sessions/session-nonexistent123', { method: 'DELETE' })
      if (status !== 404) throw new Error(`Expected 404, got ${status}`)
      console.log(`  Correctly returned 404`)
    }))

  } finally {
    // Cleanup
    if (clientA?.ws) clientA.ws.close()
    if (clientB?.ws) clientB.ws.close()
  }

  // Summary
  const passed = results.filter(r => r).length
  const total = results.length
  console.log(`\n=== Summary: ${passed}/${total} tests passed ===`)
  process.exit(passed === total ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
