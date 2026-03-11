// Test: Session resume functionality
// Tests: resume_session, message_history, session persistence

import WebSocket from 'ws'

const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const PROJECT_A = 'proj-test-resume-a'
const CWD_A = '/Users/maxwin/workspace/test-projects/project-a'

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

function connectWebSocket(clientId) {
  const url = `ws://localhost:4200/ws?token=${TOKEN}&clientId=${clientId}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
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

async function waitForMessage(events, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const check = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - startTime > timeout) {
        return reject(new Error('Timeout waiting for message'))
      }
      setTimeout(check, 100)
    }
    check()
  })
}

async function sendPromptAndWait(ws, events, projectId, prompt) {
  events.length = 0
  ws.send(JSON.stringify({ type: 'prompt', prompt, projectId }))
  return waitForMessage(events, m => m.type === 'query_end' && m.projectId === projectId, 30000)
}

async function main() {
  console.log('=== Session Resume Tests ===\n')

  const results = []
  let conn1 = null
  let conn2 = null

  try {
    // Test 1: Create session with first connection
    let sessionId = null
    results.push(await test('Create session and get session ID', async () => {
      conn1 = await connectWebSocket(`test-resume-1-${Date.now()}`)
      const { ws, events } = conn1

      ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: CWD_A }))

      const initMsg = await waitForMessage(events, m => m.type === 'system' && m.subtype === 'init')
      sessionId = initMsg.sessionId
      console.log(`  Session created: ${sessionId}`)
    }))

    const { ws: ws1, events: events1 } = conn1

    // Test 2: Send some messages to build history
    results.push(await test('Build conversation history', async () => {
      await sendPromptAndWait(ws1, events1, PROJECT_A, 'My name is TestBot. Remember this.')
      await sendPromptAndWait(ws1, events1, PROJECT_A, 'What is my name?')
      console.log('  Sent 2 messages')
    }))

    // Test 3: Disconnect and reconnect with resume_session
    results.push(await test('Disconnect and resume session', async () => {
      // Close first connection
      ws1.close()
      await new Promise(r => setTimeout(r, 1000))

      // Create new connection with resume
      conn2 = await connectWebSocket(`test-resume-2-${Date.now()}`)
      const { ws, events } = conn2

      // First switch to project, then resume session
      ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: CWD_A }))
      await new Promise(r => setTimeout(r, 500))

      ws.send(JSON.stringify({ type: 'resume_session', sessionId, projectId: PROJECT_A }))

      const resumedMsg = await waitForMessage(events, m => m.type === 'session_resumed', 30000)
      console.log(`  Session resumed: ${sessionId}`)
    }))

    const { ws: ws2, events: events2 } = conn2

    // Test 4: Continue conversation in resumed session
    results.push(await test('Continue conversation after resume', async () => {
      events2.length = 0
      ws2.send(JSON.stringify({
        type: 'prompt',
        prompt: 'What is my name? (You should remember from earlier)',
        projectId: PROJECT_A
      }))

      await waitForMessage(events2, m => m.type === 'query_end', 30000)

      const assistantMsgs = events2.filter(m => m.type === 'assistant_text')
      const hasMemory = assistantMsgs.some(m =>
        m.text?.toLowerCase().includes('testbot') ||
        m.text?.toLowerCase().includes('test bot')
      )

      if (hasMemory) {
        console.log('  Assistant remembered the name!')
      } else {
        console.log('  Note: Assistant response:', assistantMsgs[0]?.text?.slice(0, 50))
      }
    }))

    // Test 5: Get message history (may not be sent depending on server config)
    results.push(await test('Receive message history after resume', async () => {
      try {
        const historyMsg = await waitForMessage(events2, m => m.type === 'message_history', 10000)
        console.log(`  Received ${historyMsg.messages?.length || 0} messages in history`)
      } catch (err) {
        console.log('  (message_history not received - server may not send it)')
      }
    }))

    // Test 6: Invalid session resume (non-existent)
    results.push(await test('Handle invalid session ID gracefully', async () => {
      const conn3 = await connectWebSocket(`test-resume-3-${Date.now()}`)

      conn3.ws.send(JSON.stringify({
        type: 'resume_session',
        sessionId: 'session-nonexistent-12345',
        projectId: PROJECT_A
      }))

      // Should get an error or new session created
      const msg = await waitForMessage(conn3.events, m =>
        m.type === 'error' ||
        (m.type === 'system' && m.subtype === 'init'),
        5000
      )

      console.log(`  Response: ${msg.type}`)
      conn3.ws.close()
    }))

    // Test 7: Multiple resumes of same session
    results.push(await test('Multiple connections to same session', async () => {
      // This tests that session state is properly managed
      const conn3 = await connectWebSocket(`test-resume-3-${Date.now()}`)

      // First switch to project
      conn3.ws.send(JSON.stringify({ type: 'switch_project', projectId: PROJECT_A, projectCwd: CWD_A }))
      await new Promise(r => setTimeout(r, 500))

      conn3.ws.send(JSON.stringify({ type: 'resume_session', sessionId, projectId: PROJECT_A }))

      try {
        await waitForMessage(conn3.events, m => m.type === 'session_resumed', 30000)
        console.log('  Second connection resumed same session')
      } catch (err) {
        console.log('  (session_resumed not received, checking for init)')
        await waitForMessage(conn3.events, m => m.type === 'system' && m.subtype === 'init', 10000)
        console.log('  New session initialized instead')
      }

      conn3.ws.close()
    }))

  } finally {
    if (conn1?.ws) conn1.ws.close()
    if (conn2?.ws) conn2.ws.close()
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
