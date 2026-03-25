const SERVER_URL_KEY = 'codecrab_server_url'

function getBasePath(): string {
  const base = import.meta.env.BASE_URL
  return base === '/' ? '' : base.replace(/\/$/, '')
}

export function getServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY)
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url)
}

export function clearServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY)
}

export function buildApiUrl(path: string): string {
  const serverUrl = getServerUrl()
  if (serverUrl) return `${serverUrl}${path}`
  return `${getBasePath()}${path}`
}

export function buildWsUrl(path: string): string {
  const serverUrl = getServerUrl()
  if (serverUrl) {
    const wsUrl = serverUrl.replace(/^http/, 'ws')
    return `${wsUrl}${path}`
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${getBasePath()}${path}`
}

export function getServerDisplay(): { address: string; isCustom: boolean } {
  const url = getServerUrl()
  if (url) return { address: url, isCustom: true }
  // No custom URL — using Vite proxy, show the proxy target
  return { address: `${window.location.hostname}:4200 (via proxy)`, isCustom: false }
}
