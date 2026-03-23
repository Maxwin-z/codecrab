// SOUL Settings — Server-side persisted settings for SOUL features
//
// Stores settings in ~/.codecrab/soul/settings.json so they survive server restarts.
// This is the source of truth for whether soul evolution is enabled.

import * as fs from 'fs'
import * as path from 'path'
import { getSoulProjectDir } from './project.js'

export interface SoulSettings {
  evolutionEnabled: boolean
}

const DEFAULT_SETTINGS: SoulSettings = {
  evolutionEnabled: true,
}

function settingsPath(): string {
  return path.join(getSoulProjectDir(), 'settings.json')
}

/** Read soul settings from disk, returning defaults if file doesn't exist */
export function loadSoulSettings(): SoulSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Write soul settings to disk */
export function saveSoulSettings(settings: SoulSettings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

/** Check if soul evolution is enabled (server-side source of truth) */
export function isSoulEvolutionEnabled(): boolean {
  return loadSoulSettings().evolutionEnabled
}

/** Set soul evolution enabled/disabled and persist to disk */
export function setSoulEvolutionEnabled(enabled: boolean): void {
  const settings = loadSoulSettings()
  settings.evolutionEnabled = enabled
  saveSoulSettings(settings)
}
