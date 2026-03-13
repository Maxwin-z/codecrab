import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

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
  try {
    const resolved = path.resolve(dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
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
