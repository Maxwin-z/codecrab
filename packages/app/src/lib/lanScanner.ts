// LAN scanner — discovers CodeClaws servers on the local network
// Scans the same subnet as the browser's host address via /api/discovery

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

/**
 * Extract the subnet prefix from an IP address (e.g. "192.168.1.50" -> "192.168.1")
 */
function getSubnet(ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

/**
 * Check if a hostname is a private/local IP
 */
function isPrivateIp(hostname: string): boolean {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
}

/**
 * Probe a single host for the /api/discovery endpoint
 */
async function probe(url: string, signal?: AbortSignal): Promise<DiscoveredServer | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 1500)

    // Chain with external signal
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const res = await fetch(`${url}/api/discovery`, {
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) return null
    const data = await res.json()
    if (data.service !== 'CodeClaws') return null

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
 * Scan the local subnet for CodeClaws servers.
 * Uses the browser's current hostname to determine the subnet.
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

    // Determine scan targets
    let targets: string[] = []

    if (isPrivateIp(hostname)) {
      // Scan the same subnet
      const subnet = getSubnet(hostname)
      if (subnet) {
        for (let i = 1; i <= 254; i++) {
          targets.push(`http://${subnet}.${i}:${port}`)
        }
      }
    } else if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // Scan common ports on localhost
      for (let p = 4200; p <= 4210; p++) {
        targets.push(`http://127.0.0.1:${p}`)
      }
    } else {
      // Non-local hostname — just try current host with the given port
      targets.push(`http://${hostname}:${port}`)
    }

    if (targets.length === 0) {
      resolve([])
      return
    }

    const total = targets.length

    // Scan in batches to avoid overwhelming the browser
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
