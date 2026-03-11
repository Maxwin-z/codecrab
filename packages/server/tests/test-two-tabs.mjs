// Test: Two separate WebSocket connections (simulating two browser tabs)
// Tab 1 → Project A (with 3 warmup queries first)
// Tab 2 → Project B
// Then send 4th query on Tab1/A + 1st query on Tab2/B simultaneously
import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-1773196857111-c3clt4'
const PROJECT_B = 'proj-1773161933895-jeagb6'

function createTab(name, projectId, projectCwd) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:4200/ws?token=${TOKEN}&clientId=tab-${name}-${Date.now()}`)
    const tab = { ws, name, projectId, ready: false, queryState: { started: false, firstDelta: false, ended: false, messages: 0 } }

    ws.on('open', () => {
      console.log(`[Tab ${name}] Connected`)
      ws.send(JSON.stringify({ type: 'switch_project', projectId, projectCwd }))
      setTimeout(() => {
        tab.ready = true
        resolve(tab)
      }, 500)
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.projectId !== projectId) return

      const s = tab.queryState

      switch (msg.type) {
        case 'query_start':
          s.started = true
          console.log(`[Tab ${name}] query_start ✓`)
          break
        case 'stream_delta':
          s.messages++
          if (!s.firstDelta) {
            s.firstDelta = true
            console.log(`[Tab ${name}] First stream_delta ✓ (text: "${msg.text?.slice(0, 50)}")`)
          }
          break
        case 'query_end':
          s.ended = true
          console.log(`[Tab ${name}] query_end ✓ (messages: ${s.messages})`)
          tab.onQueryEnd?.()
          break
        case 'error':
          console.log(`[Tab ${name}] ERROR: ${msg.message}`)
          break
        case 'result':
          console.log(`[Tab ${name}] result (cost: $${msg.costUsd?.toFixed(4)})`)
          break
        case 'assistant_text':
          console.log(`[Tab ${name}] response: "${msg.text?.slice(0, 80)}"`)
          break
        case 'aborted':
          console.log(`[Tab ${name}] aborted`)
          tab.onQueryEnd?.()
          break
      }
    })

    ws.on('error', (err) => console.error(`[Tab ${name}] WS Error:`, err.message))
  })
}

function sendQuery(tab, prompt) {
  return new Promise((resolve) => {
    tab.queryState = { started: false, firstDelta: false, ended: false, messages: 0 }
    tab.onQueryEnd = resolve
    tab.ws.send(JSON.stringify({ type: 'prompt', prompt, projectId: tab.projectId }))
  })
}

async function main() {
  console.log('=== Creating two browser tabs ===\n')
  const tabA = await createTab('A', PROJECT_A, '/Users/maxwin/workspace/test-projects/project-a')
  const tabB = await createTab('B', PROJECT_B, '/Users/maxwin/workspace/test-projects/project-b')

  // Phase 1: Warmup queries on Tab A
  console.log('\n=== PHASE 1: Warmup queries on Tab A ===\n')
  for (let i = 1; i <= 3; i++) {
    console.log(`--- Warmup ${i}/3 ---`)
    await sendQuery(tabA, `Say exactly "Warmup ${i}" and nothing else.`)
    console.log()
  }

  // Phase 2: Parallel queries
  console.log('\n=== PHASE 2: Parallel - 4th query on Tab A + 1st query on Tab B ===\n')
  tabA.queryState = { started: false, firstDelta: false, ended: false, messages: 0 }
  tabB.queryState = { started: false, firstDelta: false, ended: false, messages: 0 }

  const queryA = sendQuery(tabA, 'Say exactly "Query 4 from A" and nothing else.')
  const queryB = sendQuery(tabB, 'Say exactly "Query 1 from B" and nothing else.')

  // Race: either both complete or timeout
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))

  try {
    await Promise.race([Promise.all([queryA, queryB]), timeout])

    console.log('\n=== TEST COMPLETE ===')
    console.log(`Tab A: started=${tabA.queryState.started}, firstDelta=${tabA.queryState.firstDelta}, ended=${tabA.queryState.ended}`)
    console.log(`Tab B: started=${tabB.queryState.started}, firstDelta=${tabB.queryState.firstDelta}, ended=${tabB.queryState.ended}`)
    const passed = tabA.queryState.firstDelta && tabB.queryState.firstDelta
    console.log(`Result: ${passed ? 'PASS ✓' : 'FAIL ✗'}`)

    tabA.ws.close()
    tabB.ws.close()
    process.exit(passed ? 0 : 1)
  } catch (err) {
    console.log(`\n=== ${err.message} ===`)
    console.log(`Tab A: started=${tabA.queryState.started}, firstDelta=${tabA.queryState.firstDelta}, ended=${tabA.queryState.ended}, msgs=${tabA.queryState.messages}`)
    console.log(`Tab B: started=${tabB.queryState.started}, firstDelta=${tabB.queryState.firstDelta}, ended=${tabB.queryState.ended}, msgs=${tabB.queryState.messages}`)

    // Try aborting stuck queries
    if (tabA.queryState.started && !tabA.queryState.ended) {
      console.log('\n[TEST] Aborting stuck Tab A...')
      tabA.ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_A }))
    }
    if (tabB.queryState.started && !tabB.queryState.ended) {
      console.log('[TEST] Aborting stuck Tab B...')
      tabB.ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_B }))
    }

    await new Promise(r => setTimeout(r, 5000))
    console.log('\nAfter abort:')
    console.log(`Tab A: ended=${tabA.queryState.ended}`)
    console.log(`Tab B: ended=${tabB.queryState.ended}`)

    tabA.ws.close()
    tabB.ws.close()
    process.exit(1)
  }
}

main().catch(console.error)
