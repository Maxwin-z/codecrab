// LAN scanner — discovers CodeCrab servers on the local network
// Only supports scanning when accessed via an IP address (x.x.x.[1-255])

export interface DiscoveredServer {
  ip: string
  port: number
  url: string
  version: string
}

export interface ScanProgress {
  completed: number
  total: number
  servers: DiscoveredServer[]
}

function getSubnet(ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

async function probe(url: string, signal?: AbortSignal): Promise<DiscoveredServer | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 1500)

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const res = await fetch(`${url}/api/discovery`, {
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) return null
    const data = await res.json()
    if (data.service?.toLowerCase() !== 'codecrab') return null

    const parsed = new URL(url)
    return {
      ip: parsed.hostname,
      port: parseInt(parsed.port) || 4200,
      url,
      version: data.version || 'unknown',
    }
  } catch {
    return null
  }
}

/**
 * Check if current hostname supports LAN scanning.
 * Only IP addresses are scannable; localhost and domain names are not.
 */
export function canScan(): boolean {
  const hostname = window.location.hostname
  return isIpAddress(hostname) && hostname !== '127.0.0.1'
}

/**
 * Scan the local subnet for CodeCrab servers.
 * Derives the subnet from the browser's current IP address.
 */
export function scanLAN(
  port: number,
  onProgress: (progress: ScanProgress) => void,
  signal?: AbortSignal
): Promise<DiscoveredServer[]> {
  return new Promise(async (resolve) => {
    const hostname = window.location.hostname
    const servers: DiscoveredServer[] = []
    let completed = 0

    if (!isIpAddress(hostname) || hostname === '127.0.0.1') {
      resolve([])
      return
    }

    const subnet = getSubnet(hostname)
    if (!subnet) {
      resolve([])
      return
    }

    const targets: string[] = []
    for (let i = 1; i <= 255; i++) {
      targets.push(`http://${subnet}.${i}:${port}`)
    }

    const total = targets.length
    const batchSize = 30

    for (let i = 0; i < targets.length; i += batchSize) {
      if (signal?.aborted) break

      const batch = targets.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map((url) => probe(url, signal))
      )

      for (const result of results) {
        completed++
        if (result) {
          servers.push(result)
        }
      }

      onProgress({ completed: Math.min(completed, total), total, servers: [...servers] })
    }

    resolve(servers)
  })
}
