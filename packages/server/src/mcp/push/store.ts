// Push device token storage — JSON file persistence
//
// Stores APNs device tokens in ~/.codecrab/push-devices.json

import fs from 'fs'
import path from 'path'
import os from 'os'

export interface PushDevice {
  token: string
  label?: string
  registeredAt: string
  lastActiveAt: string
}

const CONFIG_DIR = path.join(os.homedir(), '.codecrab')
const DEVICES_FILE = path.join(CONFIG_DIR, 'push-devices.json')

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function readDevices(): PushDevice[] {
  try {
    if (!fs.existsSync(DEVICES_FILE)) return []
    const data = fs.readFileSync(DEVICES_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

function writeDevices(devices: PushDevice[]): void {
  ensureDir()
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2))
}

export function registerDevice(token: string, label?: string): PushDevice {
  const devices = readDevices()
  const now = new Date().toISOString()
  const existing = devices.find((d) => d.token === token)
  if (existing) {
    if (label) existing.label = label
    existing.lastActiveAt = now
    writeDevices(devices)
    return existing
  }
  const device: PushDevice = {
    token,
    label,
    registeredAt: now,
    lastActiveAt: now,
  }
  devices.push(device)
  writeDevices(devices)
  return device
}

export function unregisterDevice(token: string): boolean {
  const devices = readDevices()
  const idx = devices.findIndex((d) => d.token === token)
  if (idx === -1) return false
  devices.splice(idx, 1)
  writeDevices(devices)
  return true
}

export function getDevices(): PushDevice[] {
  return readDevices()
}

export function getDeviceTokens(): string[] {
  return readDevices().map((d) => d.token)
}

/** Get the most recently active device token (for push targeting) */
export function getLastActiveDeviceToken(): string | null {
  const devices = readDevices()
  if (devices.length === 0) return null
  const sorted = [...devices].sort((a, b) => {
    const aTime = a.lastActiveAt || a.registeredAt
    const bTime = b.lastActiveAt || b.registeredAt
    return bTime.localeCompare(aTime)
  })
  return sorted[0].token
}
