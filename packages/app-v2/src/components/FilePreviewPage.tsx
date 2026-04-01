import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { authFetch } from '@/lib/auth'
import { buildApiUrl } from '@/lib/server'
import { cn } from '@/lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, File, Hash, Eye, FileCode, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface FileContent {
  path: string
  name: string
  size: number
  modifiedAt?: number
  binary: boolean
  content?: string
  lineCount?: number
  truncated?: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getLanguageLabel(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', swift: 'Swift',
    json: 'JSON', md: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', sql: 'SQL',
    txt: 'Text', env: 'Env', lock: 'Lock',
  }
  return map[ext] ?? (ext ? ext.toUpperCase() : 'File')
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
function isImageFile(name: string) {
  return IMAGE_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '')
}
function isMarkdownFile(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'md' || ext === 'mdx' || ext === 'markdown'
}

function resolveImageApiUrl(src: string, filePath: string): string | null {
  if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return null
  let absPath: string
  if (src.startsWith('/')) {
    absPath = src
  } else {
    const dir = filePath.split('/').slice(0, -1).join('/')
    absPath = dir + '/' + src
  }
  const parts = absPath.split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (part === '..') normalized.pop()
    else if (part !== '.') normalized.push(part)
  }
  return buildApiUrl(`/api/files/raw?path=${encodeURIComponent(normalized.join('/'))}`)
}

function AuthImage({ apiUrl, alt, className }: { apiUrl: string; alt: string; className?: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string
    authFetch(apiUrl)
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl) })
      .catch(() => {})
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [apiUrl])
  if (!blobUrl) return null
  return <img src={blobUrl} alt={alt} className={className} />
}

function CodeView({ content, showLineNumbers }: { content: string; showLineNumbers: boolean }) {
  const lines = content.split('\n')
  const gutterWidth = Math.max(3, String(lines.length).length)
  return (
    <div className="overflow-auto flex-1">
      <pre className="text-sm font-mono p-4 min-w-max">
        {lines.map((line, i) => (
          <div key={i} className="leading-6 hover:bg-muted/30">
            {showLineNumbers && (
              <span
                className="inline-block text-right text-muted-foreground/50 select-none mr-4 shrink-0"
                style={{ minWidth: `${gutterWidth}ch` }}
              >
                {i + 1}
              </span>
            )}
            <span className="text-foreground">{line || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

export function FilePreviewPage() {
  const [searchParams] = useSearchParams()
  const filePath = searchParams.get('path') ?? ''
  const fileName = filePath.split('/').pop() ?? 'File'

  const [content, setContent] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [showRendered, setShowRendered] = useState(true)
  const [copied, setCopied] = useState(false)

  const isImage = isImageFile(fileName)
  const isMarkdown = isMarkdownFile(fileName)

  useEffect(() => {
    if (!filePath) { setError('No file path provided'); setLoading(false); return }
    document.title = fileName
    authFetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((data: FileContent) => setContent(data))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [filePath])

  const copyContent = () => {
    if (content?.content) {
      navigator.clipboard.writeText(content.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      {/* Toolbar */}
      <header className="h-10 border-b border-border flex items-center gap-2 px-4 shrink-0">
        <span className="font-medium text-sm truncate flex-1">{fileName}</span>
        {content && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-semibold text-[10px]">
              {getLanguageLabel(fileName)}
            </span>
            <span>{formatSize(content.size)}</span>
            {content.lineCount && content.lineCount > 0 && (
              <span>{content.lineCount} lines</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1 ml-2">
          {isMarkdown && (
            <Button variant="ghost" size="icon" className="h-7 w-7"
              title={showRendered ? 'Show source' : 'Show preview'}
              onClick={() => setShowRendered(v => !v)}
            >
              {showRendered
                ? <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                : <Eye className="h-3.5 w-3.5 text-muted-foreground" />}
            </Button>
          )}
          {!isImage && (
            <Button variant="ghost" size="icon" className="h-7 w-7"
              title={showLineNumbers ? 'Hide line numbers' : 'Show line numbers'}
              onClick={() => setShowLineNumbers(v => !v)}
            >
              <Hash className={cn('h-3.5 w-3.5', showLineNumbers ? 'text-foreground' : 'text-muted-foreground')} />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy content" onClick={copyContent}>
            <Copy className={cn('h-3.5 w-3.5', copied ? 'text-green-500' : 'text-muted-foreground')} />
          </Button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full px-8 text-sm text-destructive text-center">
            {error}
          </div>
        )}
        {content && !loading && (
          <>
            {isImage ? (
              <div className="flex items-center justify-center p-8 min-h-full">
                <AuthImage
                  apiUrl={buildApiUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`)}
                  alt={fileName}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            ) : content.binary ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <File className="h-12 w-12" />
                <span className="text-base font-medium">Binary file</span>
                <span className="text-sm">{formatSize(content.size)}</span>
              </div>
            ) : content.truncated ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <FileText className="h-12 w-12" />
                <span className="text-base font-medium">File too large to preview</span>
                <span className="text-sm">{formatSize(content.size)}</span>
              </div>
            ) : isMarkdown && showRendered ? (
              <div className="p-8 max-w-4xl mx-auto prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img({ src, alt }) {
                      const apiUrl = resolveImageApiUrl(src ?? '', filePath)
                      if (apiUrl) return <AuthImage apiUrl={apiUrl} alt={alt ?? ''} className="max-w-full rounded" />
                      return <img src={src} alt={alt ?? ''} className="max-w-full rounded" />
                    },
                  }}
                >
                  {content.content ?? ''}
                </ReactMarkdown>
              </div>
            ) : (
              <CodeView content={content.content ?? ''} showLineNumbers={showLineNumbers} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
