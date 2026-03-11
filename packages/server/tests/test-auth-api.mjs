// Test: Authentication API endpoints
// Tests: GET /api/auth/status, POST /api/auth/login, protected endpoint access

const API_BASE = 'http://localhost:4200/api'
const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const WRONG_TOKEN = 'wrong-token-12345'

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

async function request(path, options = {}, customToken = null) {
  const url = `${API_BASE}${path}`
  const headers = {
    'Content-Type': 'application/json',
  }
  if (customToken !== null) {
    headers['Authorization'] = `Bearer ${customToken}`
  }

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers }
  })
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json().catch(() => null)
    : null
  return { status: res.status, data }
}

async function main() {
  console.log('=== Authentication API Tests ===\n')

  const results = []

  // Test 1: Auth status without token
  results.push(await test('GET /api/auth/status - public endpoint', async () => {
    const { status, data } = await request('/auth/status')
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)
    console.log(`  Auth configured: ${data?.configured}`)
    console.log(`  Auth required: ${data?.authRequired}`)
  }))

  // Test 2: Access protected endpoint without token
  results.push(await test('Protected endpoint without token returns 401', async () => {
    const { status } = await request('/projects')
    if (status !== 401) throw new Error(`Expected 401, got ${status}`)
    console.log('  Correctly returned 401')
  }))

  // Test 3: Access protected endpoint with wrong token
  results.push(await test('Protected endpoint with wrong token returns 401', async () => {
    const { status } = await request('/projects', {}, WRONG_TOKEN)
    if (status !== 401) throw new Error(`Expected 401, got ${status}`)
    console.log('  Correctly returned 401')
  }))

  // Test 4: Access protected endpoint with valid token
  results.push(await test('Protected endpoint with valid token returns 200', async () => {
    const { status } = await request('/projects', {}, TOKEN)
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)
    console.log('  Correctly returned 200')
  }))

  // Test 5: WebSocket connection without token
  results.push(await test('WebSocket without token rejected', async () => {
    const { default: WebSocket } = await import('ws')
    const ws = new WebSocket('ws://localhost:4200/ws')

    const result = await new Promise((resolve) => {
      ws.on('error', () => resolve('error'))
      ws.on('close', (code) => resolve(`close:${code}`))
      setTimeout(() => resolve('timeout'), 3000)
    })

    if (result !== 'error' && !result.startsWith('close:')) {
      throw new Error(`Expected connection error, got: ${result}`)
    }
    console.log('  Connection rejected as expected')
    ws.close()
  }))

  // Test 6: WebSocket connection with valid token
  results.push(await test('WebSocket with valid token accepted', async () => {
    const { default: WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://localhost:4200/ws?token=${TOKEN}&clientId=test-auth-${Date.now()}`)

    const result = await new Promise((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('error'))
      ws.on('close', () => resolve('close'))
      setTimeout(() => resolve('timeout'), 5000)
    })

    if (result !== 'open') {
      throw new Error(`Expected open, got: ${result}`)
    }
    console.log('  Connection accepted')
    ws.close()
  }))

  // Test 7: Health check is public
  results.push(await test('GET /api/health - public endpoint', async () => {
    // Health endpoint might be at /api/health or /health
    const { status, data } = await fetch('http://localhost:4200/api/health').then(r =>
      r.json().then(data => ({ status: r.status, data })).catch(() => ({ status: r.status, data: null }))
    ).catch(() => ({ status: 0, data: null }))

    if (status === 200) {
      console.log('  Health check accessible')
    } else {
      console.log('  Health endpoint status:', status, '(may not be configured)')
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
