// Chrome MCP — Browser automation via DevTools Protocol
//
// Components:
//   chrome.ts  — Chrome process lifecycle (lazy start/stop)
//   routes.ts  — REST endpoints (/api/chrome/*)
//
// Features:
//   - Lazy startup: Chrome only starts when needed
//   - Remote debugging port (9222)
//   - Persistent profile (~/.codeclaws/chrome-profile/)
//   - macOS + Linux platform detection
//   - Integrates with engine's built-in DevTools MCP

export { ensureChromeRunning, getChromeDebugUrl, stopChrome } from './chrome.js'
export { default as chromeRouter } from './routes.js'
