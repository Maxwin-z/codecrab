import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output',
])

const router: RouterType = Router()

// List directory contents
router.get('/', async (req, res) => {
  const dirPath = (req.query.path as string) || os.homedir()
  try {
    const resolved = path.resolve(dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const items = entries
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => !e.isDirectory() || !SKIP_DIRS.has(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(resolved, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
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
