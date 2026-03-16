// SOUL Project — Initializes and manages the __soul__ internal project
//
// Creates ~/.codeclaws/soul/ directory with CLAUDE.md and default SOUL.md,
// and registers it as an internal project in projects.json.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SOUL_MAX_LENGTH } from './types.js'

const CODECLAWS_DIR = path.join(os.homedir(), '.codeclaws')
const SOUL_DIR = path.join(CODECLAWS_DIR, 'soul')
const PROJECTS_FILE = path.join(CODECLAWS_DIR, 'projects.json')

export const SOUL_PROJECT_ID = '__soul__'

const CLAUDE_MD = `# SOUL Evolution Agent

You are the SOUL evolution engine. Your job is to maintain and update the user persona file \`SOUL.md\` based on conversation evidence provided to you.

## Rules

1. **Conservative updates** — Only modify sections when evidence is strong. It's better to skip an update than to make a wrong one.
2. **Incremental** — Change at most 2-3 sections per evolution. Never do a full rewrite.
3. **Explainable** — Every change must be logged to \`evolution-log.jsonl\` with a clear summary.
4. **Evidence-based** — Only infer from the provided conversation data. Never fabricate user traits.
5. **Respect existing** — If SOUL.md already has content for a topic and the new evidence is weak, keep the existing content.
6. **Length limit** — The Markdown body (everything after the \`---\` frontmatter) must stay under ${SOUL_MAX_LENGTH} characters. If approaching the limit, condense less important observations rather than deleting sections.

## SOUL.md Format

The file uses YAML frontmatter for metadata, followed by free-form Markdown:

\`\`\`markdown
---
version: 1
lastUpdated: 2026-03-16T00:00:00Z
---

# Identity

(Name, role, expertise — who the user is)

# Preferences

(Communication style, decision-making approach, risk tolerance, etc.)

# Values

(What they care about, principles they follow)

# Context

(Domain, active goals, constraints)

# Observations

(Behavioral patterns, notable habits, recurring themes)
\`\`\`

The sections above are a starting template. You may:
- Add new sections (e.g., "# Technical Stack", "# Communication Patterns")
- Merge or rename sections if it makes the profile clearer
- Use sub-headings, lists, or prose — whatever captures the insight best
- Remove a section if it has become irrelevant

## Workflow

1. Read the current \`SOUL.md\`
2. Analyze the provided conversation(s) for behavioral signals
3. Decide if any sections need updating (most of the time, no update is needed)
4. If updating:
   - Edit \`SOUL.md\` — update the frontmatter \`version\` (increment by 1) and \`lastUpdated\`
   - Append a JSON line to \`evolution-log.jsonl\` recording the change
5. Output a brief summary of what you did (or why you didn't change anything)

## evolution-log.jsonl Format

Each line is a JSON object:
\`\`\`json
{"timestamp":"2026-03-16T10:00:00Z","summary":"Updated Identity section — user revealed they are a startup founder focused on AI products"}
\`\`\`

## Important

- Keep SOUL.md well-formatted and readable
- The frontmatter \`version\` field must be incremented on each update
- The frontmatter \`lastUpdated\` field must be set to the current ISO timestamp
- If the conversation is trivial (greetings, simple commands), just say "No update needed" and stop
- Stay within the ${SOUL_MAX_LENGTH}-character body limit — be concise and prioritize signal over noise
`

const DEFAULT_SOUL_MD = `---
version: 1
lastUpdated: ${new Date().toISOString()}
---

# Identity

# Preferences

# Values

# Context

# Observations
`

interface ProjectEntry {
  id: string
  name: string
  path: string
  icon: string
  internal?: boolean
  createdAt?: number
  updatedAt?: number
}

/**
 * Ensure the SOUL project directory and files exist.
 * Called at server startup or when SOUL features are first used.
 * Automatically migrates SOUL.json → SOUL.md if the old format is found.
 */
export function ensureSoulProject(): void {
  // Create directory structure
  fs.mkdirSync(SOUL_DIR, { recursive: true })
  fs.mkdirSync(path.join(SOUL_DIR, 'insights'), { recursive: true })

  // Write CLAUDE.md (always overwrite to keep rules up to date)
  fs.writeFileSync(path.join(SOUL_DIR, 'CLAUDE.md'), CLAUDE_MD, 'utf-8')

  // Migrate from SOUL.json if it exists and SOUL.md doesn't
  const oldJsonPath = path.join(SOUL_DIR, 'SOUL.json')
  const soulMdPath = path.join(SOUL_DIR, 'SOUL.md')

  if (fs.existsSync(oldJsonPath) && !fs.existsSync(soulMdPath)) {
    migrateJsonToMarkdown(oldJsonPath, soulMdPath)
  }

  // Write default SOUL.md only if it doesn't exist
  if (!fs.existsSync(soulMdPath)) {
    fs.writeFileSync(soulMdPath, DEFAULT_SOUL_MD, 'utf-8')
  }

  // Ensure evolution-log.jsonl exists
  const logPath = path.join(SOUL_DIR, 'evolution-log.jsonl')
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf-8')
  }

  // Register in projects.json
  registerSoulProject()
}

/**
 * Migrate old SOUL.json to SOUL.md format.
 * Converts structured JSON fields into Markdown sections.
 */
function migrateJsonToMarkdown(jsonPath: string, mdPath: string): void {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8')
    const old = JSON.parse(raw)

    const lines: string[] = []
    lines.push('---')
    lines.push(`version: ${(old.meta?.version || 1) + 1}`)
    lines.push(`lastUpdated: ${new Date().toISOString()}`)
    lines.push('---')
    lines.push('')

    // Identity
    lines.push('# Identity')
    lines.push('')
    if (old.identity?.name) lines.push(`- **Name:** ${old.identity.name}`)
    if (old.identity?.role) lines.push(`- **Role:** ${old.identity.role}`)
    if (old.identity?.expertise?.length > 0) {
      lines.push(`- **Expertise:** ${old.identity.expertise.join(', ')}`)
    }
    lines.push('')

    // Preferences
    lines.push('# Preferences')
    lines.push('')
    if (old.preferences?.communicationStyle) lines.push(`- **Communication Style:** ${old.preferences.communicationStyle}`)
    if (old.preferences?.decisionStyle) lines.push(`- **Decision Style:** ${old.preferences.decisionStyle}`)
    if (old.preferences?.riskTolerance) lines.push(`- **Risk Tolerance:** ${old.preferences.riskTolerance}`)
    lines.push('')

    // Values
    lines.push('# Values')
    lines.push('')
    if (old.values && Object.keys(old.values).length > 0) {
      for (const [key, value] of Object.entries(old.values)) {
        lines.push(`- **${key}:** ${value}`)
      }
    }
    lines.push('')

    // Context
    lines.push('# Context')
    lines.push('')
    if (old.context?.domain) lines.push(`- **Domain:** ${old.context.domain}`)
    if (old.context?.activeGoals?.length > 0) {
      lines.push('- **Active Goals:**')
      for (const goal of old.context.activeGoals) {
        lines.push(`  - ${goal}`)
      }
    }
    if (old.context?.constraints?.length > 0) {
      lines.push('- **Constraints:**')
      for (const c of old.context.constraints) {
        lines.push(`  - ${c}`)
      }
    }
    lines.push('')

    // Observations (empty for migrated files)
    lines.push('# Observations')
    lines.push('')

    fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8')

    // Rename old file so it's not migrated again
    fs.renameSync(jsonPath, jsonPath + '.bak')
  } catch (err) {
    console.error('[SOUL] Migration from JSON to Markdown failed:', err)
    // Don't block — default SOUL.md will be created
  }
}

function registerSoulProject(): void {
  let projects: ProjectEntry[] = []
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf-8')
    projects = JSON.parse(data)
  } catch {
    // File doesn't exist or is malformed
  }

  const existing = projects.find((p) => p.id === SOUL_PROJECT_ID)
  if (existing) {
    // Update path in case it changed
    existing.path = SOUL_DIR
    existing.internal = true
    // Backfill timestamps if missing
    if (!existing.createdAt) {
      const now = Date.now()
      existing.createdAt = now
      existing.updatedAt = now
    }
  } else {
    const now = Date.now()
    projects.push({
      id: SOUL_PROJECT_ID,
      name: 'SOUL',
      path: SOUL_DIR,
      icon: '🧠',
      internal: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}

/** Get the SOUL project directory path */
export function getSoulProjectDir(): string {
  return SOUL_DIR
}
