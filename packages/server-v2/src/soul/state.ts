import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SOUL_DIR = join(homedir(), '.codecrab', 'soul')
const STATE_FILE = join(SOUL_DIR, 'state.json')

export interface SoulSessionState {
  /** Number of messages already processed by soul evolution */
  lastEvolvedMessageCount: number
}

export interface SoulState {
  sessions: Record<string, SoulSessionState>
}

export async function loadSoulState(): Promise<SoulState> {
  try {
    const data = await readFile(STATE_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { sessions: {} }
  }
}

export async function saveSoulState(state: SoulState): Promise<void> {
  await mkdir(SOUL_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}
