// Test Runner - Run all test suites
// Usage: node test-runner.mjs [test-name-pattern]

import { spawn } from 'child_process'
import { readdir } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TESTS = [
  { file: 'test-api-projects.mjs', name: 'Project API', description: 'CRUD operations for projects' },
  { file: 'test-api-sessions.mjs', name: 'Session API', description: 'Session listing and deletion' },
  { file: 'test-auth-api.mjs', name: 'Auth API', description: 'Authentication and authorization' },
  { file: 'test-models-api.mjs', name: 'Models API', description: 'Model listing and configuration' },
  { file: 'test-websocket-basic.mjs', name: 'WebSocket Basic', description: 'Connection, prompts, streaming' },
  { file: 'test-multi-project-chat.mjs', name: 'Multi-Project Chat', description: 'Parallel and sequential queries' },
  { file: 'test-session-resume.mjs', name: 'Session Resume', description: 'Session persistence and resume' },
  { file: 'test-parallel.mjs', name: 'Parallel Projects', description: 'Two projects simultaneous queries' },
  { file: 'test-two-tabs.mjs', name: 'Two Browser Tabs', description: 'Separate WS connections per tab' },
  { file: 'test-integration-full.mjs', name: 'Full Integration', description: 'Complete workflow test' },
]

async function runTest(testFile, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const child = spawn('node', [join(__dirname, testFile)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({
        success: false,
        duration: Date.now() - startTime,
        output: stdout,
        error: stderr || 'Test timed out',
        timeout: true
      })
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        success: code === 0,
        duration: Date.now() - startTime,
        output: stdout,
        error: stderr,
        timeout: false
      })
    })
  })
}

async function main() {
  const pattern = process.argv[2]?.toLowerCase()

  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║              CodeClaws Test Runner                         ║')
  console.log('╚════════════════════════════════════════════════════════════╝')
  console.log()

  // Filter tests by pattern if provided
  const testsToRun = pattern
    ? TESTS.filter(t => t.name.toLowerCase().includes(pattern) || t.file.toLowerCase().includes(pattern))
    : TESTS

  if (testsToRun.length === 0) {
    console.log(`No tests matching pattern: "${pattern}"`)
    console.log('\nAvailable tests:')
    TESTS.forEach(t => console.log(`  - ${t.name} (${t.file})`))
    process.exit(1)
  }

  console.log(`Running ${testsToRun.length} test(s)${pattern ? ` matching "${pattern}"` : ''}...\n`)

  const results = []
  let passed = 0
  let failed = 0

  for (const test of testsToRun) {
    process.stdout.write(`${test.name.padEnd(20)} `)
    process.stdout.write(`${test.description.slice(0, 30).padEnd(32)} `)

    const result = await runTest(test.file)
    results.push({ ...test, ...result })

    if (result.success) {
      passed++
      process.stdout.write(`✓ PASS  ${(result.duration / 1000).toFixed(1)}s\n`)
    } else {
      failed++
      process.stdout.write(`✗ FAIL  ${(result.duration / 1000).toFixed(1)}s`)
      if (result.timeout) process.stdout.write(' [TIMEOUT]')
      process.stdout.write('\n')
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log(`Results: ${passed} passed, ${failed} failed, ${testsToRun.length} total`)
  console.log('═'.repeat(60))

  // Show details for failed tests
  if (failed > 0) {
    console.log('\nFailed test details:')
    for (const result of results.filter(r => !r.success)) {
      console.log(`\n--- ${result.name} ---`)
      if (result.error) {
        console.log('Error:', result.error.slice(0, 200))
      }
      if (result.output) {
        const lines = result.output.split('\n').slice(-10) // Last 10 lines
        console.log('Output (last 10 lines):')
        lines.forEach(l => console.log('  ' + l))
      }
    }
  }

  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Test runner error:', err)
  process.exit(1)
})
