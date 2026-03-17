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
  const existing = devices.find((d) => d.token === token)
  if (existing) {
    if (label) existing.label = label
    writeDevices(devices)
    return existing
  }
  const device: PushDevice = {
    token,
    label,
    registeredAt: new Date().toISOString(),
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
