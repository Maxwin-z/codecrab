// Image storage — saves base64 images to disk and serves them via URL
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ImageAttachment } from '@codecrab/shared'

const IMAGES_DIR = path.join(os.homedir(), '.codecrab', 'images')

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

async function ensureImagesDir() {
  await fs.mkdir(IMAGES_DIR, { recursive: true })
}

/** Save a base64 image to disk. Returns the filename (hash-based, deduped). */
export async function saveImageToDisk(base64Data: string, mediaType: string): Promise<string> {
  await ensureImagesDir()
  const hash = crypto.createHash('sha256').update(base64Data).digest('hex').slice(0, 16)
  const ext = EXT_MAP[mediaType] || 'bin'
  const filename = `${hash}.${ext}`
  const filepath = path.join(IMAGES_DIR, filename)
  try {
    await fs.access(filepath)
  } catch {
    await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'))
  }
  return filename
}

/** Get the absolute file path for a stored image. */
export function getImageFilePath(filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  return path.join(IMAGES_DIR, safe)
}

/** Convert base64 ImageAttachments to URL-based refs, saving files to disk.
 *  Returns a new array with `url` set and `data` cleared. */
export async function saveAndConvertImages(
  images: ImageAttachment[],
): Promise<ImageAttachment[]> {
  const results: ImageAttachment[] = []
  for (const img of images) {
    if (img.url) {
      // Already URL-based
      results.push(img)
      continue
    }
    const filename = await saveImageToDisk(img.data, img.mediaType)
    results.push({
      data: '',
      mediaType: img.mediaType,
      name: img.name,
      url: `/api/images/${filename}`,
    })
  }
  return results
}
