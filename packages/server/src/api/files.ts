import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output',
])

const MAX_FILE_SIZE = 512 * 1024 // 512KB max for file read

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
])

const router: RouterType = Router()

// List directory contents
router.get('/', async (req, res) => {
  const dirPath = (req.query.path as string) || os.homedir()
  const showHidden = req.query.showHidden === '1'
  try {
    const resolved = path.resolve(dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const items = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .filter((e) => !e.isDirectory() || !SKIP_DIRS.has(e.name))
        .map(async (e) => {
          const fullPath = path.join(resolved, e.name)
          const isDir = e.isDirectory()
          let size: number | undefined
          let modifiedAt: number | undefined
          if (!isDir) {
            try {
              const stat = await fs.stat(fullPath)
              size = stat.size
              modifiedAt = stat.mtimeMs
            } catch {
              // skip stat errors
            }
          }
          return {
            name: e.name,
            path: fullPath,
            isDirectory: isDir,
            size,
            modifiedAt,
          }
        }),
    )
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    res.json({
      current: resolved,
      parent: path.dirname(resolved),
      items,
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Read file contents
router.get('/read', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    res.status(400).json({ error: 'Missing path parameter' })
    return
  }
  try {
    const resolved = path.resolve(filePath)
    const stat = await fs.stat(resolved)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }
    const ext = path.extname(resolved).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      res.json({
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        binary: true,
        content: null,
        lineCount: 0,
      })
      return
    }
    if (stat.size > MAX_FILE_SIZE) {
      res.json({
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        binary: false,
        truncated: true,
        content: null,
        lineCount: 0,
      })
      return
    }
    const content = await fs.readFile(resolved, 'utf-8')
    const lineCount = content.split('\n').length
    res.json({
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      binary: false,
      content,
      lineCount,
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Search files recursively (respects .gitignore via git ls-files)
router.get('/search', async (req, res) => {
  const query = (req.query.q as string || '').toLowerCase()
  const root = req.query.root as string
  const limit = Math.min(parseInt(req.query.limit as string) || 500, 1000)

  if (!root) {
    res.status(400).json({ error: 'Missing root parameter' })
    return
  }

  try {
    const resolved = path.resolve(root)

    // Try git ls-files first (respects .gitignore)
    const gitFiles = await getGitFiles(resolved)
    if (gitFiles) {
      const seen = new Set<string>()
      const results: { name: string; path: string; relativePath: string; isDirectory: boolean }[] = []

      // Collect unique directories from file paths
      for (const relPath of gitFiles) {
        const parts = relPath.split('/')
        let accumulated = ''
        for (let i = 0; i < parts.length - 1; i++) {
          accumulated = accumulated ? accumulated + '/' + parts[i] : parts[i]
          if (!seen.has('d:' + accumulated)) {
            seen.add('d:' + accumulated)
            const dirName = parts[i]
            if (!query || dirName.toLowerCase().includes(query) || accumulated.toLowerCase().includes(query)) {
              if (results.length < limit) {
                results.push({
                  name: dirName,
                  path: path.join(resolved, accumulated),
                  relativePath: accumulated,
                  isDirectory: true,
                })
              }
            }
          }
        }

        // Add file
        const fileName = path.basename(relPath)
        if (!query || fileName.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
          if (results.length < limit) {
            results.push({
              name: fileName,
              path: path.join(resolved, relPath),
              relativePath: relPath,
              isDirectory: false,
            })
          }
        }
      }

      res.json(results)
      return
    }

    // Fallback: manual walk for non-git repos
    const results: { name: string; path: string; relativePath: string; isDirectory: boolean }[] = []
    const MAX_DEPTH = 6

    const showHidden = req.query.showHidden === '1'

    async function walk(dir: string, depth: number) {
      if (depth > MAX_DEPTH || results.length >= limit) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (results.length >= limit) break
        if (!showHidden && e.name.startsWith('.')) continue
        const fullPath = path.join(dir, e.name)
        const relativePath = path.relative(resolved, fullPath)
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue
          if (!query || e.name.toLowerCase().includes(query) || relativePath.toLowerCase().includes(query)) {
            results.push({ name: e.name, path: fullPath, relativePath, isDirectory: true })
          }
          await walk(fullPath, depth + 1)
        } else {
          if (!query || e.name.toLowerCase().includes(query) || relativePath.toLowerCase().includes(query)) {
            results.push({ name: e.name, path: fullPath, relativePath, isDirectory: false })
          }
        }
      }
    }

    await walk(resolved, 0)
    res.json(results)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

async function getGitFiles(root: string): Promise<string[] | null> {
  try {
    // Get tracked + untracked-but-not-ignored files (respects .gitignore)
    const { stdout } = await execAsync(
      'git -c core.quotePath=false ls-files --cached --others --exclude-standard',
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    )
    return stdout.split('\n').filter(Boolean)
  } catch {
    return null // not a git repo or git not available
  }
}

// Serve raw file (for image/video preview)
// Uses streaming with Range request support (required by AVPlayer for video)
router.get('/raw', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    res.status(400).json({ error: 'Missing path parameter' })
    return
  }
  try {
    const resolved = path.resolve(filePath)
    const stat = await fs.stat(resolved)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }

    const ext = path.extname(resolved).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.pdf': 'application/pdf',
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      // Handle Range requests (required by AVPlayer for video streaming)
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      const { createReadStream } = await import('fs')
      const stream = createReadStream(resolved, { start, end })

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      })
      stream.pipe(res)
    } else {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', fileSize)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, max-age=300')

      const { createReadStream } = await import('fs')
      const stream = createReadStream(resolved)
      stream.pipe(res)
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Probe file existence (batch)
router.post('/probe', async (req, res) => {
  const { paths } = req.body as { paths: string[] }
  if (!Array.isArray(paths) || paths.length === 0) {
    res.status(400).json({ error: 'Missing paths array' })
    return
  }
  const limited = paths.slice(0, 50)
  const results: Record<string, { exists: boolean; isFile: boolean; size?: number }> = {}
  await Promise.all(
    limited.map(async (p) => {
      try {
        const resolved = path.resolve(p)
        const stat = await fs.stat(resolved)
        results[p] = { exists: true, isFile: stat.isFile(), size: stat.size }
      } catch {
        results[p] = { exists: false, isFile: false }
      }
    }),
  )
  res.json({ results })
})

// Create new folder
router.post('/mkdir', async (req, res) => {
  const { path: dirPath, name } = req.body as { path?: string; name?: string }
  if (!dirPath || !name) {
    res.status(400).json({ error: 'Missing path or name' })
    return
  }
  try {
    const resolved = path.resolve(dirPath)
    const newDirPath = path.join(resolved, name)
    await fs.mkdir(newDirPath, { recursive: true })
    res.json({ success: true, path: newDirPath })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

export default router
