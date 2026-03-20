// FilePreviewModal — modal overlay for previewing files (images, code, markdown)
import { useState, useEffect, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { authFetch, getToken } from '@/lib/auth'
import { buildApiUrl } from '@/lib/server'
import { X, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface FileContent {
  path: string
  name: string
  size: number
  modifiedAt?: number
  binary: boolean
  content: string | null
  lineCount?: number
  truncated?: boolean
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a'])

function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function getLanguageLabel(name: string): string {
  const ext = getExt(name)
  const map: Record<string, string> = {
    swift: 'Swift', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    json: 'JSON', md: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', yaml: 'YAML', yml: 'YAML',
    toml: 'TOML', sh: 'Shell', sql: 'SQL', txt: 'Text',
  }
  return map[ext] || ext.toUpperCase() || 'File'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildRawUrl(filePath: string): string {
  const token = getToken()
  const url = buildApiUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`)
  return token ? `${url}&token=${encodeURIComponent(token)}` : url
}

interface FilePreviewModalProps {
  filePath: string
  onClose: () => void
}

export function FilePreviewModal({ filePath, onClose }: FilePreviewModalProps) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showRendered, setShowRendered] = useState(true)

  const fileName = filePath.split('/').pop() || filePath
  const ext = getExt(fileName)
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(fileName)
  const isImage = IMAGE_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  const isAudio = AUDIO_EXTS.has(ext)
  const isMedia = isImage || isVideo || isAudio
  const rawUrl = isMedia ? buildRawUrl(filePath) : ''

  useEffect(() => {
    if (isMedia) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    authFetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setContent(data)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [filePath, isMedia])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleCopy = useCallback(() => {
    if (content?.content) {
      navigator.clipboard.writeText(content.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [content])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-[90vw] max-w-3xl h-[80vh] bg-background rounded-xl border shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium shrink-0">
              {getLanguageLabel(fileName)}
            </span>
            <span className="text-sm font-medium truncate">{fileName}</span>
            {content && (
              <span className="text-xs text-muted-foreground shrink-0">{formatSize(content.size)}</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {content?.content && (
              <>
                {isMarkdown && (
                  <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setShowRendered(!showRendered)}>
                    {showRendered ? 'Source' : 'Preview'}
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCopy} title="Copy">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                {copied && <span className="text-xs text-green-500">Copied</span>}
              </>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Path bar */}
        <div className="px-4 py-1 text-[10px] text-muted-foreground/60 font-mono border-b bg-muted/20 shrink-0 truncate">
          {filePath}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">{error}</div>
          )}

          {/* Image */}
          {isImage && !loading && (
            <div className="flex items-center justify-center h-full p-4 bg-muted/20">
              <img
                src={rawUrl}
                alt={fileName}
                className="max-w-full max-h-full object-contain rounded-lg"
                onError={() => setError('Failed to load image')}
              />
            </div>
          )}

          {/* Video */}
          {isVideo && !loading && (
            <div className="flex items-center justify-center h-full p-4 bg-black/50">
              <video src={rawUrl} controls className="max-w-full max-h-full rounded-lg" />
            </div>
          )}

          {/* Audio */}
          {isAudio && !loading && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <p className="text-sm font-medium text-muted-foreground">{fileName}</p>
              <audio src={rawUrl} controls className="w-full max-w-md" />
            </div>
          )}

          {/* Text content */}
          {!isMedia && content && !loading && !error && (
            <>
              {content.binary ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                  <p className="text-sm font-medium">Binary file</p>
                  <p className="text-xs">{formatSize(content.size)}</p>
                </div>
              ) : content.truncated ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                  <p className="text-sm font-medium">File too large</p>
                  <p className="text-xs">{formatSize(content.size)}</p>
                </div>
              ) : content.content ? (
                isMarkdown && showRendered ? (
                  <div className="overflow-auto h-full px-5 py-4 prose prose-sm dark:prose-invert max-w-none
                    prose-headings:font-semibold prose-headings:tracking-tight
                    prose-h1:text-xl prose-h1:border-b prose-h1:pb-2 prose-h1:mb-4
                    prose-h2:text-lg prose-h2:mt-6 prose-h2:mb-2
                    prose-h3:text-base prose-h3:mt-4
                    prose-p:leading-relaxed prose-p:my-2
                    prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                    prose-code:text-xs prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
                    prose-pre:bg-muted prose-pre:text-xs prose-pre:rounded-lg prose-pre:p-3
                    prose-li:my-0.5
                  ">
                    <Markdown remarkPlugins={[remarkGfm]}>{content.content}</Markdown>
                  </div>
                ) : (
                  <div className="overflow-auto h-full">
                    <pre className="text-xs leading-5 font-mono p-3 min-w-fit">
                      {content.content.split('\n').map((line, i) => (
                        <div key={i} className="flex hover:bg-accent/30">
                          <span className="select-none text-muted-foreground/40 text-right pr-3 shrink-0" style={{ minWidth: '3em' }}>
                            {i + 1}
                          </span>
                          <span className="whitespace-pre">{line || ' '}</span>
                        </div>
                      ))}
                    </pre>
                  </div>
                )
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
