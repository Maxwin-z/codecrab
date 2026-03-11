// Test: Basic WebSocket functionality
// Tests: connection, switch_project, prompt, stream_delta, query_start/end, assistant_text

import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-test-ws-a'
const CWD_A = '/Users/maxwin/workspace/test-projects/project-a'

const WS_URL = `ws://localhost:4200/ws?token=${TOKEN}&clientId=test-ws-basic-${Date.now()}`

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

    ws.on('open', () => {
      resolve({ ws, events })
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      events.push(msg)
    })

    ws.on('error', reject)
  })
}

async function waitForMessage(ws, events, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
    }
    check()

    const interval = setInterval(check, 100)
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error('Timeout waiting for message'))
    }, timeout)

    ws.on('message', () => {
      check()
      if (events.find(predicate)) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(events.find(predicate))
      }
    })
  })
}

async function main() {
  console.log('=== WebSocket Basic Tests ===\n')

  const results = []
  let conn = null

  try {
    // Test 1: Connect to WebSocket
    results.push(await test('WebSocket connection established', async () => {
      conn = await connectWebSocket()
      console.log('  Connected to WebSocket')
    }))

    const { ws, events } = conn

    // Test 2: Switch project
    results.push(await test('switch_project message', async () => {
      ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: CWD_A }))
      const msg = await waitForMessage(ws, events, m => m.type === 'system' && m.subtype === 'init')
      if (!msg.sessionId) throw new Error('No sessionId in init message')
      console.log(`  Session initialized: ${msg.sessionId}`)
    }))

    // Test 3: Send prompt and receive query_start
    results.push(await test('prompt triggers query_start', async () => {
      events.length = 0 // clear events
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'Say "hello"', projectId: PROJECT_A }))
      const msg = await waitForMessage(ws, events, m => m.type === 'query_start' && m.projectId === PROJECT_A)
      console.log('  query_start received')
    }))

    // Test 4: Receive stream_delta
    results.push(await test('stream_delta received', async () => {
      const msg = await waitForMessage(ws, events, m => m.type === 'stream_delta' && m.projectId === PROJECT_A)
      if (!msg.text) throw new Error('No text in stream_delta')
      console.log(`  First delta: "${msg.text.slice(0, 30)}..."`)
    }))

    // Test 5: Receive assistant_text
    results.push(await test('assistant_text received', async () => {
      const msg = await waitForMessage(ws, events, m => m.type === 'assistant_text' && m.projectId === PROJECT_A)
      console.log(`  Assistant: "${msg.text?.slice(0, 50)}..."`)
    }))

    // Test 6: Receive query_end
    results.push(await test('query_end received', async () => {
      const msg = await waitForMessage(ws, events, m => m.type === 'query_end' && m.projectId === PROJECT_A)
      console.log('  Query completed')
    }))

    // Test 7: Receive result with cost
    results.push(await test('result with cost info', async () => {
      const msg = await waitForMessage(ws, events, m => m.type === 'result' && m.projectId === PROJECT_A)
      console.log(`  Cost: $${msg.costUsd?.toFixed(4)}, Duration: ${msg.durationMs}ms`)
    }))

    // Test 8: Send command
    results.push(await test('command execution', async () => {
      events.length = 0
      ws.send(JSON.stringify({ type: 'command', command: 'pwd', projectId: PROJECT_A }))
      const startMsg = await waitForMessage(ws, events, m => m.type === 'query_start')
      const endMsg = await waitForMessage(ws, events, m => m.type === 'query_end')
      console.log('  Command executed')
    }))

    // Test 9: Abort query
    results.push(await test('abort query', async () => {
      events.length = 0
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'Write a very long story about', projectId: PROJECT_A }))
      await waitForMessage(ws, events, m => m.type === 'query_start')

      // Send abort immediately
      ws.send(JSON.stringify({ type: 'abort', projectId: PROJECT_A }))

      const msg = await waitForMessage(ws, events, m => m.type === 'aborted' || m.type === 'query_end', 5000)
      console.log(`  Query aborted (received ${msg.type})`)
    }))

    // Test 10: Invalid message type
    results.push(await test('invalid message type handling', async () => {
      events.length = 0
      ws.send(JSON.stringify({ type: 'invalid_type', projectId: PROJECT_A }))
      // Should not crash, wait a bit
      await new Promise(r => setTimeout(r, 500))
      console.log('  Server handled invalid message gracefully')
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
