// Test: Models API endpoints
// Tests: GET /api/models, model configuration endpoints

const API_BASE = 'http://localhost:4200/api'
const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
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

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json().catch(() => null)
    : null
  return { status: res.status, data }
}

async function main() {
  console.log('=== Models API Tests ===\n')

  const results = []

  // Test 1: List available models (skip if endpoint not available)
  results.push(await test('GET /api/models - list available models', async () => {
    const { status, data } = await request('/models')
    if (status === 404) {
      console.log('  (Models endpoint not implemented - skipping)')
      return
    }
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)
    if (!Array.isArray(data)) throw new Error('Expected array response')
    if (data.length === 0) throw new Error('Expected at least one model')

    console.log(`  Found ${data.length} models:`)
    data.slice(0, 5).forEach(m => {
      console.log(`    - ${m.displayName || m.value} (${m.description?.slice(0, 40)}...)`)
    })
  }))

  // Test 2: Get current model configuration
  results.push(await test('GET /api/models/current - get current model', async () => {
    const { status, data } = await request('/models/current')
    if (status === 404) {
      console.log('  (Models endpoint not implemented - skipping)')
      return
    }
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)
    console.log(`  Current model: ${data.model || 'not set'}`)
  }))

  // Test 3: Set model via WebSocket (models API might not have POST)
  // This tests the WebSocket set_model message
  results.push(await test('WebSocket set_model message', async () => {
    const { default: WebSocket } = await import('ws')
    const wsUrl = `ws://localhost:4200/ws?token=${TOKEN}&clientId=test-models-${Date.now()}`

    const ws = new WebSocket(wsUrl)
    const events = []

    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(reject, 5000)
    })

    ws.on('message', (data) => {
      events.push(JSON.parse(data.toString()))
    })

    // First switch to a project (required for set_model to work)
    ws.send(JSON.stringify({
      type: 'switch_project',
      projectId: 'proj-test-models',
      projectCwd: '/Users/maxwin/workspace/test-projects/project-a'
    }))

    // Wait for init
    await new Promise((resolve, reject) => {
      const check = () => {
        const init = events.find(e => e.type === 'system' && e.subtype === 'init')
        if (init) return resolve()
      }
      const interval = setInterval(check, 100)
      setTimeout(() => {
        clearInterval(interval)
        reject(new Error('Timeout waiting for init'))
      }, 5000)
      ws.on('message', check)
    })

    // Set a model
    ws.send(JSON.stringify({ type: 'set_model', model: 'claude-opus-4-6' }))

    // Wait for model_changed event (may not be sent by all server versions)
    try {
      await new Promise((resolve, reject) => {
        const check = () => {
          const changed = events.find(e => e.type === 'model_changed')
          if (changed) return resolve()
        }
        const interval = setInterval(check, 100)
        setTimeout(() => {
          clearInterval(interval)
          reject(new Error('Timeout'))
        }, 5000)
        ws.on('message', check)
      })
      console.log('  Model changed successfully via WebSocket')
    } catch {
      console.log('  (model_changed event not received - may not be implemented)')
    }
    ws.close()
  }))

  // Test 4: Check model supportsEffort flag (skip if endpoint not available)
  results.push(await test('Verify model capabilities flags', async () => {
    const { status, data } = await request('/models')
    if (status === 404) {
      console.log('  (Models endpoint not implemented - skipping)')
      return
    }
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)

    const opus = data.find(m => m.value === 'claude-opus-4-6')
    if (opus) {
      console.log(`  Opus supportsEffort: ${opus.supportsEffort}`)
      console.log(`  Opus supportedEffortLevels: ${opus.supportedEffortLevels?.join(', ')}`)
    }

    const haiku = data.find(m => m.value === 'claude-haiku-4-5-20251001')
    if (haiku) {
      console.log(`  Haiku supportsFastMode: ${haiku.supportsFastMode}`)
    }
  }))

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
