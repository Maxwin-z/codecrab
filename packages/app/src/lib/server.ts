// Server address management — stores custom server URL in localStorage

const SERVER_URL_KEY = 'codecrab_server_url'

/** Get the base path from Vite's base config (e.g. '/codecrab' or '') */
function getBasePath(): string {
  const base = import.meta.env.BASE_URL
  return base === '/' ? '' : base.replace(/\/$/, '')
}

/** Get the stored custom server URL (e.g. "http://192.168.1.50:4200") or null for same-origin */
export function getServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY)
}

/** Store a custom server URL */
export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url)
}

/** Clear the custom server URL (revert to same-origin) */
export function clearServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY)
}

/**
 * Get the base URL to prepend to API paths.
 * Returns empty string for same-origin (default behavior), or the custom server URL.
 */
export function getApiBaseUrl(): string {
  return getServerUrl() || ''
}

/**
 * Build a full API URL from a path like "/api/foo".
 * If a custom server is configured, prepends the server URL.
 */
export function buildApiUrl(path: string): string {
  const serverUrl = getServerUrl()
  if (serverUrl) {
    return `${serverUrl}${path}`
  }
  return `${getBasePath()}${path}`
}

/**
 * Build a WebSocket URL for the given path.
 * Uses the custom server address if configured, otherwise same-origin.
 */
export function buildWsUrl(path: string): string {
  const serverUrl = getServerUrl()
  if (serverUrl) {
    // Convert http(s) to ws(s)
    const wsUrl = serverUrl.replace(/^http/, 'ws')
    return `${wsUrl}${path}`
  }
  // Same-origin — include base path so reverse proxy can route correctly
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${getBasePath()}${path}`
}

/**
 * Get a display string for the current server connection.
 */
export function getServerDisplay(): { address: string; isCustom: boolean } {
  const url = getServerUrl()
  if (url) {
    return { address: url, isCustom: true }
  }
  return { address: window.location.origin, isCustom: false }
}
