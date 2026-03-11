// Chrome MCP — Browser automation via DevTools Protocol
//
// Components:
//   chrome.ts  — Chrome process lifecycle (lazy start/stop)
//   cdp.ts     — Lightweight CDP WebSocket client
//   tools.ts   — MCP tool definitions for Claude Agent SDK
//   routes.ts  — REST endpoints (/api/chrome/*)
//
// Features:
//   - Lazy startup: Chrome only starts when needed
//   - Remote debugging port (9222)
//   - Persistent profile (~/.codeclaws/chrome-profile/)
//   - macOS + Linux platform detection
//   - 10 browser automation tools via CDP

export { ensureChromeRunning, getChromeDebugUrl, stopChrome } from './chrome.js'
export { default as chromeRouter } from './routes.js'
export { chromeTools } from './tools.js'
