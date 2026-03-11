// InputBar — user text input with image upload and drag & drop support
import { useState, useRef, useEffect, useCallback } from 'react'
import type { ImageAttachment, PermissionMode } from '@codeclaws/shared'

const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_LONG_EDGE = 1568
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

interface PreviewImage {
  attachment: ImageAttachment
  previewUrl: string // object URL for thumbnail display
}

interface InputBarProps {
  onSend: (text: string, images?: ImageAttachment[]) => void
  onAbort: () => void
  isRunning: boolean
  isAborting?: boolean
  disabled: boolean
  currentModel?: string
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
}

/** Compress and resize an image file, returns base64 ImageAttachment */
async function processImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img
      const longEdge = Math.max(width, height)

      // Scale down if exceeds max
      if (longEdge > MAX_LONG_EDGE) {
        const scale = MAX_LONG_EDGE / longEdge
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)

      // Determine output format: keep PNG for screenshots, JPEG for others
      const isPng = file.type === 'image/png'
      const outputType = isPng ? 'image/png' : 'image/jpeg'

      // Try compression with decreasing quality
      let quality = 0.85
      let dataUrl = canvas.toDataURL(outputType, quality)

      while (dataUrl.length * 0.75 > MAX_FILE_SIZE && quality > 0.3) {
        quality -= 0.1
        dataUrl = canvas.toDataURL('image/jpeg', quality)
      }

      const base64 = dataUrl.split(',')[1]
      const mediaType = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'

      resolve({
        data: base64,
        mediaType: mediaType as ImageAttachment['mediaType'],
        name: file.name,
      })
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Failed to load image: ${file.name}`))
    }

    img.src = url
  })
}

export function InputBar({ onSend, onAbort, isRunning, isAborting, disabled, currentModel, permissionMode, onPermissionModeChange }: InputBarProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PreviewImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }
  }, [text])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const validFiles = Array.from(files).filter((f) => SUPPORTED_TYPES.includes(f.type))
    if (validFiles.length === 0) return

    setProcessing(true)
    try {
      const newImages: PreviewImage[] = []
      for (const file of validFiles) {
        const attachment = await processImage(file)
        const previewUrl = URL.createObjectURL(file)
        newImages.push({ attachment, previewUrl })
      }
      setImages((prev) => [...prev, ...newImages])
    } catch (err) {
      console.error('Failed to process images:', err)
    } finally {
      setProcessing(false)
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const next = [...prev]
      URL.revokeObjectURL(next[index].previewUrl)
      next.splice(index, 1)
      return next
    })
  }, [])

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return

    const attachments = images.length > 0 ? images.map((img) => img.attachment) : undefined
    onSend(trimmed, attachments)

    setText('')
    setImages([])

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const isComposingRef = useRef(false)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && !isComposingRef.current) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Drag & drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)

    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      addFiles(imageFiles)
    }
  }

  const canSend = text.trim().length > 0 && !disabled && !processing

  return (
    <div className="px-4 py-3">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Main container — rounded border box */}
      <div
        className={`rounded-2xl border bg-muted/50 transition-colors ${
          isDragging ? 'border-primary bg-primary/5' : 'border-border'
        } ${disabled ? 'opacity-50' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.previewUrl}
                  alt={img.attachment.name || `Image ${i + 1}`}
                  className="h-16 w-16 object-cover rounded-lg border"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Drag overlay */}
        {isDragging && (
          <div className="px-3 pt-3">
            <div className="border-2 border-dashed border-primary/50 rounded-lg p-4 text-center text-sm text-muted-foreground">
              Drop images here
            </div>
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          onPaste={handlePaste}
          placeholder={isRunning ? 'Running...' : 'Cmd+Enter to send'}
          disabled={disabled || isRunning}
          rows={1}
          className="w-full min-h-[44px] max-h-[150px] bg-transparent px-4 pt-3 pb-1 text-sm resize-none placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-2 pb-2">
          {/* Left: action buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isRunning}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              title="Attach images"
            >
              {/* Paperclip icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            {/* Status indicators */}
            {processing && (
              <span className="text-xs text-amber-500 ml-1">Processing...</span>
            )}
            {images.length > 0 && !processing && (
              <span className="text-xs text-muted-foreground ml-1">
                {images.length} image{images.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Right: mode toggle + send / abort button */}
          <div className="flex items-center gap-2">
            {onPermissionModeChange && (
              <button
                onClick={() => onPermissionModeChange(permissionMode === 'bypassPermissions' ? 'default' : 'bypassPermissions')}
                disabled={disabled || isRunning}
                title={permissionMode === 'bypassPermissions' ? 'YOLO mode: all actions auto-approved' : 'Safe mode: dangerous actions require approval'}
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 ${
                  permissionMode === 'bypassPermissions'
                    ? 'text-orange-500 bg-orange-500/10 hover:bg-orange-500/20'
                    : 'text-green-600 bg-green-500/10 hover:bg-green-500/20 dark:text-green-400'
                }`}
              >
                {permissionMode === 'bypassPermissions' ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    YOLO
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    Safe
                  </>
                )}
              </button>
            )}
            <span className="text-xs text-muted-foreground font-mono mr-1">{currentModel || 'Default'}</span>
            {isRunning ? (
              <button
                onClick={onAbort}
                disabled={isAborting}
                className="h-8 w-8 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center hover:bg-destructive/90 transition-colors disabled:opacity-50"
                title={isAborting ? 'Stopping...' : 'Stop'}
              >
                {isAborting ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" className="animate-spin">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="60" strokeDashoffset="20" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                )}
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${
                  canSend
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground'
                }`}
                title="Send (Cmd+Enter)"
              >
                {/* Up arrow icon */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
