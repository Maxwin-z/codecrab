import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Strip [SUMMARY: ...] and [SUGGESTIONS: ...] meta tags from message content. */
export function stripMetaTags(text: string): string {
  if (!text) return text
  return text
    .replace(/\n?\[SUGGESTIONS:\s*.+?\]\s*$/g, '')
    .replace(/\n?\[SUMMARY:\s*.+?\]\s*$/g, '')
    .trimEnd()
}
