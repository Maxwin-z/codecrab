// Test: Send 3 queries to Project A first, then send 4th query to A + 1st to B in parallel
// This matches the user's bug report: "A项目里面输入第4次，B项目里面也输入"
import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-1773196857111-c3clt4'
const PROJECT_B = 'proj-1773161933895-jeagb6'

const ws = new WebSocket(`ws://localhost:4200/ws?token=${TOKEN}&clientId=test-resume-${Date.now()}`)

let phase = 0 // 0=warmup, 1=parallel
let warmupCount = 0
const WARMUP_QUERIES = 3

const state = {
  [PROJECT_A]: { started: false, firstDelta: false, ended: false, messages: 0 },
  [PROJECT_B]: { started: false, firstDelta: false, ended: false, messages: 0 },
}

function label(pid) { return pid === PROJECT_A ? 'A' : 'B' }

function sendParallel() {
  phase = 1
  state[PROJECT_A] = { started: false, firstDelta: false, ended: false, messages: 0 }
  state[PROJECT_B] = { started: false, firstDelta: false, ended: false, messages: 0 }

  console.log('\n========================================')
  console.log('[PHASE 2] Sending 4th query to A + 1st query to B IN PARALLEL...')
  console.log('========================================\n')

  ws.send(JSON.stringify({ type: 'prompt', prompt: 'Say exactly "Query 4 from A" and nothing else.', projectId: PROJECT_A }))
  ws.send(JSON.stringify({ type: 'prompt', prompt: 'Say exactly "Query 1 from B" and nothing else.', projectId: PROJECT_B }))
}

function sendWarmup() {
  warmupCount++
  console.log(`\n[PHASE 1] Sending warmup query ${warmupCount}/${WARMUP_QUERIES} to Project A...`)
  ws.send(JSON.stringify({
    type: 'prompt',
    prompt: `Say exactly "Warmup ${warmupCount}" and nothing else.`,
    projectId: PROJECT_A,
  }))
}

ws.on('open', () => {
  console.log('[WS] Connected')
  ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: '/Users/maxwin/workspace/test-projects/project-a' }))
  ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_B, projectCwd: '/Users/maxwin/workspace/test-projects/project-b' }))

  setTimeout(() => sendWarmup(), 1000)
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  const pid = msg.projectId
  if (!pid) return

  const l = label(pid)

  if (phase === 0) {
    // Warmup phase - only care about Project A
    if (pid === PROJECT_A) {
      if (msg.type === 'query_end') {
        console.log(`[${l}] Warmup query ${warmupCount} completed ✓`)
        if (warmupCount < WARMUP_QUERIES) {
          setTimeout(() => sendWarmup(), 500)
        } else {
          setTimeout(() => sendParallel(), 500)
        }
      } else if (msg.type === 'assistant_text') {
        console.log(`[${l}] Response: "${msg.text?.slice(0, 50)}"`)
      }
    }
    return
  }

  // Parallel phase
  if (!state[pid]) return
  const s = state[pid]
  s.messages++

  switch (msg.type) {
    case 'query_start':
      s.started = true
      console.log(`[${l}] query_start ✓`)
      break
    case 'stream_delta':
      if (!s.firstDelta) {
        s.firstDelta = true
        console.log(`[${l}] First stream_delta ✓ (text: "${msg.text?.slice(0, 50)}")`)
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
      console.log(`[${l}] result (cost: $${msg.costUsd?.toFixed(4)})`)
      break
    case 'assistant_text':
      console.log(`[${l}] assistant_text: "${msg.text?.slice(0, 80)}"`)
      break
  }
})

ws.on('error', (err) => console.error('[WS] Error:', err.message))
ws.on('close', () => console.log('[WS] Disconnected'))

function checkDone() {
  if (state[PROJECT_A].ended && state[PROJECT_B].ended) {
    console.log('\n=== PARALLEL TEST COMPLETE ===')
    console.log(`Project A: started=${state[PROJECT_A].started}, firstDelta=${state[PROJECT_A].firstDelta}, ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
    console.log(`Project B: started=${state[PROJECT_B].started}, firstDelta=${state[PROJECT_B].firstDelta}, ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)
    const passed = state[PROJECT_A].firstDelta && state[PROJECT_B].firstDelta
    console.log(`Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`)
    setTimeout(() => process.exit(passed ? 0 : 1), 500)
  }
}

// Timeout
setTimeout(() => {
  console.log('\n=== TIMEOUT (90s) ===')
  console.log(`Phase: ${phase}, Warmup: ${warmupCount}/${WARMUP_QUERIES}`)
  console.log(`Project A: started=${state[PROJECT_A].started}, firstDelta=${state[PROJECT_A].firstDelta}, ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
  console.log(`Project B: started=${state[PROJECT_B].started}, firstDelta=${state[PROJECT_B].firstDelta}, ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)

  // Try aborting stuck queries
  if (state[PROJECT_A].started && !state[PROJECT_A].ended) {
    console.log('[TEST] Aborting stuck Project A...')
    ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_A }))
  }
  if (state[PROJECT_B].started && !state[PROJECT_B].ended) {
    console.log('[TEST] Aborting stuck Project B...')
    ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_B }))
  }

  setTimeout(() => {
    console.log('\nAfter abort:')
    console.log(`Project A: ended=${state[PROJECT_A].ended}, msgs=${state[PROJECT_A].messages}`)
    console.log(`Project B: ended=${state[PROJECT_B].ended}, msgs=${state[PROJECT_B].messages}`)
    process.exit(1)
  }, 10000)
}, 90000)
