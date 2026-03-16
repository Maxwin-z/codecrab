// SOUL types — Markdown-based persona model with evolution tracking
//
// The SOUL is stored as a Markdown file with YAML frontmatter for metadata.
// The content is free-form — the evolution agent can grow and restructure it.

/** Maximum character length for SOUL.md content (excluding frontmatter) */
export const SOUL_MAX_LENGTH = 4000

/** Parsed representation of a SOUL.md file */
export interface SoulDocument {
  content: string                // Markdown body (everything after frontmatter)
  meta: SoulMeta
}

export interface SoulMeta {
  version: number
  lastUpdated: string            // ISO 8601 timestamp
}

/** Evolution log entry — still structured (stored in evolution-log.jsonl) */
export interface EvolutionEntry {
  timestamp: string
  summary: string                // What changed and why
}
