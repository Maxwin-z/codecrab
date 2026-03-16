// SOUL Markdown parser tests

import { describe, it, expect } from 'vitest'
import { parseSoulMarkdown, serializeSoulMarkdown, extractSoulSummary } from '../markdown.js'

describe('parseSoulMarkdown', () => {
  it('should parse frontmatter and content', () => {
    const raw = `---
version: 5
lastUpdated: 2026-03-16T10:00:00Z
---

# Identity

- **Name:** Max
- **Role:** Founder`

    const doc = parseSoulMarkdown(raw)
    expect(doc.meta.version).toBe(5)
    expect(doc.meta.lastUpdated).toBe('2026-03-16T10:00:00Z')
    expect(doc.content).toContain('# Identity')
    expect(doc.content).toContain('Max')
  })

  it('should handle missing frontmatter', () => {
    const raw = '# Identity\n\nJust some text'
    const doc = parseSoulMarkdown(raw)
    expect(doc.meta.version).toBe(1)
    expect(doc.content).toBe('# Identity\n\nJust some text')
  })

  it('should handle empty content', () => {
    const raw = `---
version: 1
lastUpdated: 2026-01-01T00:00:00Z
---
`
    const doc = parseSoulMarkdown(raw)
    expect(doc.meta.version).toBe(1)
    expect(doc.content).toBe('')
  })
})

describe('serializeSoulMarkdown', () => {
  it('should produce valid frontmatter + content', () => {
    const doc = {
      content: '# Identity\n\n- **Name:** Max',
      meta: { version: 3, lastUpdated: '2026-03-16T10:00:00Z' },
    }
    const result = serializeSoulMarkdown(doc)
    expect(result).toContain('---')
    expect(result).toContain('version: 3')
    expect(result).toContain('lastUpdated: 2026-03-16T10:00:00Z')
    expect(result).toContain('# Identity')
    expect(result).toContain('**Name:** Max')
  })

  it('should roundtrip correctly', () => {
    const original = `---
version: 7
lastUpdated: 2026-03-16T12:00:00Z
---

# Identity

- **Name:** Test

# Observations

Some behavioral notes here.`

    const doc = parseSoulMarkdown(original)
    const serialized = serializeSoulMarkdown(doc)
    const reparsed = parseSoulMarkdown(serialized)

    expect(reparsed.meta.version).toBe(7)
    expect(reparsed.content).toContain('# Identity')
    expect(reparsed.content).toContain('Some behavioral notes here.')
  })
})

describe('extractSoulSummary', () => {
  it('should return first non-heading, non-empty line', () => {
    const content = `# Identity

- **Name:** Max
- **Role:** Founder`

    expect(extractSoulSummary(content)).toBe('Name: Max')
  })

  it('should truncate long lines', () => {
    const long = 'A'.repeat(200)
    expect(extractSoulSummary(long, 50)).toBe('A'.repeat(50) + '…')
  })

  it('should return empty string for heading-only content', () => {
    expect(extractSoulSummary('# Identity\n\n# Preferences\n')).toBe('')
  })
})
