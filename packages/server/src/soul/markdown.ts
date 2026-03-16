// SOUL Markdown parser — Parse and serialize SOUL.md with YAML frontmatter

import type { SoulDocument, SoulMeta } from './types.js'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

/**
 * Parse a SOUL.md file string into a SoulDocument.
 * Extracts YAML frontmatter for metadata and the rest as Markdown content.
 */
export function parseSoulMarkdown(raw: string): SoulDocument {
  const match = raw.match(FRONTMATTER_RE)

  if (!match) {
    // No frontmatter — treat entire content as body
    return {
      content: raw.trim(),
      meta: { version: 1, lastUpdated: new Date().toISOString() },
    }
  }

  const frontmatter = match[1]
  const content = match[2].trim()

  const meta: SoulMeta = {
    version: 1,
    lastUpdated: new Date().toISOString(),
  }

  // Simple YAML key: value parser (no dependency needed for our simple format)
  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (!kv) continue
    const [, key, value] = kv
    if (key === 'version') meta.version = parseInt(value, 10) || 1
    if (key === 'lastUpdated') meta.lastUpdated = value.trim()
  }

  return { content, meta }
}

/**
 * Serialize a SoulDocument back to SOUL.md format with YAML frontmatter.
 */
export function serializeSoulMarkdown(doc: SoulDocument): string {
  const lines = [
    '---',
    `version: ${doc.meta.version}`,
    `lastUpdated: ${doc.meta.lastUpdated}`,
    '---',
    '',
    doc.content,
    '',  // trailing newline
  ]
  return lines.join('\n')
}

/**
 * Extract a brief summary from the SOUL markdown content.
 * Returns the first non-empty, non-heading line (for dashboard cards).
 */
export function extractSoulSummary(content: string, maxLength = 120): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    // Strip markdown bold/italic markers for a clean summary
    const clean = trimmed.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^-\s*/, '')
    if (clean.length > 0) {
      return clean.length > maxLength ? clean.slice(0, maxLength) + '…' : clean
    }
  }
  return ''
}
