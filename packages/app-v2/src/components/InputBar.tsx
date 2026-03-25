import { useState, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Send, Square, ImagePlus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImageAttachment } from '@codecrab/shared'

/** Resize and compress an image file to base64 */
async function processImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const MAX_EDGE = 1568
        let w = img.width
        let h = img.height
        if (Math.max(w, h) > MAX_EDGE) {
          const scale = MAX_EDGE / Math.max(w, h)
          w = Math.round(w * scale)
          h = Math.round(h * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
        resolve({ data, mediaType: 'image/jpeg', name: file.name })
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function InputBar({
  isRunning,
  isAborting,
  disabled,
  onSend,
  onAbort,
}: {
  isRunning: boolean
  isAborting: boolean
  disabled?: boolean
  onSend: (prompt: string, images?: ImageAttachment[]) => void
  onAbort: () => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<(ImageAttachment & { preview: string })[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    const imgs = images.length > 0 ? images.map(({ preview, ...rest }) => rest) : undefined
    onSend(trimmed, imgs)
    setText('')
    setImages([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, images, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isRunning) handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      try {
        const processed = await processImage(file)
        const preview = URL.createObjectURL(file)
        setImages(prev => [...prev, { ...processed, preview }])
      } catch { /* ignore */ }
    }
    e.target.value = ''
  }

  const removeImage = (index: number) => {
    setImages(prev => {
      URL.revokeObjectURL(prev[index].preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={img.preview}
                alt={img.name}
                className="h-16 w-16 object-cover rounded-md border border-border"
              />
              <button
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                onClick={() => removeImage(i)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Image upload */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          <ImagePlus className="h-4 w-4" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Text input */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          disabled={disabled}
          rows={1}
          className={cn(
            'flex-1 resize-none bg-muted/50 rounded-lg px-3 py-2 text-sm',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'max-h-[150px]',
          )}
        />

        {/* Send / Abort */}
        {isRunning ? (
          <Button
            variant="destructive"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={onAbort}
            disabled={isAborting}
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handleSend}
            disabled={disabled || (!text.trim() && images.length === 0)}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
