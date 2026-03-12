// InputBar — user text input with image upload and drag & drop support
import { useState, useRef, useEffect, useCallback } from 'react'
import type { ImageAttachment, McpInfo, PermissionMode } from '@codeclaws/shared'

const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_LONG_EDGE = 1568
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

interface PreviewImage {
  attachment: ImageAttachment
  previewUrl: string // object URL for thumbnail display
}

interface InputBarProps {
  onSend: (text: string, images?: ImageAttachment[], enabledMcps?: string[]) => void
  onAbort: () => void
  isRunning: boolean
  isAborting?: boolean
  disabled: boolean
  currentModel?: string
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  availableMcps?: McpInfo[]
  enabledMcps?: string[]
  onToggleMcp?: (mcpId: string) => void
  sdkLoaded?: boolean
  onProbeSdk?: () => void
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

export function InputBar({ onSend, onAbort, isRunning, isAborting, disabled, currentModel, permissionMode, onPermissionModeChange, availableMcps, enabledMcps, onToggleMcp, sdkLoaded, onProbeSdk }: InputBarProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PreviewImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [mcpPopoverOpen, setMcpPopoverOpen] = useState(false)
  const [sdkProbing, setSdkProbing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // When SDK finishes loading after a probe, stop spinner and auto-open popover
  useEffect(() => {
    if (sdkProbing && sdkLoaded) {
      setSdkProbing(false)
      setMcpPopoverOpen(true)
    }
  }, [sdkProbing, sdkLoaded])

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

  // Close MCP panel on Escape key
  useEffect(() => {
    if (!mcpPopoverOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMcpPopoverOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [mcpPopoverOpen])

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return

    const attachments = images.length > 0 ? images.map((img) => img.attachment) : undefined
    onSend(trimmed, attachments, enabledMcps)

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

            {/* MCP toggle button */}
            {availableMcps && availableMcps.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => {
                    if (!sdkLoaded && !sdkProbing && onProbeSdk) {
                      // SDK not loaded yet — trigger probe, show spinner
                      setSdkProbing(true)
                      onProbeSdk()
                    } else {
                      setMcpPopoverOpen((v) => !v)
                    }
                  }}
                  disabled={disabled || isRunning || sdkProbing}
                  className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                    sdkProbing
                      ? 'text-muted-foreground'
                      : enabledMcps && enabledMcps.length < availableMcps.length
                        ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-500/10'
                        : sdkLoaded
                          ? 'text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                  title={sdkProbing ? 'Loading MCP servers & skills...' : sdkLoaded ? 'Manage MCP servers & skills' : 'Load MCP servers & skills'}
                >
                  {sdkProbing ? (
                    /* Spinner */
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    /* Puzzle piece icon */
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.611a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 0 1 .276-.837l1.611-1.611a2.404 2.404 0 0 1 1.704-.706c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
                    </svg>
                  )}
                </button>

                {/* MCP panel — full-height side panel on desktop, fullscreen on mobile */}
                {mcpPopoverOpen && (
                  <>
                    {/* Backdrop */}
                    <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setMcpPopoverOpen(false)} />

                    {/* Panel */}
                    <div className="fixed inset-0 sm:top-0 sm:left-0 sm:right-auto sm:bottom-0 sm:w-80 bg-background text-popover-foreground border-r z-50 flex flex-col shadow-xl">
                      {/* Header */}
                      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
                        <div>
                          <p className="text-sm font-semibold">MCP Servers & Skills</p>
                          <p className="text-[11px] text-muted-foreground">Toggle servers and skills for this query</p>
                        </div>
                        <button
                          onClick={() => setMcpPopoverOpen(false)}
                          className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>

                      {/* List */}
                      <div className="flex-1 overflow-y-auto py-1">
                        {availableMcps.map((mcp) => {
                          const isEnabled = !enabledMcps || enabledMcps.includes(mcp.id)
                          return (
                            <button
                              key={mcp.id}
                              onClick={() => onToggleMcp?.(mcp.id)}
                              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50 transition-colors text-left"
                            >
                              <span className="text-base shrink-0">{mcp.icon || '🔌'}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-sm font-medium truncate">{mcp.name}</p>
                                  {mcp.source && mcp.source !== 'custom' && (
                                    <span className={`text-[9px] px-1 py-0.5 rounded font-medium leading-none ${
                                      mcp.source === 'sdk' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                                    }`}>{mcp.source === 'sdk' ? 'SDK' : 'Skill'}</span>
                                  )}
                                </div>
                                <p className="text-[10px] text-muted-foreground truncate">{mcp.description}</p>
                              </div>
                              <div className="shrink-0 flex items-center gap-1.5">
                                {mcp.toolCount > 0 && <span className="text-[10px] text-muted-foreground">{mcp.toolCount} tools</span>}
                                <div className={`w-8 h-4.5 rounded-full transition-colors relative ${isEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                                  <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

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
