// FileBrowser — file system navigation with preview (matches iOS FileBrowserView)
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { authFetch, getToken } from '@/lib/auth'
import { buildApiUrl } from '@/lib/server'
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  Search,
  X,
  Folder,
  FileText,
  FileCode,
  Image as ImageIcon,
  Film,
  Archive,
  Terminal,
  Lock,
  Key,
  EyeOff,
  Music,
  Globe,
  Paintbrush,
  File,
  Diamond,
  Cog,
  Copy,
  FileDigit,
} from 'lucide-react'

// --- Types ---

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  modifiedAt?: number
}

interface FileListing {
  current: string
  parent: string | null
  items: FileEntry[]
}

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

// --- Helpers ---

function getExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function getFileIcon(entry: FileEntry) {
  if (entry.isDirectory) return <Folder className="h-4.5 w-4.5 text-blue-500" />
  const ext = getExt(entry.name)
  switch (ext) {
    case 'ts': case 'tsx': return <FileCode className="h-4.5 w-4.5 text-blue-500" />
    case 'js': case 'jsx': return <FileCode className="h-4.5 w-4.5 text-yellow-500" />
    case 'swift': return <FileCode className="h-4.5 w-4.5 text-orange-500" />
    case 'json': return <FileCode className="h-4.5 w-4.5 text-green-500" />
    case 'md': case 'txt': case 'rtf': return <FileText className="h-4.5 w-4.5 text-muted-foreground" />
    case 'html': case 'htm': return <Globe className="h-4.5 w-4.5 text-red-500" />
    case 'css': case 'scss': case 'less': return <Paintbrush className="h-4.5 w-4.5 text-purple-500" />
    case 'py': return <FileCode className="h-4.5 w-4.5 text-blue-500" />
    case 'rb': return <Diamond className="h-4.5 w-4.5 text-red-500" />
    case 'go': return <FileCode className="h-4.5 w-4.5 text-cyan-500" />
    case 'rs': return <Cog className="h-4.5 w-4.5 text-orange-600" />
    case 'yaml': case 'yml': case 'toml': return <FileDigit className="h-4.5 w-4.5 text-muted-foreground" />
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': case 'ico':
      return <ImageIcon className="h-4.5 w-4.5 text-pink-500" />
    case 'mp3': case 'wav': case 'm4a': return <Music className="h-4.5 w-4.5 text-purple-500" />
    case 'mp4': case 'mov': case 'avi': return <Film className="h-4.5 w-4.5 text-blue-500" />
    case 'zip': case 'tar': case 'gz': case 'rar': return <Archive className="h-4.5 w-4.5 text-muted-foreground" />
    case 'pdf': return <FileText className="h-4.5 w-4.5 text-red-500" />
    case 'sh': case 'zsh': case 'bash': return <Terminal className="h-4.5 w-4.5 text-green-500" />
    case 'lock': return <Lock className="h-4.5 w-4.5 text-muted-foreground" />
    case 'env': return <Key className="h-4.5 w-4.5 text-yellow-600" />
    case 'gitignore': case 'dockerignore': return <EyeOff className="h-4.5 w-4.5 text-muted-foreground" />
    default: return <File className="h-4.5 w-4.5 text-muted-foreground" />
  }
}

function getLanguageLabel(name: string): string {
  const ext = getExt(name)
  const map: Record<string, string> = {
    swift: 'Swift', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    json: 'JSON', md: 'Markdown', html: 'HTML', htm: 'HTML', css: 'CSS',
    scss: 'SCSS', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', sh: 'Shell',
    bash: 'Shell', zsh: 'Shell', sql: 'SQL', txt: 'Text', env: 'Env',
    lock: 'Lock', plist: 'Plist', graphql: 'GraphQL', gql: 'GraphQL',
  }
  return map[ext] || ext.toUpperCase() || 'File'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

function shortenPath(fullPath: string): string {
  const home = fullPath.match(/^\/Users\/[^/]+/)
  if (home) return '~' + fullPath.slice(home[0].length)
  return fullPath
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a'])

function isImageFile(name: string) { return IMAGE_EXTS.has(getExt(name)) }
function isVideoFile(name: string) { return VIDEO_EXTS.has(getExt(name)) }
function isAudioFile(name: string) { return AUDIO_EXTS.has(getExt(name)) }
function buildRawUrl(filePath: string): string {
  const token = getToken()
  const url = buildApiUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`)
  return token ? `${url}&token=${encodeURIComponent(token)}` : url
}

// --- File Preview Component ---

function FilePreview({ filePath, fileName, onBack }: {
  filePath: string
  fileName: string
  onBack: () => void
}) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [showRendered, setShowRendered] = useState(true)
  const [copied, setCopied] = useState(false)

  const isMarkdown = /\.(md|markdown|mdx)$/i.test(fileName)
  const mediaType = isImageFile(fileName) ? 'image' : isVideoFile(fileName) ? 'video' : isAudioFile(fileName) ? 'audio' : null
  const rawUrl = mediaType ? buildRawUrl(filePath) : ''

  useEffect(() => {
    if (mediaType) {
      // For media files, skip reading content — we use the raw endpoint directly
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const encoded = encodeURIComponent(filePath)
    authFetch(`/api/files/read?path=${encoded}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setContent(data)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [filePath, mediaType])

  const handleCopy = useCallback(() => {
    if (content?.content) {
      navigator.clipboard.writeText(content.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [content])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-sm font-medium truncate">{fileName}</h2>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {content?.content && (
            <>
              {isMarkdown && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setShowRendered(!showRendered)}
                >
                  {showRendered ? 'Source' : 'Preview'}
                </Button>
              )}
              {(!isMarkdown || !showRendered) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setShowLineNumbers(!showLineNumbers)}
                >
                  {showLineNumbers ? 'Hide #' : 'Show #'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleCopy}
                title="Copy contents"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              {copied && <span className="text-xs text-green-500">Copied</span>}
            </>
          )}
        </div>
      </header>

      {/* File info bar — only for non-media files */}
      {content && !mediaType && (
        <div className="flex items-center gap-3 px-4 py-1.5 text-xs border-b bg-muted/30 shrink-0">
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
            {getLanguageLabel(fileName)}
          </span>
          <span className="text-muted-foreground">{formatSize(content.size)}</span>
          {content.lineCount && content.lineCount > 0 && (
            <span className="text-muted-foreground">{content.lineCount} lines</span>
          )}
          {content.modifiedAt && (
            <span className="text-muted-foreground/60 ml-auto">{formatTimeAgo(content.modifiedAt)}</span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Media preview */}
        {mediaType === 'image' && !loading && (
          <div className="flex items-center justify-center h-full p-4 bg-muted/20">
            <img
              src={rawUrl}
              alt={fileName}
              className="max-w-full max-h-full object-contain rounded-lg"
              onError={() => setError('Failed to load image')}
            />
          </div>
        )}
        {mediaType === 'video' && !loading && (
          <div className="flex items-center justify-center h-full p-4 bg-black/50">
            <video
              src={rawUrl}
              controls
              className="max-w-full max-h-full rounded-lg"
              onError={() => setError('Failed to load video')}
            />
          </div>
        )}
        {mediaType === 'audio' && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <Music className="h-16 w-16 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">{fileName}</p>
            <audio
              src={rawUrl}
              controls
              className="w-full max-w-md"
              onError={() => setError('Failed to load audio')}
            />
          </div>
        )}

        {/* Text/binary content */}
        {!mediaType && content && !loading && !error && (
          <>
            {content.binary ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
                <Archive className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">Binary file</p>
                <p className="text-xs">{formatSize(content.size)}</p>
                <p className="text-xs opacity-60">Preview not available for binary files</p>
              </div>
            ) : content.truncated ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
                <FileText className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">File too large</p>
                <p className="text-xs">{formatSize(content.size)}</p>
                <p className="text-xs opacity-60">Files over 512 KB cannot be previewed</p>
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
                  prose-table:text-sm
                  prose-th:bg-muted/50 prose-th:px-3 prose-th:py-1.5
                  prose-td:px-3 prose-td:py-1.5 prose-td:border-t
                  prose-img:rounded-lg prose-img:max-w-full
                  prose-blockquote:border-l-primary/30 prose-blockquote:text-muted-foreground
                  prose-hr:my-6 prose-hr:border-border
                ">
                  <Markdown remarkPlugins={[remarkGfm]}>{content.content}</Markdown>
                </div>
              ) : (
                <div className="overflow-auto h-full">
                  <pre className="text-xs leading-5 font-mono p-3 min-w-fit">
                    {content.content.split('\n').map((line, i) => (
                      <div key={i} className="flex hover:bg-accent/30">
                        {showLineNumbers && (
                          <span className="select-none text-muted-foreground/40 text-right pr-3 shrink-0" style={{ minWidth: '3em' }}>
                            {i + 1}
                          </span>
                        )}
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
  )
}

// --- Main FileBrowser Component ---

interface FileBrowserProps {
  projectPath: string
  onClose: () => void
}

export function FileBrowser({ projectPath, onClose }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [items, setItems] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [searchText, setSearchText] = useState('')
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)

  // Browser history integration: each pushState carries a _fbDepth so we know
  // how many entries to rewind on close.
  const depthRef = useRef(0)

  const pushFBState = useCallback((dir: string, file?: { path: string; name: string }) => {
    depthRef.current++
    history.pushState({ _fb: true, _fbDepth: depthRef.current, dir, file }, '')
    setCanGoBack(depthRef.current > 1)
  }, [])

  // Fetch directory listing (returns resolved path)
  const fetchDir = useCallback((dirPath: string): Promise<string | null> => {
    setSearchText('')
    setLoading(true)
    return authFetch(`/api/files?path=${encodeURIComponent(dirPath)}`)
      .then((r) => r.json())
      .then((data: FileListing) => {
        setCurrentPath(data.current)
        setItems(data.items)
        return data.current
      })
      .catch((err) => { console.error('Failed to fetch files:', err); return null })
      .finally(() => setLoading(false))
  }, [])

  // Initial load — push first history entry
  useEffect(() => {
    fetchDir(projectPath).then((resolved) => {
      if (resolved) pushFBState(resolved)
    })
  }, [projectPath, fetchDir, pushFBState])

  // Listen to browser back/forward
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state
      if (!state || !state._fb) {
        // Left FileBrowser history — close
        onClose()
        return
      }
      depthRef.current = state._fbDepth
      setCanGoBack(depthRef.current > 1)

      if (state.file) {
        setPreviewFile({ path: state.file.path, name: state.file.name, isDirectory: false })
      } else {
        setPreviewFile(null)
        fetchDir(state.dir)
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [onClose, fetchDir])

  // Navigate to a directory (user action — pushes history)
  const navigateTo = useCallback((dirPath: string) => {
    fetchDir(dirPath).then((resolved) => {
      if (resolved) pushFBState(resolved)
    })
  }, [fetchDir, pushFBState])

  // Close: rewind all FB history entries, popstate will fire onClose
  const handleClose = useCallback(() => {
    const d = depthRef.current
    if (d > 0) {
      history.go(-d)
    } else {
      onClose()
    }
  }, [onClose])

  // Breadcrumb segments
  const segments = useMemo(() => {
    if (!currentPath) return []
    const shortened = shortenPath(currentPath)
    const parts = shortened.split('/').filter(Boolean)
    const isHome = shortened.startsWith('~')
    const homeMatch = currentPath.match(/^\/Users\/[^/]+/)
    const homeDir = homeMatch ? homeMatch[0] : ''

    const result: { name: string; path: string }[] = []
    if (isHome) {
      result.push({ name: '~', path: homeDir })
      const rest = currentPath.slice(homeDir.length)
      const restParts = rest.split('/').filter(Boolean)
      let accumulated = homeDir
      for (const part of restParts) {
        accumulated = accumulated + '/' + part
        result.push({ name: part, path: accumulated })
      }
    } else {
      result.push({ name: '/', path: '/' })
      let accumulated = ''
      for (const part of parts) {
        accumulated += '/' + part
        result.push({ name: part, path: accumulated })
      }
    }

    if (result.length > 4) {
      const trimmed = result.slice(-4)
      return [{ name: '...', path: result[result.length - 5].path }, ...trimmed]
    }
    return result
  }, [currentPath])

  const filteredItems = useMemo(() => {
    if (!searchText) return items
    const q = searchText.toLowerCase()
    return items.filter((item) => item.name.toLowerCase().includes(q))
  }, [items, searchText])

  const directories = useMemo(() => filteredItems.filter((i) => i.isDirectory), [filteredItems])
  const files = useMemo(() => filteredItems.filter((i) => !i.isDirectory), [filteredItems])

  const handleItemClick = (item: FileEntry) => {
    if (item.isDirectory) {
      navigateTo(item.path)
    } else {
      setPreviewFile(item)
      pushFBState(currentPath, { path: item.path, name: item.name })
    }
  }

  // If previewing a file, show the preview
  if (previewFile) {
    return (
      <FilePreview
        filePath={previewFile.path}
        fileName={previewFile.name}
        onBack={() => history.back()}
      />
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="shrink-0"
            title="Back to chat"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 overflow-hidden">
            <h2 className="text-sm font-medium truncate">Files</h2>
            <p className="text-xs text-muted-foreground truncate max-w-[200px]">
              {shortenPath(currentPath)}
            </p>
          </div>
        </div>
      </header>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-4 py-2 border-b bg-muted/30 overflow-x-auto shrink-0">
        {canGoBack && (
          <button
            onClick={() => history.back()}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
          </button>
        )}
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1 shrink-0">
            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
            <button
              onClick={() => {
                if (seg.path !== currentPath) navigateTo(seg.path)
              }}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                i === segments.length - 1
                  ? 'font-semibold text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {seg.name}
            </button>
          </span>
        ))}
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/50">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Filter files..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
          />
          {searchText && (
            <button onClick={() => setSearchText('')}>
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            {searchText ? (
              <>
                <Search className="h-8 w-8 mb-3 opacity-30" />
                <p className="text-sm">No matching files</p>
              </>
            ) : (
              <>
                <Folder className="h-8 w-8 mb-3 opacity-30" />
                <p className="text-sm">Empty directory</p>
              </>
            )}
          </div>
        ) : (
          <div className="px-2 pb-4">
            {/* Directories */}
            {directories.map((item) => (
              <button
                key={item.path}
                onClick={() => handleItemClick(item)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors text-left group"
              >
                {getFileIcon(item)}
                <span className="flex-1 text-sm truncate">{item.name}</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground/60" />
              </button>
            ))}
            {/* Files */}
            {files.map((item) => (
              <button
                key={item.path}
                onClick={() => handleItemClick(item)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors text-left group"
              >
                {getFileIcon(item)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{item.name}</p>
                  {item.size != null && (
                    <p className="text-xs text-muted-foreground/50">{formatSize(item.size)}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
