// Test: Multi-project chat scenarios
// Tests: parallel queries, sequential queries, project isolation

import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-test-multi-a'
const PROJECT_B = 'proj-test-multi-b'
const CWD_A = '/Users/maxwin/workspace/test-projects/project-a'
const CWD_B = '/Users/maxwin/workspace/test-projects/project-b'

const WS_URL = `ws://localhost:4200/ws?token=${TOKEN}&clientId=test-multi-${Date.now()}`

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

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const events = []
    const projectState = {
      [PROJECT_A]: { started: false, ended: false },
      [PROJECT_B]: { started: false, ended: false },
    }

    ws.on('open', () => {
      resolve({ ws, events, projectState })
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      events.push(msg)

      if (msg.projectId) {
        if (msg.type === 'query_start') projectState[msg.projectId].started = true
        if (msg.type === 'query_end') projectState[msg.projectId].ended = true
      }
    })

    ws.on('error', reject)
  })
}

async function waitForProjectQueryEnd(ws, events, projectId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const ended = events.some(m => m.type === 'query_end' && m.projectId === projectId)
      if (ended) return resolve()
    }

    check()
    const interval = setInterval(check, 100)
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`Timeout waiting for project ${projectId} query_end`))
    }, timeout)

    ws.on('message', () => {
      check()
      if (events.some(m => m.type === 'query_end' && m.projectId === projectId)) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

async function main() {
  console.log('=== Multi-Project Chat Tests ===\n')

  const results = []
  let conn = null

  try {
    results.push(await test('Connect and subscribe to both projects', async () => {
      conn = await connectWebSocket()
      const { ws } = conn

      // Subscribe to both projects
      ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: CWD_A }))
      ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_B, projectCwd: CWD_B }))

      await new Promise(r => setTimeout(r, 500))
      console.log('  Subscribed to both projects')
    }))

    const { ws, events, projectState } = conn

    // Test 1: Sequential queries on same project
    results.push(await test('Sequential queries on project A', async () => {
      for (let i = 1; i <= 3; i++) {
        events.length = 0
        ws.send(JSON.stringify({
          type: 'prompt',
          prompt: `Say "Query ${i}" and nothing else`,
          projectId: PROJECT_A
        }))
        await waitForProjectQueryEnd(ws, events, PROJECT_A)
        console.log(`  Query ${i}/3 completed`)
      }
    }))

    // Test 2: Sequential queries alternating projects
    results.push(await test('Alternating queries between projects', async () => {
      for (let i = 1; i <= 4; i++) {
        events.length = 0
        const projectId = i % 2 === 1 ? PROJECT_A : PROJECT_B
        ws.send(JSON.stringify({
          type: 'prompt',
          prompt: `Say "Alternating query ${i}"`,
          projectId
        }))
        await waitForProjectQueryEnd(ws, events, projectId)
        console.log(`  Query ${i}/4 on ${projectId === PROJECT_A ? 'A' : 'B'} completed`)
      }
    }))

    // Test 3: Parallel queries on both projects
    results.push(await test('Parallel queries on both projects', async () => {
      events.length = 0
      projectState[PROJECT_A] = { started: false, ended: false }
      projectState[PROJECT_B] = { started: false, ended: false }

      // Send both prompts simultaneously
      const t = Date.now()
      ws.send(JSON.stringify({
        type: 'prompt',
        prompt: 'Say exactly "Hello from project A"',
        projectId: PROJECT_A
      }))
      ws.send(JSON.stringify({
        type: 'prompt',
        prompt: 'Say exactly "Hello from project B"',
        projectId: PROJECT_B
      }))
      console.log(`  Both prompts sent in ${Date.now() - t}ms`)

      // Wait for both to complete
      await Promise.all([
        waitForProjectQueryEnd(ws, events, PROJECT_A, 60000),
        waitForProjectQueryEnd(ws, events, PROJECT_B, 60000)
      ])

      console.log('  Both queries completed')
    }))

    // Test 4: Verify project isolation (messages don't leak)
    results.push(await test('Project isolation - messages correctly routed', async () => {
      events.length = 0

      // Send query to project A
      ws.send(JSON.stringify({
        type: 'prompt',
        prompt: 'Say "ONLY_PROJECT_A"',
        projectId: PROJECT_A
      }))

      await waitForProjectQueryEnd(ws, events, PROJECT_A, 30000)

      // Check all messages have correct projectId
      const projectMessages = events.filter(m => m.projectId && m.projectId !== undefined)
      const wrongRouting = projectMessages.filter(m => m.projectId !== PROJECT_A)

      if (wrongRouting.length > 0) {
        throw new Error(`Message routing error: ${wrongRouting.length} messages routed to wrong project`)
      }

      console.log(`  All ${projectMessages.length} messages correctly routed to project A`)
    }))

    // Test 5: Rapid fire queries (project-level query lock means sequential execution)
    results.push(await test('Rapid fire queries (5 quick queries)', async () => {
      // Due to project-level query lock, queries will execute sequentially
      // We verify that all queries eventually complete
      const queryResults = []

      for (let i = 1; i <= 5; i++) {
        const projectId = i % 2 === 1 ? PROJECT_A : PROJECT_B
        const prompt = `Quick query ${i}`

        events.length = 0
        ws.send(JSON.stringify({ type: 'prompt', prompt, projectId }))

        // Wait for this query to complete before sending next (due to query lock)
        try {
          await waitForProjectQueryEnd(ws, events, projectId, 60000)
          queryResults.push({ i, projectId, success: true })
          console.log(`  Query ${i}/5 completed on ${projectId === PROJECT_A ? 'A' : 'B'}`)
        } catch (err) {
          queryResults.push({ i, projectId, success: false, error: err.message })
        }

        // Small delay between queries
        await new Promise(r => setTimeout(r, 200))
      }

      const successCount = queryResults.filter(r => r.success).length
      console.log(`  Completed: ${successCount}/5 queries`)

      if (successCount < 5) {
        throw new Error(`Only ${successCount}/5 queries completed`)
      }
    }))

    // Test 6: Abort one project doesn't affect other
    results.push(await test('Abort isolation - abort A does not affect B', async () => {
      // Start a long query on A
      events.length = 0
      ws.send(JSON.stringify({
        type: 'prompt',
        prompt: 'Write a detailed analysis of machine learning',
        projectId: PROJECT_A
      }))

      await new Promise(r => setTimeout(r, 500))

      // Send a quick query to B
      ws.send(JSON.stringify({
        type: 'prompt',
        prompt: 'Say "hi"',
        projectId: PROJECT_B
      }))

      // Abort A
      ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_A }))

      // B should still complete
      await waitForProjectQueryEnd(ws, events, PROJECT_B, 30000)
      console.log('  Project B completed despite abort on A')
    }))

  } finally {
    if (conn?.ws) conn.ws.close()
  }

  const passed = results.filter(r => r).length
  const total = results.length
  console.log(`\n=== Summary: ${passed}/${total} tests passed ===`)
  process.exit(passed === total ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
