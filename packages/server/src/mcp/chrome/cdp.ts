// Lightweight Chrome DevTools Protocol (CDP) client
// Communicates with Chrome via WebSocket on the remote debugging port.

import WebSocket from 'ws'
import * as http from 'http'

const CHROME_DEBUG_PORT = 9222

interface CDPResponse {
  id: number
  result?: any
  error?: { code: number; message: string }
}

/**
 * Get the WebSocket debugger URL for a specific tab (or the first tab).
 */
async function getDebuggerWsUrl(tabIndex = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data)
          const pages = tabs.filter((t: any) => t.type === 'page')
          if (pages.length === 0) {
            reject(new Error('No open tabs found'))
            return
          }
          const idx = Math.min(tabIndex, pages.length - 1)
          resolve(pages[idx].webSocketDebuggerUrl)
        } catch (e) {
          reject(new Error(`Failed to parse Chrome tabs: ${e}`))
        }
      })
    }).on('error', (err) => {
      reject(new Error(`Chrome not reachable: ${err.message}`))
    })
  })
}

/**
 * List all open tabs/pages.
 */
export async function listTabs(): Promise<
  { id: string; title: string; url: string; type: string }[]
> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data)
          resolve(
            tabs
              .filter((t: any) => t.type === 'page')
              .map((t: any) => ({
                id: t.id,
                title: t.title,
                url: t.url,
                type: t.type,
              })),
          )
        } catch (e) {
          reject(new Error(`Failed to parse tabs: ${e}`))
        }
      })
    }).on('error', (err) => {
      reject(new Error(`Chrome not reachable: ${err.message}`))
    })
  })
}

/**
 * Send a CDP command and wait for the result.
 */
async function sendCommand(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<any> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      try {
        const msg: CDPResponse = JSON.parse(data.toString())
        if (msg.id === id) {
          clearTimeout(timer)
          ws.off('message', handler)
          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`))
          } else {
            resolve(msg.result)
          }
        }
      } catch {
        // Ignore non-JSON or non-matching messages
      }
    }

    ws.on('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * Open a short-lived WebSocket connection, run a callback, and close.
 */
async function withConnection<T>(
  tabIndex: number,
  fn: (ws: WebSocket, send: typeof sendCommand) => Promise<T>,
): Promise<T> {
  const wsUrl = await getDebuggerWsUrl(tabIndex)
  const ws = new WebSocket(wsUrl)

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })

  try {
    return await fn(ws, (w, method, params, timeout) =>
      sendCommand(w, method, params, timeout),
    )
  } finally {
    ws.close()
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Navigate to a URL.
 */
export async function navigate(
  url: string,
  tabIndex = 0,
): Promise<{ url: string; title: string }> {
  return withConnection(tabIndex, async (ws) => {
    await sendCommand(ws, 'Page.enable')
    await sendCommand(ws, 'Page.navigate', { url })

    // Wait for load event
    await new Promise<void>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.method === 'Page.loadEventFired') {
            ws.off('message', handler)
            resolve()
          }
        } catch {}
      }
      ws.on('message', handler)
      // Timeout after 30s
      setTimeout(resolve, 30000)
    })

    // Get page title
    const result = await sendCommand(ws, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    })
    const title = result?.result?.value || ''
    return { url, title }
  })
}

/**
 * Take a screenshot (returns base64 PNG).
 */
export async function screenshot(
  tabIndex = 0,
  options: { fullPage?: boolean; quality?: number } = {},
): Promise<{ base64: string; width: number; height: number }> {
  return withConnection(tabIndex, async (ws) => {
    // Get viewport dimensions
    const layoutMetrics = await sendCommand(ws, 'Page.getLayoutMetrics')
    const viewport = layoutMetrics.cssVisualViewport || layoutMetrics.visualViewport

    const captureParams: Record<string, unknown> = {
      format: 'png',
    }

    if (options.fullPage) {
      const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize
      captureParams.clip = {
        x: 0,
        y: 0,
        width: contentSize.width,
        height: contentSize.height,
        scale: 1,
      }
    }

    const result = await sendCommand(ws, 'Page.captureScreenshot', captureParams)
    return {
      base64: result.data,
      width: Math.round(viewport?.clientWidth || 0),
      height: Math.round(viewport?.clientHeight || 0),
    }
  })
}

/**
 * Click an element by CSS selector.
 */
export async function click(
  selector: string,
  tabIndex = 0,
): Promise<{ clicked: boolean; selector: string }> {
  return withConnection(tabIndex, async (ws) => {
    // Find the element and get its center coordinates
    const findResult = await sendCommand(ws, 'Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found: ${selector}' };
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.slice(0, 100) || ''
          };
        })()
      `,
      returnByValue: true,
    })

    const value = findResult?.result?.value
    if (!value || value.error) {
      throw new Error(value?.error || `Element not found: ${selector}`)
    }

    // Dispatch mouse events
    await sendCommand(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: value.x,
      y: value.y,
      button: 'left',
      clickCount: 1,
    })
    await sendCommand(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: value.x,
      y: value.y,
      button: 'left',
      clickCount: 1,
    })

    return { clicked: true, selector }
  })
}

/**
 * Type text into an element (focus + keyboard input).
 */
export async function type(
  selector: string,
  text: string,
  tabIndex = 0,
  options: { clearFirst?: boolean; pressEnter?: boolean } = {},
): Promise<{ typed: boolean; selector: string; text: string }> {
  return withConnection(tabIndex, async (ws) => {
    // Focus the element
    const focusResult = await sendCommand(ws, 'Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found: ${selector}' };
          el.focus();
          ${options.clearFirst ? "el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));" : ''}
          return { focused: true };
        })()
      `,
      returnByValue: true,
    })

    const value = focusResult?.result?.value
    if (!value || value.error) {
      throw new Error(value?.error || `Element not found: ${selector}`)
    }

    // Type each character
    await sendCommand(ws, 'Input.insertText', { text })

    // Optionally press Enter
    if (options.pressEnter) {
      await sendCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      await sendCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
    }

    return { typed: true, selector, text }
  })
}

/**
 * Execute JavaScript in the page context.
 */
export async function evaluate(
  expression: string,
  tabIndex = 0,
): Promise<{ result: unknown; type: string }> {
  return withConnection(tabIndex, async (ws) => {
    const evalResult = await sendCommand(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })

    if (evalResult?.exceptionDetails) {
      const desc =
        evalResult.exceptionDetails.exception?.description ||
        evalResult.exceptionDetails.text ||
        'Unknown error'
      throw new Error(`JS error: ${desc}`)
    }

    return {
      result: evalResult?.result?.value,
      type: evalResult?.result?.type || 'undefined',
    }
  })
}

/**
 * Get page content (HTML or text).
 */
export async function getContent(
  tabIndex = 0,
  format: 'html' | 'text' = 'text',
): Promise<{ content: string; url: string; title: string }> {
  return withConnection(tabIndex, async (ws) => {
    const expr =
      format === 'html'
        ? 'document.documentElement.outerHTML'
        : 'document.body.innerText'

    const result = await sendCommand(ws, 'Runtime.evaluate', {
      expression: `JSON.stringify({ content: ${expr}, url: location.href, title: document.title })`,
      returnByValue: true,
    })

    const value = result?.result?.value
    if (!value) throw new Error('Failed to get page content')
    return typeof value === 'string' ? JSON.parse(value) : value
  })
}

/**
 * Wait for an element to appear on the page.
 */
export async function waitForSelector(
  selector: string,
  tabIndex = 0,
  timeoutMs = 10000,
): Promise<{ found: boolean; selector: string; elapsed: number }> {
  const start = Date.now()
  const interval = 200
  const maxChecks = Math.ceil(timeoutMs / interval)

  for (let i = 0; i < maxChecks; i++) {
    try {
      const tabs = await listTabs()
      if (tabs.length === 0) throw new Error('No open tabs')

      // Quick check via CDP
      const wsUrl = await getDebuggerWsUrl(tabIndex)
      const ws = new WebSocket(wsUrl)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
      })

      try {
        const result = await sendCommand(ws, 'Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(selector)})`,
          returnByValue: true,
        })
        if (result?.result?.value === true) {
          return {
            found: true,
            selector,
            elapsed: Date.now() - start,
          }
        }
      } finally {
        ws.close()
      }
    } catch {
      // Chrome might not be ready yet
    }

    await new Promise((r) => setTimeout(r, interval))
  }

  throw new Error(
    `Element "${selector}" not found after ${timeoutMs}ms`,
  )
}

/**
 * Get the accessibility tree of the page.
 * Returns a compact, structured representation of all interactive and
 * semantically meaningful elements on the page.
 */
export async function getAccessibilityTree(
  tabIndex = 0,
  options: { interactiveOnly?: boolean; maxDepth?: number } = {},
): Promise<{ tree: string; url: string; title: string; nodeCount: number }> {
  return withConnection(tabIndex, async (ws) => {
    // Enable accessibility domain
    await sendCommand(ws, 'Accessibility.enable')

    // Get the full AX tree
    const result = await sendCommand(ws, 'Accessibility.getFullAXTree')
    const nodes: any[] = result?.nodes || []

    // Get page info
    const pageInfo = await sendCommand(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href, title: document.title })',
      returnByValue: true,
    })
    const { url, title } = typeof pageInfo?.result?.value === 'string'
      ? JSON.parse(pageInfo.result.value)
      : { url: '', title: '' }

    // Build node lookup map
    const nodeMap = new Map<string, any>()
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node)
    }

    // Roles to skip (noise / purely structural)
    const skipRoles = new Set([
      'none', 'generic', 'InlineTextBox', 'LineBreak',
    ])

    // Roles that are always interesting (interactive elements)
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox',
      'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
      'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'option', 'treeitem',
    ])

    // Helper to extract AX property value
    function getProp(node: any, propName: string): string {
      if (node.name?.value && propName === 'name') return node.name.value
      if (node.value?.value && propName === 'value') return node.value.value
      if (node.description?.value && propName === 'description') return node.description.value
      const prop = node.properties?.find((p: any) => p.name === propName)
      return prop?.value?.value ?? ''
    }

    // Format a single node compactly
    function formatNode(node: any, depth: number): string | null {
      const role = node.role?.value || ''
      if (skipRoles.has(role)) return null
      if (node.ignored) return null

      const name = getProp(node, 'name')
      const value = getProp(node, 'value')
      const description = getProp(node, 'description')

      // In interactive-only mode, skip non-interactive elements without meaningful content
      if (options.interactiveOnly && !interactiveRoles.has(role) && !name) {
        return null
      }

      // Skip empty structural nodes
      if (!name && !value && !description && !interactiveRoles.has(role)) {
        // Still process if it's a heading or landmark
        const landmarkRoles = new Set(['heading', 'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search', 'form', 'alert', 'dialog', 'alertdialog', 'status', 'img'])
        if (!landmarkRoles.has(role)) return null
      }

      const indent = '  '.repeat(depth)
      let line = `${indent}[${role}]`
      if (name) line += ` "${name}"`
      if (value) line += ` value="${value}"`
      if (description) line += ` desc="${description}"`

      // Add useful properties
      const focused = getProp(node, 'focused')
      const checked = getProp(node, 'checked')
      const disabled = getProp(node, 'disabled')
      const expanded = getProp(node, 'expanded')
      const level = getProp(node, 'level')

      if (focused === 'true') line += ' [focused]'
      if (checked) line += ` [checked=${checked}]`
      if (disabled === 'true') line += ' [disabled]'
      if (expanded) line += ` [expanded=${expanded}]`
      if (level) line += ` [level=${level}]`

      return line
    }

    // Build tree recursively
    const lines: string[] = []
    let nodeCount = 0
    const maxDepth = options.maxDepth ?? 20

    function walk(nodeId: string, depth: number): void {
      if (depth > maxDepth) return
      const node = nodeMap.get(nodeId)
      if (!node) return

      const line = formatNode(node, depth)
      if (line) {
        lines.push(line)
        nodeCount++
      }

      // Process children
      const childIds = node.childIds || []
      for (const childId of childIds) {
        walk(childId, line ? depth + 1 : depth)
      }
    }

    // Start from root
    if (nodes.length > 0) {
      walk(nodes[0].nodeId, 0)
    }

    // Disable accessibility domain
    await sendCommand(ws, 'Accessibility.disable')

    return {
      tree: lines.join('\n'),
      url,
      title,
      nodeCount,
    }
  })
}

