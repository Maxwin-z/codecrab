// Tests for WebSocket protocol types and message validation
import { describe, it, expect } from 'vitest'
import type {
  PromptMessage,
  ChatMessage,
  ImageAttachment,
  ClientMessage,
  ServerMessage,
} from '@codecrab/shared'

describe('Protocol types — ImageAttachment', () => {
  it('should accept valid JPEG image attachment', () => {
    const img: ImageAttachment = {
      data: 'base64encodeddata',
      mediaType: 'image/jpeg',
      name: 'photo.jpg',
    }
    expect(img.data).toBe('base64encodeddata')
    expect(img.mediaType).toBe('image/jpeg')
    expect(img.name).toBe('photo.jpg')
  })

  it('should accept valid PNG image attachment', () => {
    const img: ImageAttachment = {
      data: 'pngbase64data',
      mediaType: 'image/png',
    }
    expect(img.mediaType).toBe('image/png')
    expect(img.name).toBeUndefined()
  })

  it('should accept valid GIF image attachment', () => {
    const img: ImageAttachment = {
      data: 'gifdata',
      mediaType: 'image/gif',
    }
    expect(img.mediaType).toBe('image/gif')
  })

  it('should accept valid WebP image attachment', () => {
    const img: ImageAttachment = {
      data: 'webpdata',
      mediaType: 'image/webp',
    }
    expect(img.mediaType).toBe('image/webp')
  })
})

describe('Protocol types — PromptMessage with images', () => {
  it('should create prompt message without images', () => {
    const msg: PromptMessage = {
      type: 'prompt',
      prompt: 'Hello',
      projectId: 'proj-1',
    }
    expect(msg.images).toBeUndefined()
    expect(msg.prompt).toBe('Hello')
  })

  it('should create prompt message with single image', () => {
    const msg: PromptMessage = {
      type: 'prompt',
      prompt: 'Describe this image',
      projectId: 'proj-1',
      images: [
        {
          data: 'base64jpeg',
          mediaType: 'image/jpeg',
          name: 'screenshot.jpg',
        },
      ],
    }
    expect(msg.images).toHaveLength(1)
    expect(msg.images![0].mediaType).toBe('image/jpeg')
  })

  it('should create prompt message with multiple images', () => {
    const images: ImageAttachment[] = [
      { data: 'img1data', mediaType: 'image/jpeg', name: 'a.jpg' },
      { data: 'img2data', mediaType: 'image/png', name: 'b.png' },
      { data: 'img3data', mediaType: 'image/webp' },
    ]
    const msg: PromptMessage = {
      type: 'prompt',
      prompt: 'Compare these images',
      images,
    }
    expect(msg.images).toHaveLength(3)
  })
})

describe('Protocol types — ChatMessage with images', () => {
  it('should store images on user chat message', () => {
    const msg: ChatMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Look at this',
      images: [
        { data: 'base64data', mediaType: 'image/png', name: 'screen.png' },
      ],
      timestamp: Date.now(),
    }
    expect(msg.images).toHaveLength(1)
    expect(msg.role).toBe('user')
  })

  it('should work without images (backward compatible)', () => {
    const msg: ChatMessage = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Response text',
      timestamp: Date.now(),
    }
    expect(msg.images).toBeUndefined()
  })
})

describe('Protocol types — Message serialization', () => {
  it('should serialize PromptMessage with images to JSON', () => {
    const msg: PromptMessage = {
      type: 'prompt',
      prompt: 'Analyze this',
      projectId: 'proj-1',
      images: [
        { data: 'dGVzdA==', mediaType: 'image/jpeg', name: 'test.jpg' },
      ],
    }

    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json) as PromptMessage
    expect(parsed.type).toBe('prompt')
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images![0].data).toBe('dGVzdA==')
    expect(parsed.images![0].mediaType).toBe('image/jpeg')
  })

  it('should serialize ChatMessage with images to JSON', () => {
    const msg: ChatMessage = {
      id: 'msg-3',
      role: 'user',
      content: 'Check this',
      images: [
        { data: 'aW1nZGF0YQ==', mediaType: 'image/png' },
        { data: 'aW1nMg==', mediaType: 'image/webp', name: 'photo.webp' },
      ],
      timestamp: 1710000000000,
    }

    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json) as ChatMessage
    expect(parsed.images).toHaveLength(2)
    expect(parsed.images![0].mediaType).toBe('image/png')
    expect(parsed.images![1].name).toBe('photo.webp')
  })

  it('should handle empty images array in serialization', () => {
    const msg: PromptMessage = {
      type: 'prompt',
      prompt: 'No images',
      images: [],
    }

    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json) as PromptMessage
    expect(parsed.images).toEqual([])
  })
})

describe('Protocol — image validation helpers', () => {
  const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const MAX_BASE64_SIZE = 5 * 1024 * 1024 * 1.37 // ~5MB in base64 (with overhead)

  function validateImageAttachment(img: ImageAttachment): string[] {
    const errors: string[] = []
    if (!SUPPORTED_MEDIA_TYPES.includes(img.mediaType)) {
      errors.push(`Unsupported media type: ${img.mediaType}`)
    }
    if (!img.data || img.data.length === 0) {
      errors.push('Image data is empty')
    }
    if (img.data && img.data.length > MAX_BASE64_SIZE) {
      errors.push('Image data exceeds 5MB limit')
    }
    return errors
  }

  it('should validate a correct image', () => {
    const errors = validateImageAttachment({
      data: 'dGVzdA==',
      mediaType: 'image/jpeg',
    })
    expect(errors).toHaveLength(0)
  })

  it('should reject unsupported media type', () => {
    const errors = validateImageAttachment({
      data: 'test',
      mediaType: 'image/bmp' as any,
    })
    expect(errors).toContain('Unsupported media type: image/bmp')
  })

  it('should reject empty data', () => {
    const errors = validateImageAttachment({
      data: '',
      mediaType: 'image/png',
    })
    expect(errors).toContain('Image data is empty')
  })

  it('should reject oversized data', () => {
    const bigData = 'A'.repeat(8 * 1024 * 1024) // ~8MB
    const errors = validateImageAttachment({
      data: bigData,
      mediaType: 'image/jpeg',
    })
    expect(errors).toContain('Image data exceeds 5MB limit')
  })
})
