// REST route for serving stored images
import { Router, type Router as RouterType } from 'express'
import fs from 'fs/promises'
import { getImageFilePath } from '../images.js'

const router: RouterType = Router()

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

router.get('/:filename', async (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '')
  const filepath = getImageFilePath(filename)
  try {
    const data = await fs.readFile(filepath)
    const ext = filename.split('.').pop() || ''
    res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(data)
  } catch {
    res.status(404).json({ error: 'Image not found' })
  }
})

export default router
