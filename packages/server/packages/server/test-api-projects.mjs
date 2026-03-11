// Test: Project API endpoints
// Tests: GET /api/projects, POST /api/projects, GET /api/projects/:id, DELETE /api/projects/:id

const API_BASE = 'http://localhost:4200/api'
const TOKEN = '8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66'
const TEST_PROJECT_PATH_A = '/Users/maxwin/workspace/test-projects/project-a'
const TEST_PROJECT_PATH_B = '/Users/maxwin/workspace/test-projects/project-b'

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

let createdProjectId = null

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
  console.log('=== Project API Tests ===\n')

  const results = []

  // Test 1: List projects
  results.push(await test('GET /api/projects - list projects', async () => {
    const { status, data } = await request('/projects')
    if (status !== 200) throw new Error(`Expected 200, got ${status}`)
    if (!Array.isArray(data)) throw new Error('Expected array response')
    console.log(`  Found ${data.length} projects`)
  }))

  // Test 2: Create project A (or use existing)
  results.push(await test('POST /api/projects - create project A', async () => {
    const { status, data } = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test Project A',
        path: TEST_PROJECT_PATH_A,
        icon: '📁',
      }),
    })
    if (status === 409) {
      // Project already exists, find it
      const { data: projects } = await request('/projects')
      const existing = projects.find(p => p.path === TEST_PROJECT_PATH_A)
      if (existing) {
        createdProjectId = existing.id
        console.log(`  Using existing project: ${existing.id}`)
        return
      }
    }
    if (status !== 201) throw new Error(`Expected 201, got ${status}: ${JSON.stringify(data)}`)
    if (!data.id) throw new Error('Expected project id in response')
    createdProjectId = data.id
    console.log(`  Created project: ${data.id}`)
  }))

  // Test 3: Create project B (or use existing)
  results.push(await test('POST /api/projects - create project B', async () => {
    const { status, data } = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test Project B',
        path: TEST_PROJECT_PATH_B,
        icon: '📂',
      }),
    })
    if (status === 409) {
      console.log(`  Project B already exists`)
      return
    }
    if (status !== 201) throw new Error(`Expected 201, got ${status}`)
    console.log(`  Created project: ${data.id}`)
  }))

  // Test 4: Create duplicate project (should fail)
  results.push(await test('POST /api/projects - reject duplicate path', async () => {
    const { status, data } = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Duplicate Project',
        path: TEST_PROJECT_PATH_A,
      }),
    })
    if (status !== 409) throw new Error(`Expected 409, got ${status}`)
    console.log(`  Correctly rejected duplicate with 409`)
  }))

  // Test 5: Create project without name (should fail)
  results.push(await test('POST /api/projects - reject missing name', async () => {
    const { status } = await request('/projects', {
      method: 'POST',
      body: JSON.stringify({ path: '/some/path' }),
    })
    if (status !== 400) throw new Error(`Expected 400, got ${status}`)
    console.log(`  Correctly rejected missing name with 400`)
  }))

  // Test 6: Get single project
  if (createdProjectId) {
    results.push(await test('GET /api/projects/:id - get single project', async () => {
      const { status, data } = await request(`/projects/${createdProjectId}`)
      if (status !== 200) throw new Error(`Expected 200, got ${status}`)
      if (data.id !== createdProjectId) throw new Error('Project id mismatch')
      console.log(`  Retrieved: ${data.name} at ${data.path}`)
    }))

    // Test 7: Get non-existent project
    results.push(await test('GET /api/projects/:id - return 404 for non-existent', async () => {
      const { status } = await request('/projects/proj-nonexistent123')
      if (status !== 404) throw new Error(`Expected 404, got ${status}`)
      console.log(`  Correctly returned 404`)
    }))

    // Test 8: Delete project
    results.push(await test('DELETE /api/projects/:id - delete project', async () => {
      const { status } = await request(`/projects/${createdProjectId}`, { method: 'DELETE' })
      if (status !== 204) throw new Error(`Expected 204, got ${status}`)
      console.log(`  Deleted project: ${createdProjectId}`)

      // Verify deletion
      const getRes = await request(`/projects/${createdProjectId}`)
      if (getRes.status !== 404) throw new Error('Project should be deleted')
    }))
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
