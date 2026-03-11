// Chrome MCP tool definitions for the Claude Agent SDK.
// Each tool wraps a CDP operation from ./cdp.ts.

import { z } from 'zod/v4'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { ensureChromeRunning, stopChrome, getChromeDebugUrl } from './chrome.js'
import * as cdp from './cdp.js'

/** All Chrome MCP tools to register with createSdkMcpServer */
export const chromeTools = [
  // ── Lifecycle ──────────────────────────────────────────

  tool(
    'start_chrome',
    'Start a Chrome browser instance with remote debugging enabled. Must be called before any browser operation.',
    {},
    async () => {
      try {
        await ensureChromeRunning()
        return {
          content: [
            { type: 'text' as const, text: `Chrome started. Debug URL: ${getChromeDebugUrl()}` },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed to start Chrome: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  tool(
    'stop_chrome',
    'Stop the Chrome browser instance.',
    {},
    async () => {
      await stopChrome()
      return { content: [{ type: 'text' as const, text: 'Chrome stopped.' }] }
    },
  ),

  // ── Navigation ─────────────────────────────────────────

  tool(
    'chrome_navigate',
    'Navigate to a URL in the browser. Chrome must be running (call start_chrome first). Waits for the page to fully load before returning.',
    {
      url: z.string().describe('The URL to navigate to'),
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
    },
    async ({ url, tab_index }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.navigate(url, tab_index ?? 0)
        return {
          content: [
            { type: 'text' as const, text: `Navigated to: ${result.url}\nTitle: ${result.title}` },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Navigation failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Screenshot ─────────────────────────────────────────

  tool(
    'chrome_screenshot',
    'Take a screenshot of the current page. Returns a base64-encoded PNG image. Useful for visual verification.',
    {
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
      full_page: z.boolean().optional().describe('Capture full scrollable page (default false, captures viewport only)'),
    },
    async ({ tab_index, full_page }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.screenshot(tab_index ?? 0, { fullPage: full_page })
        return {
          content: [
            {
              type: 'image' as const,
              data: result.base64,
              mimeType: 'image/png' as const,
            },
            {
              type: 'text' as const,
              text: `Screenshot taken (${result.width}×${result.height})`,
            },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Screenshot failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Click ──────────────────────────────────────────────

  tool(
    'chrome_click',
    'Click an element on the page by CSS selector. Simulates a real mouse click (mousedown + mouseup).',
    {
      selector: z.string().describe('CSS selector of the element to click (e.g. "#submit-btn", ".nav-link", "a[href=\'/login\']")'),
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
    },
    async ({ selector, tab_index }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.click(selector, tab_index ?? 0)
        return {
          content: [
            { type: 'text' as const, text: `Clicked: ${result.selector}` },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Click failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Type ───────────────────────────────────────────────

  tool(
    'chrome_type',
    'Type text into an input element identified by CSS selector. Focuses the element and simulates keyboard input.',
    {
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type into the element'),
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
      clear_first: z.boolean().optional().describe('Clear existing value before typing (default false)'),
      press_enter: z.boolean().optional().describe('Press Enter after typing (default false)'),
    },
    async ({ selector, text, tab_index, clear_first, press_enter }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.type(selector, text, tab_index ?? 0, {
          clearFirst: clear_first,
          pressEnter: press_enter,
        })
        return {
          content: [
            { type: 'text' as const, text: `Typed "${result.text}" into ${result.selector}` },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Type failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Evaluate JS ────────────────────────────────────────

  tool(
    'chrome_evaluate',
    'Execute JavaScript code in the browser page context. Can access the DOM, window, and any page-level APIs. Supports async/await (promises are awaited automatically). Returns the result value.',
    {
      expression: z.string().describe('JavaScript expression or code to evaluate in the page'),
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
    },
    async ({ expression, tab_index }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.evaluate(expression, tab_index ?? 0)
        const text =
          result.type === 'undefined'
            ? '(undefined)'
            : JSON.stringify(result.result, null, 2)
        return {
          content: [{ type: 'text' as const, text }],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Evaluate failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Get Content ────────────────────────────────────────

  tool(
    'chrome_get_content',
    'Get the text content or HTML of the current page. Useful for reading page data, scraping, or verifying content.',
    {
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
      format: z.enum(['text', 'html']).optional().describe('Content format: "text" (default) for readable text, "html" for full HTML'),
    },
    async ({ tab_index, format }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.getContent(tab_index ?? 0, format ?? 'text')
        // Truncate to avoid overwhelming context
        const maxLen = 50000
        const content =
          result.content.length > maxLen
            ? result.content.slice(0, maxLen) + `\n\n... (truncated, ${result.content.length} total chars)`
            : result.content
        return {
          content: [
            {
              type: 'text' as const,
              text: `URL: ${result.url}\nTitle: ${result.title}\n\n${content}`,
            },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Get content failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── List Tabs ──────────────────────────────────────────

  tool(
    'chrome_list_tabs',
    'List all open browser tabs with their titles and URLs.',
    {},
    async () => {
      try {
        await ensureChromeRunning()
        const tabs = await cdp.listTabs()
        if (tabs.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No open tabs.' }],
          }
        }
        const text = tabs
          .map((t, i) => `[${i}] ${t.title}\n    ${t.url}`)
          .join('\n')
        return {
          content: [{ type: 'text' as const, text: `Open tabs:\n${text}` }],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `List tabs failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),

  // ── Wait For Selector ──────────────────────────────────

  tool(
    'chrome_wait_for',
    'Wait for an element matching a CSS selector to appear on the page. Useful after navigation or dynamic content loading.',
    {
      selector: z.string().describe('CSS selector to wait for'),
      tab_index: z.number().optional().describe('Tab index (0-based, default 0)'),
      timeout_ms: z.number().optional().describe('Maximum wait time in ms (default 10000)'),
    },
    async ({ selector, tab_index, timeout_ms }) => {
      try {
        await ensureChromeRunning()
        const result = await cdp.waitForSelector(
          selector,
          tab_index ?? 0,
          timeout_ms ?? 10000,
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Element "${result.selector}" found after ${result.elapsed}ms`,
            },
          ],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Wait failed: ${err.message}` }],
          isError: true,
        }
      }
    },
  ),
]
