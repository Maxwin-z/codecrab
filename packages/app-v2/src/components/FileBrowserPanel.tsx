import { useState, useEffect, useCallback, useRef } from 'react'
import { authFetch } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ChevronRight,
  ChevronLeft,
  Search,
  X,
  Folder,
  FileText,
  FileCode,
  FileImage,
  File,
  Eye,
  EyeOff,
} from 'lucide-react'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  modifiedAt?: number
}

interface FileListing {
  current: string
  parent?: string
  items: FileEntry[]
}

function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return <Folder className="h-4 w-4 text-blue-500 shrink-0" />
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss'].includes(ext))
    return <FileCode className="h-4 w-4 text-violet-500 shrink-0" />
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext))
    return <FileImage className="h-4 w-4 text-pink-500 shrink-0" />
  if (['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'env', 'lock'].includes(ext))
    return <FileText className="h-4 w-4 text-emerald-500 shrink-0" />
  return <File className="h-4 w-4 text-muted-foreground shrink-0" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildBreadcrumbs(currentPath: string): Array<{ name: string; path: string }> {
  if (!currentPath) return []
  const parts = currentPath.split('/').filter(Boolean)
  const segments: Array<{ name: string; path: string }> = [{ name: '/', path: '/' }]
  let accumulated = ''
  for (const part of parts) {
    accumulated += '/' + part
    segments.push({ name: part, path: accumulated })
  }
  if (segments.length > 4) {
    return [{ name: '...', path: segments[segments.length - 5]?.path ?? '/' }, ...segments.slice(-4)]
  }
  return segments
}

function openFilePreview(filePath: string) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '') || ''
  window.open(`${base}/file-preview?path=${encodeURIComponent(filePath)}`, '_blank')
}

export function FileBrowserPanel({
  projectPath,
  onUnauthorized,
  fullPage = false,
}: {
  projectPath: string
  onUnauthorized?: () => void
  fullPage?: boolean
}) {
  const [currentPath, setCurrentPath] = useState(projectPath)
  const [items, setItems] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [navStack, setNavStack] = useState<string[]>([])

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true)
    setSearchText('')
    try {
      const encoded = encodeURIComponent(dirPath)
      const hiddenParam = showHidden ? '&showHidden=1' : ''
      const res = await authFetch(`/api/files?path=${encoded}${hiddenParam}`, {}, onUnauthorized)
      if (res.ok) {
        const data: FileListing = await res.json()
        setCurrentPath(data.current)
        setItems(data.items)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [showHidden, onUnauthorized])

  useEffect(() => {
    loadDir(projectPath)
  }, [projectPath])

  useEffect(() => {
    loadDir(currentPath)
  }, [showHidden])

  const navigateTo = (path: string) => {
    setNavStack(prev => [...prev, currentPath])
    loadDir(path)
  }

  const goBack = () => {
    const prev = navStack[navStack.length - 1]
    if (prev !== undefined) {
      setNavStack(s => s.slice(0, -1))
      loadDir(prev)
    }
  }

  const filteredDirs = items.filter(i => i.isDirectory && (searchText === '' || i.name.toLowerCase().includes(searchText.toLowerCase())))
  const filteredFiles = items.filter(i => !i.isDirectory && (searchText === '' || i.name.toLowerCase().includes(searchText.toLowerCase())))
  const breadcrumbs = buildBreadcrumbs(currentPath)

  return (
    <div className={cn(fullPage ? 'w-full' : 'w-72 border-r border-border shrink-0', 'flex flex-col min-h-0 bg-background')}>
      {/* Header / Breadcrumb */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={navStack.length === 0}
          onClick={goBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <div className="flex items-center gap-0.5 flex-1 overflow-hidden">
          {breadcrumbs.map((seg, idx) => (
            <span key={idx} className="flex items-center gap-0.5 shrink-0">
              {idx > 0 && <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/50" />}
              <button
                className={cn(
                  'text-[10px] px-1 py-0.5 rounded hover:bg-muted/50 truncate max-w-[80px]',
                  idx === breadcrumbs.length - 1 ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
                onClick={() => { if (seg.path !== currentPath) navigateTo(seg.path) }}
                title={seg.path}
              >
                {seg.name}
              </button>
            </span>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          onClick={() => setShowHidden(v => !v)}
        >
          {showHidden
            ? <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
        </Button>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Filter files..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60 min-w-0"
          />
          {searchText && (
            <button onClick={() => setSearchText('')}>
              <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground">Loading...</span>
          </div>
        ) : filteredDirs.length === 0 && filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
            {searchText ? <Search className="h-6 w-6" /> : <Folder className="h-6 w-6" />}
            <span className="text-xs">{searchText ? 'No matching files' : 'Empty directory'}</span>
          </div>
        ) : (
          <div className="py-1">
            {filteredDirs.map(item => (
              <FileRow key={item.path} item={item} onClick={() => navigateTo(item.path)} />
            ))}
            {filteredDirs.length > 0 && filteredFiles.length > 0 && (
              <div className="border-t border-border/50 my-1" />
            )}
            {filteredFiles.map(item => (
              <FileRow key={item.path} item={item} onClick={() => openFilePreview(item.path)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FileRow({ item, onClick }: { item: FileEntry; onClick: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('contextmenu', close)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
    }
  }, [menu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(item.path)
    setMenu(null)
  }

  return (
    <>
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors text-left"
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        {getFileIcon(item.name, item.isDirectory)}
        <span className="flex-1 text-xs truncate">{item.name}</span>
        {item.isDirectory ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        ) : item.size !== undefined ? (
          <span className="text-[10px] text-muted-foreground/60 shrink-0">{formatSize(item.size)}</span>
        ) : null}
      </button>
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1"
          style={{ left: menu.x, top: menu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors"
            onClick={copyPath}
          >
            Copy path
          </button>
        </div>
      )}
    </>
  )
}
