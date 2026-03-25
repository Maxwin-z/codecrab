import { buildApiUrl, buildWsUrl } from './server'

const TOKEN_KEY = 'codecrab_token'
const DEFAULT_TIMEOUT = 10000

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function hasToken(): boolean {
  return !!getToken()
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
    const res = await fetch(buildApiUrl('/api/auth/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return res.ok
  } catch {
    return false
  }
}

export async function checkAuthStatus(): Promise<{ hasToken: boolean }> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
    const res = await fetch(buildApiUrl('/api/auth/status'), {
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return await res.json()
  } catch {
    return { hasToken: false }
  }
}

export async function authFetch(
  input: string,
  init?: RequestInit,
  onUnauthorized?: () => void,
): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
  const resolvedInput = input.startsWith('/') ? buildApiUrl(input) : input

  try {
    const res = await fetch(resolvedInput, { ...init, headers, signal: controller.signal })
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

export function getWebSocketUrl(path: string): string {
  const token = getToken()
  const url = new URL(buildWsUrl(path))
  if (token) url.searchParams.set('token', token)
  return url.toString()
}
