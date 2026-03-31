import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

let currentTheme: Theme = (() => {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (stored === 'light' || stored === 'dark') return stored
  // Respect system preference, default to dark
  if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
})()

// Apply immediately to avoid flash
applyTheme(currentTheme)

const listeners = new Set<() => void>()

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function getSnapshot() {
  return currentTheme
}

function setTheme(theme: Theme) {
  currentTheme = theme
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
  listeners.forEach((l) => l())
}

function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark')
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot)
  return { theme, setTheme, toggleTheme } as const
}
