import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Plus, FolderUp, Folder, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authFetch } from '@/lib/auth'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface DirListing {
  current: string
  parent: string
  items: FileEntry[]
}

const PROJECT_ICONS = [
  '🌿', '🍀', '🌵', '🌲', '🌳', '🌱', '🌷', '🌹', '🌺', '🌸', '🌻', '🪴',
  '💻', '🚀', '⚡', '🔥', '⭐', '🎯', '🎨', '🎮', '📱', '🔧', '🛠️', '⚙️', '💡', '🤖',
  '🎭', '🎸', '🎹', '🎲', '🧸', '🦄', '🎬', '✨', '🎊', '🔮',
  '🏠', '🏢', '🏗️', '🏭', '🏛️', '🏫', '⛪', '🏯',
  '💰', '💎', '🔑', '🎁', '📚', '📖', '✏️', '🔒', '❤️', '💛', '💚', '💙',
  '🐶', '🐱', '🦊', '🐼', '🐨', '🦁', '🐸', '🐙',
  '🍎', '🍊', '🍋', '🍇', '🍓', '🥑', '🍆', '🍔',
  '☀️', '🌙', '☁️', '🌧️', '🌈', '❄️',
]

function getDirName(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || ''
}

export function CreateProjectPage({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const navigate = useNavigate()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [selectedIcon, setSelectedIcon] = useState('🚀')
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [creating, setCreating] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const listingRef = useRef<DirListing | null>(null)

  useEffect(() => {
    listingRef.current = listing
  }, [listing])

  const fetchDir = useCallback(async (dirPath?: string, addToHistory = true) => {
    setLoading(true)
    setError(null)
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''
      const res = await authFetch(`/api/files${params}`, {}, onUnauthorized)
      if (!res.ok) throw new Error('Failed to list directory')
      const data: DirListing = await res.json()
      const currentListing = listingRef.current
      if (addToHistory && currentListing && data.current !== currentListing.current) {
        setHistory(prev => [...prev, currentListing.current])
      }
      setListing(data)
      const dirName = getDirName(data.current)
      if (dirName) setProjectName(dirName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => { fetchDir() }, [fetchDir])

  useEffect(() => {
    if (isCreatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus()
    }
  }, [isCreatingFolder])

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !listing) return
    setCreateFolderError(null)
    try {
      const res = await authFetch('/api/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: listing.current, name: newFolderName.trim() }),
      }, onUnauthorized)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create folder')
      }
      setNewFolderName('')
      setIsCreatingFolder(false)
      await fetchDir(listing.current, false)
    } catch (err) {
      setCreateFolderError(err instanceof Error ? err.message : 'Failed')
    }
  }

  const cancelCreateFolder = () => {
    setIsCreatingFolder(false)
    setNewFolderName('')
    setCreateFolderError(null)
  }

  const handleGoBack = () => {
    if (history.length === 0) return
    const previousPath = history[history.length - 1]
    setHistory(prev => prev.slice(0, -1))
    fetchDir(previousPath, false)
  }

  const handleCreate = async () => {
    if (!listing || !projectName.trim()) return
    try {
      setCreating(true)
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName.trim(),
          path: listing.current,
          icon: selectedIcon,
        }),
      }, onUnauthorized)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create project')
      }
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
      setCreating(false)
    }
  }

  const directories = listing?.items.filter(item => item.isDirectory) ?? []

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => {
            if (history.length > 0) {
              handleGoBack()
            } else {
              navigate('/')
            }
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold">New Project</h1>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Current path + actions */}
        {listing && (
          <div className="px-4 py-2.5 border-b bg-secondary/30 shrink-0">
            <div className="text-xs text-muted-foreground font-mono truncate">{listing.current}</div>
            <div className="flex gap-2 mt-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setIsCreatingFolder(true)}
              >
                <Plus className="h-3 w-3" />
                New folder
              </Button>
            </div>
          </div>
        )}

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          )}
          {error && (
            <div className="px-4 py-3 text-destructive text-sm">{error}</div>
          )}
          {listing && (
            <div className="divide-y">
              {isCreatingFolder && (
                <div className="px-4 py-3 bg-secondary/20">
                  <div className="flex gap-2">
                    <Input
                      ref={newFolderInputRef}
                      value={newFolderName}
                      onChange={e => setNewFolderName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleCreateFolder()
                        if (e.key === 'Escape') cancelCreateFolder()
                      }}
                      placeholder="Folder name"
                      className="h-8 text-sm"
                    />
                    <Button size="sm" className="h-8" onClick={handleCreateFolder}>Create</Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={cancelCreateFolder}>Cancel</Button>
                  </div>
                  {createFolderError && (
                    <p className="text-destructive text-xs mt-2">{createFolderError}</p>
                  )}
                </div>
              )}

              {listing.current !== listing.parent && (
                <button
                  type="button"
                  onClick={() => fetchDir(listing.parent)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer"
                >
                  <FolderUp className="h-4 w-4" />
                  <span className="text-sm">Go up</span>
                </button>
              )}

              {directories.map(item => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => fetchDir(item.path)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm truncate">{item.name}</span>
                </button>
              ))}

              {directories.length === 0 && !isCreatingFolder && (
                <div className="px-4 py-8 text-center text-muted-foreground text-sm">
                  No subdirectories
                </div>
              )}
            </div>
          )}
        </div>

        {/* Project config - fixed at bottom */}
        <div className="p-4 border-t bg-secondary/10 shrink-0">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium">Project Name</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowIconPicker(!showIconPicker)}
                  className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border bg-card hover:bg-accent/50 transition-colors text-xl cursor-pointer"
                >
                  {selectedIcon}
                </button>
                <Input
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  placeholder="Enter project name"
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreate()
                  }}
                />
              </div>

              {showIconPicker && (
                <div className="p-2 rounded-lg border bg-card max-h-48 overflow-y-auto">
                  <div className="grid grid-cols-10 gap-1">
                    {PROJECT_ICONS.map((icon, i) => (
                      <button
                        key={`${icon}-${i}`}
                        type="button"
                        onClick={() => { setSelectedIcon(icon); setShowIconPicker(false) }}
                        className={`p-1.5 rounded hover:bg-accent transition-colors text-lg cursor-pointer ${
                          selectedIcon === icon ? 'bg-primary/10 ring-1 ring-primary/30' : ''
                        }`}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {listing && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium">Path:</span>
                <span className="font-mono truncate">{listing.current}</span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" onClick={() => navigate('/')} className="flex-1">
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!projectName.trim() || !listing || creating}
                className="flex-1"
              >
                {creating ? 'Creating...' : 'Create Project'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
