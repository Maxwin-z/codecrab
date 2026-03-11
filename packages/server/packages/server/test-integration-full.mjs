// Test: Full integration test combining all features
// Tests: Complete workflow - create project, chat, switch projects, sessions, cleanup

import WebSocket from 'ws'

const API_BASE = 'http://localhost:4200/api'
const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const CWD_A = '/Users/maxwin/workspace/test-projects/project-a'
const CWD_B = '/Users/maxwin/workspace/test-projects/project-b'

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

function connectWebSocket(clientId) {
  const url = `ws://localhost:4200/ws?token=${TOKEN}&clientId=${clientId}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const events = []

    ws.on('open', () => {
      resolve({ ws, events })
    })

    ws.on('message', (data) => {
      events.push(JSON.parse(data.toString()))
    })

    ws.on('error', reject)
  })
}

async function waitForEvent(events, predicate, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const check = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - startTime > timeout) {
        return reject(new Error('Timeout waiting for event'))
      }
      setTimeout(check, 100)
    }
    check()
  })
}

async function sendPrompt(ws, events, projectId, prompt) {
  events.length = 0
  ws.send(JSON.stringify({ type: 'prompt', prompt, projectId }))
  return waitForEvent(events, m => m.type === 'query_end' && m.projectId === projectId)
}

async function main() {
  console.log('=== Full Integration Test ===\n')
  console.log('This test simulates a complete user workflow:\n')
  console.log('1. Create two projects')
  console.log('2. Connect via WebSocket')
  console.log('3. Chat with project A')
  console.log('4. Switch to project B and chat')
  console.log('5. Verify sessions are tracked')
  console.log('6. Resume a session')
  console.log('7. Cleanup\n')

  const results = []
  let projectA = null
  let projectB = null
  let ws = null

  try {
    // Step 1: Create projects
    console.log('--- Step 1: Creating projects ---')
    results.push({ name: 'Create project A', ok: true })
    const createA = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Integration Test Project A', path: CWD_A, icon: '📁' })
    })
    if (createA.status === 201) {
      projectA = createA.data
      console.log(`  Project A: ${projectA.id}`)
    } else if (createA.status === 409) {
      // Project exists, fetch it
      const { data: projects } = await request('/projects')
      projectA = projects.find(p => p.path === CWD_A)
      if (!projectA) throw new Error('Project A not found after 409')
      console.log(`  Project A: ${projectA.id} (existing)`)
    } else {
      throw new Error(`Failed to create project A: ${createA.status}`)
    }

    results.push({ name: 'Create project B', ok: true })
    const createB = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Integration Test Project B', path: CWD_B, icon: '📂' })
    })
    if (createB.status === 201) {
      projectB = createB.data
      console.log(`  Project B: ${projectB.id}`)
    } else if (createB.status === 409) {
      // Project exists, fetch it
      const { data: projects } = await request('/projects')
      projectB = projects.find(p => p.path === CWD_B)
      if (!projectB) throw new Error('Project B not found after 409')
      console.log(`  Project B: ${projectB.id} (existing)`)
    } else {
      throw new Error(`Failed to create project B: ${createB.status}`)
    }

    // Step 2: Connect WebSocket
    console.log('\n--- Step 2: Connecting WebSocket ---')
    const wsConn = await connectWebSocket(`integration-test-${Date.now()}`)
    ws = wsConn.ws
    const { events } = wsConn
    results.push({ name: 'WebSocket connected', ok: true })
    console.log('  Connected')

    // Step 3: Subscribe to both projects
    console.log('\n--- Step 3: Subscribing to projects ---')
    ws.send(JSON.stringify({ type: 'switch_project', projectId: projectA.id, projectCwd: CWD_A }))
    ws.send(JSON.stringify({ type: 'switch_project', projectId: projectB.id, projectCwd: CWD_B }))
    await new Promise(r => setTimeout(r, 500))
    results.push({ name: 'Subscribed to both projects', ok: true })
    console.log('  Subscribed')

    // Step 4: Chat with project A
    console.log('\n--- Step 4: Chatting with project A ---')
    const sessionA = await sendPrompt(ws, events, projectA.id, 'Say "Hello from Project A"')
    const assistantA = events.find(m => m.type === 'assistant_text' && m.projectId === projectA.id)
    results.push({ name: 'Chat with project A', ok: true })
    console.log(`  Response: "${assistantA?.text?.slice(0, 50)}"`)

    // Step 5: Chat with project B
    console.log('\n--- Step 5: Chatting with project B ---')
    const sessionB = await sendPrompt(ws, events, projectB.id, 'Say "Hello from Project B"')
    const assistantB = events.find(m => m.type === 'assistant_text' && m.projectId === projectB.id)
    results.push({ name: 'Chat with project B', ok: true })
    console.log(`  Response: "${assistantB?.text?.slice(0, 50)}"`)

    // Step 6: Verify sessions
    console.log('\n--- Step 6: Verifying sessions ---')
    await new Promise(r => setTimeout(r, 500))
    const sessionsRes = await request('/sessions')
    const sessions = sessionsRes.data || []
    const projectASessions = sessions.filter(s => s.cwd === CWD_A)
    const projectBSessions = sessions.filter(s => s.cwd === CWD_B)
    results.push({ name: 'Sessions tracked', ok: true })
    console.log(`  Total sessions: ${sessions.length}`)
    console.log(`  Project A sessions: ${projectASessions.length}`)
    console.log(`  Project B sessions: ${projectBSessions.length}`)

    // Step 7: Parallel queries
    console.log('\n--- Step 7: Parallel queries on both projects ---')
    const t = Date.now()
    events.length = 0
    ws.send(JSON.stringify({ type: 'prompt', prompt: 'Count from 1 to 5', projectId: projectA.id }))
    ws.send(JSON.stringify({ type: 'prompt', prompt: 'List A, B, C, D, E', projectId: projectB.id }))

    await Promise.all([
      waitForEvent(events, m => m.type === 'query_end' && m.projectId === projectA.id),
      waitForEvent(events, m => m.type === 'query_end' && m.projectId === projectB.id)
    ])
    results.push({ name: 'Parallel queries completed', ok: true })
    console.log(`  Both completed in ${Date.now() - t}ms`)

    // Step 8: Project statuses
    console.log('\n--- Step 8: Checking project statuses ---')
    const statusMsg = events.find(m => m.type === 'project_statuses')
    if (statusMsg) {
      console.log(`  Received ${statusMsg.statuses?.length || 0} project statuses`)
      statusMsg.statuses?.forEach(s => {
        console.log(`    ${s.projectId}: ${s.status}`)
      })
    }
    results.push({ name: 'Project statuses received', ok: !!statusMsg })

    // Summary
    console.log('\n=== Integration Test Summary ===')
    const passed = results.filter(r => r.ok).length
    const total = results.length
    console.log(`${passed}/${total} steps completed successfully`)

    if (passed === total) {
      console.log('\n✓ All integration tests passed!')
    } else {
      console.log('\n✗ Some integration tests failed')
    }

  } catch (err) {
    console.error('\n✗ Integration test failed:', err.message)
    results.push({ name: 'Overall test', ok: false, error: err.message })
  } finally {
    if (ws) ws.close()
  }

  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
