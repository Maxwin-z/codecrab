// Channel config persistence (~/.codecrab/channels/)

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ChannelConfig, ConversationState } from './types.js'

const CHANNELS_DIR = path.join(os.homedir(), '.codecrab', 'channels')
const CONFIG_FILE = path.join(CHANNELS_DIR, 'config.json')

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ============ Channel Configs ============

export function loadConfigs(): ChannelConfig[] {
  ensureDir(CHANNELS_DIR)
  try {
    if (!fs.existsSync(CONFIG_FILE)) return []
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    console.error('[ChannelStore] Failed to load configs:', err)
    return []
  }
}

export function saveConfigs(configs: ChannelConfig[]): void {
  ensureDir(CHANNELS_DIR)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2))
}

export function getConfig(instanceId: string): ChannelConfig | undefined {
  return loadConfigs().find(c => c.instanceId === instanceId)
}

export function saveConfig(config: ChannelConfig): void {
  const configs = loadConfigs()
  const idx = configs.findIndex(c => c.instanceId === config.instanceId)
  if (idx >= 0) {
    configs[idx] = config
  } else {
    configs.push(config)
  }
  saveConfigs(configs)
}

export function deleteConfig(instanceId: string): boolean {
  const configs = loadConfigs()
  const idx = configs.findIndex(c => c.instanceId === instanceId)
  if (idx < 0) return false
  configs.splice(idx, 1)
  saveConfigs(configs)
  // Clean up instance directory
  const instanceDir = path.join(CHANNELS_DIR, instanceId)
  if (fs.existsSync(instanceDir)) {
    fs.rmSync(instanceDir, { recursive: true, force: true })
  }
  return true
}

export function generateInstanceId(channelId: string): string {
  return `${channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ============ Conversation State ============

function conversationsFile(instanceId: string): string {
  return path.join(CHANNELS_DIR, instanceId, 'conversations.json')
}

export function loadConversations(instanceId: string): Map<string, ConversationState> {
  const file = conversationsFile(instanceId)
  ensureDir(path.dirname(file))
  try {
    if (!fs.existsSync(file)) return new Map()
    const data = fs.readFileSync(file, 'utf-8')
    const entries: Record<string, ConversationState> = JSON.parse(data)
    return new Map(Object.entries(entries))
  } catch {
    return new Map()
  }
}

export function saveConversations(instanceId: string, conversations: Map<string, ConversationState>): void {
  const file = conversationsFile(instanceId)
  ensureDir(path.dirname(file))
  const obj = Object.fromEntries(conversations)
  fs.writeFileSync(file, JSON.stringify(obj, null, 2))
}

// ============ Plugin State ============

function stateFile(instanceId: string): string {
  return path.join(CHANNELS_DIR, instanceId, 'state.json')
}

export function loadPluginState(instanceId: string): Record<string, unknown> {
  const file = stateFile(instanceId)
  ensureDir(path.dirname(file))
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

export function savePluginState(instanceId: string, state: Record<string, unknown>): void {
  const file = stateFile(instanceId)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}
