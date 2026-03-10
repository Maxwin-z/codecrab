// Auth utility for managing tokens and API requests

const TOKEN_KEY = 'codeclaws_token'
const DEFAULT_TIMEOUT = 10000 // 10 seconds

/** Get the stored token from localStorage */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

/** Store token in localStorage */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

/** Remove token from localStorage */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Check if we have a token stored */
export function hasToken(): boolean {
  return !!getToken()
}

/** Verify token with the server */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)

    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return res.ok
  } catch {
    return false
  }
}

/** Check auth status with the server */
export async function checkAuthStatus(): Promise<{ configured: boolean; valid: boolean }> {
  try {
    const token = getToken()
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)

    const res = await fetch('/api/auth/status', {
      headers,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    const data = await res.json()
    return {
      configured: data.configured ?? false,
      valid: data.valid ?? false,
    }
  } catch {
    return { configured: false, valid: false }
  }
}

/** Fetch with automatic token injection and 401 handling */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit,
  onUnauthorized?: () => void
): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init?.headers)

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)

  try {
    const res = await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (res.status === 401) {
      clearToken()
      onUnauthorized?.()
    }

    return res
  } catch (err) {
    clearTimeout(timeoutId)
    throw err
  }
}

/** Build WebSocket URL with token */
export function getWebSocketUrl(path: string): string {
  const token = getToken()
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const url = new URL(`${protocol}//${host}${path}`)
  if (token) {
    url.searchParams.set('token', token)
  }
  return url.toString()
}
