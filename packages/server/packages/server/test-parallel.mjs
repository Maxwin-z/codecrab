// Test parallel project queries via WebSocket
import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-1773196857111-c3clt4' // project-a
const PROJECT_B = 'proj-1773161933895-jeagb6' // project-b

const ws = new WebSocket(`ws://localhost:4200/ws?token=${TOKEN}&clientId=test-parallel-${Date.now()}`)

// Track per-project state
const state = {
  [PROJECT_A]: { started: false, firstDelta: false, ended: false, messages: 0 },
  [PROJECT_B]: { started: false, firstDelta: false, ended: false, messages: 0 },
}

function label(pid) {
  return pid === PROJECT_A ? 'A' : 'B'
}

ws.on('open', () => {
  console.log('[WS] Connected')

  // Subscribe to both projects
  ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: '/Users/maxwin/workspace/test-projects/project-a' }))
  ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_B, projectCwd: '/Users/maxwin/workspace/test-projects/project-b' }))

  // Wait a bit for subscriptions to process, then send prompts to both projects simultaneously
  setTimeout(() => {
    console.log('\n[TEST] Sending prompts to BOTH projects simultaneously...')
    const t = Date.now()
    ws.send(JSON.stringify({ type: 'prompt', prompt: 'Say exactly "Hello from project A" and nothing else.', projectId: PROJECT_A }))
    ws.send(JSON.stringify({ type: 'prompt', prompt: 'Say exactly "Hello from project B" and nothing else.', projectId: PROJECT_B }))
    console.log(`[TEST] Both prompts sent in ${Date.now() - t}ms`)
  }, 1000)
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  const pid = msg.projectId

  if (!pid || !state[pid]) {
    // Global messages
    if (msg.type === 'project_statuses') {
      const statuses = msg.statuses?.map(s => `${label(s.projectId)}:${s.status}`).join(', ')
      console.log(`[STATUS] ${statuses}`)
    }
    return
  }

  const s = state[pid]
  const l = label(pid)
  s.messages++

  switch (msg.type) {
    case 'query_start':
      s.started = true
      console.log(`[${l}] query_start ✓`)
      break
    case 'stream_delta':
      if (!s.firstDelta) {
        s.firstDelta = true
        console.log(`[${l}] First stream_delta received ✓ (text: "${msg.text?.slice(0, 50)}")`)
      }
      break
    case 'query_end':
      s.ended = true
      console.log(`[${l}] query_end ✓ (total messages: ${s.messages})`)
      checkDone()
      break
    case 'error':
      console.log(`[${l}] ERROR: ${msg.message}`)
      break
    case 'result':
      console.log(`[${l}] result received (cost: $${msg.costUsd?.toFixed(4)})`)
      break
    case 'aborted':
      console.log(`[${l}] aborted`)
      break
    case 'system':
      if (msg.subtype === 'init') {
        console.log(`[${l}] session init: ${msg.sessionId}`)
      }
      break
    case 'assistant_text':
      console.log(`[${l}] assistant_text: "${msg.text?.slice(0, 80)}"`)
      break
  }
})

ws.on('error', (err) => {
  console.error('[WS] Error:', err.message)
})

ws.on('close', () => {
  console.log('[WS] Disconnected')
})

function checkDone() {
  if (state[PROJECT_A].ended && state[PROJECT_B].ended) {
    console.log('\n=== TEST COMPLETE ===')
    console.log(`Project A: started=${state[PROJECT_A].started}, firstDelta=${state[PROJECT_A].firstDelta}, ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
    console.log(`Project B: started=${state[PROJECT_B].started}, firstDelta=${state[PROJECT_B].firstDelta}, ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)
    const passed = state[PROJECT_A].firstDelta && state[PROJECT_B].firstDelta
    console.log(`Result: ${passed ? 'PASS ✓' : 'FAIL ✗ - one project never received stream data'}`)
    setTimeout(() => process.exit(passed ? 0 : 1), 500)
  }
}

// Timeout after 60s
setTimeout(() => {
  console.log('\n=== TIMEOUT (60s) ===')
  console.log(`Project A: started=${state[PROJECT_A].started}, firstDelta=${state[PROJECT_A].firstDelta}, ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
  console.log(`Project B: started=${state[PROJECT_B].started}, firstDelta=${state[PROJECT_B].firstDelta}, ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)

  // If one project is stuck, try aborting it
  if (state[PROJECT_A].started && !state[PROJECT_A].ended) {
    console.log('\n[TEST] Project A is stuck, attempting abort...')
    ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_A }))
  }
  if (state[PROJECT_B].started && !state[PROJECT_B].ended) {
    console.log('\n[TEST] Project B is stuck, attempting abort...')
    ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_B }))
  }

  setTimeout(() => {
    console.log('\nFinal state after abort attempt:')
    console.log(`Project A: started=${state[PROJECT_A].started}, firstDelta=${state[PROJECT_A].firstDelta}, ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
    console.log(`Project B: started=${state[PROJECT_B].started}, firstDelta=${state[PROJECT_B].firstDelta}, ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)
    process.exit(1)
  }, 10000)
}, 60000)
