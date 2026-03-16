// SOUL Project — Initializes and manages the __soul__ internal project
//
// Creates ~/.codeclaws/soul/ directory with CLAUDE.md and default SOUL.json,
// and registers it as an internal project in projects.json.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const CODECLAWS_DIR = path.join(os.homedir(), '.codeclaws')
const SOUL_DIR = path.join(CODECLAWS_DIR, 'soul')
const PROJECTS_FILE = path.join(CODECLAWS_DIR, 'projects.json')

export const SOUL_PROJECT_ID = '__soul__'

const CLAUDE_MD = `# SOUL Evolution Agent

You are the SOUL evolution engine. Your job is to maintain and update the user persona file SOUL.json based on conversation evidence provided to you.

## Rules

1. **Conservative updates** — Only modify fields when evidence is strong. It's better to skip an update than to make a wrong one.
2. **Incremental** — Change at most 2-3 fields per evolution. Never do a full rewrite.
3. **Explainable** — Every change must be logged to evolution-log.jsonl with clear reasoning.
4. **Evidence-based** — Only infer from the provided conversation data. Never fabricate user traits.
5. **Respect existing** — If SOUL.json already has a value for a field and the new evidence is weak, keep the existing value.

## Workflow

1. Read the current SOUL.json
2. Analyze the provided conversation(s) for behavioral signals:
   - Communication preferences (verbose vs concise, language, formality)
   - Decision-making style (data-driven vs intuitive, fast vs deliberate)
   - Domain expertise (what topics they know deeply)
   - Work patterns (goals, constraints, risk tolerance)
3. Decide if any fields need updating (most of the time, no update is needed)
4. If updating:
   - Edit SOUL.json with the changes
   - Append a JSON line to evolution-log.jsonl recording the change
5. Output a brief summary of what you did (or why you didn't change anything)

## evolution-log.jsonl Format

Each line is a JSON object:
\`\`\`json
{"timestamp":"2026-03-16T10:00:00Z","changes":[{"path":"preferences.communicationStyle","before":"简洁直接","after":"详细解释"}],"reasoning":"User asked for step-by-step explanations multiple times"}
\`\`\`

## Important

- Keep SOUL.json well-formatted (2-space indent)
- The meta.version field should be incremented on each update
- The meta.lastUpdated field should be set to the current ISO timestamp
- If the conversation is trivial (greetings, simple commands), just say "No update needed" and stop
`

const DEFAULT_SOUL = {
  identity: {
    name: '',
    role: '',
    expertise: [],
  },
  preferences: {
    communicationStyle: '简洁直接',
    decisionStyle: '数据驱动',
    riskTolerance: '适中',
  },
  values: {},
  context: {
    activeGoals: [],
    domain: '',
    constraints: [],
  },
  meta: {
    version: 1,
    lastUpdated: new Date().toISOString(),
    evolutionLog: [],
  },
}

interface ProjectEntry {
  id: string
  name: string
  path: string
  icon: string
  internal?: boolean
}

/**
 * Ensure the SOUL project directory and files exist.
 * Called at server startup or when SOUL features are first used.
 */
export function ensureSoulProject(): void {
  // Create directory structure
  fs.mkdirSync(SOUL_DIR, { recursive: true })
  fs.mkdirSync(path.join(SOUL_DIR, 'insights'), { recursive: true })

  // Write CLAUDE.md (always overwrite to keep rules up to date)
  fs.writeFileSync(path.join(SOUL_DIR, 'CLAUDE.md'), CLAUDE_MD, 'utf-8')

  // Write default SOUL.json only if it doesn't exist
  const soulPath = path.join(SOUL_DIR, 'SOUL.json')
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, JSON.stringify(DEFAULT_SOUL, null, 2), 'utf-8')
  }

  // Ensure evolution-log.jsonl exists
  const logPath = path.join(SOUL_DIR, 'evolution-log.jsonl')
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf-8')
  }

  // Register in projects.json
  registerSoulProject()
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
  } else {
    projects.push({
      id: SOUL_PROJECT_ID,
      name: 'SOUL',
      path: SOUL_DIR,
      icon: '🧠',
      internal: true,
    })
  }

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}

/** Get the SOUL project directory path */
export function getSoulProjectDir(): string {
  return SOUL_DIR
}
