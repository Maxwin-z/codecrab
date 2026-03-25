import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Strip [SUMMARY:...] and [SUGGESTIONS:...] meta tags from text */
export function stripMetaTags(text: string): string {
  return text
    .replace(/\[SUMMARY:\s*[\s\S]*?\]/g, '')
    .replace(/\[SUGGESTIONS:\s*[\s\S]*?\]/g, '')
    .trim()
}

/** Format duration in ms to human readable */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.floor(s % 60)
  return `${m}m ${rem}s`
}

/** Format cost in USD */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
