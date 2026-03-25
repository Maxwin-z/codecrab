import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SOUL_DIR = join(homedir(), '.codecrab', 'soul')
const SETTINGS_FILE = join(SOUL_DIR, 'settings.json')

interface SoulSettings {
  enabled: boolean
}

let cachedSettings: SoulSettings | null = null

function loadSettings(): SoulSettings {
  if (cachedSettings) return cachedSettings
  try {
    const data = readFileSync(SETTINGS_FILE, 'utf-8')
    cachedSettings = JSON.parse(data)
    return cachedSettings!
  } catch {
    return { enabled: false }
  }
}

export function isSoulEnabled(): boolean {
  return loadSettings().enabled
}

export function setSoulEnabled(enabled: boolean): void {
  const settings = loadSettings()
  settings.enabled = enabled
  cachedSettings = settings
  try {
    mkdirSync(SOUL_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  } catch {
    // Ignore write errors
  }
}
