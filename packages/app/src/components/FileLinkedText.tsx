// FileLinkedText — renders text with detected file paths as clickable links
// Probes the server to verify file existence, then highlights valid paths.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { authFetch } from '@/lib/auth'
import { FilePreviewModal } from './FilePreviewModal'

// File extensions to detect
const DETECTABLE_EXTS =
  'png|jpg|jpeg|gif|svg|webp|ico|bmp|' +       // images
  'mp4|mov|avi|mkv|webm|mp3|wav|m4a|' +         // media
  'md|markdown|mdx|' +                           // markdown
  'ts|tsx|js|jsx|mjs|cjs|' +                     // javascript/typescript
  'py|pyw|rb|go|rs|java|kt|scala|' +             // other languages
  'swift|m|h|c|cpp|cc|cxx|cs|' +                 // c-family + swift
  'html|htm|css|scss|less|' +                     // web
  'json|yaml|yml|toml|xml|graphql|gql|' +        // data/config
  'sh|bash|zsh|fish|' +                           // shell
  'sql|r|lua|php|pl|ex|exs|erl|' +              // misc languages
  'txt|csv|log|env|ini|cfg|conf|' +              // text/config
  'dockerfile|makefile|' +                        // special files
  'pdf'                                           // documents

// Match absolute paths ending with known file extensions.
// Also match paths with :line_number suffix (e.g. /path/to/file.ts:42)
const FILE_PATH_RE = new RegExp(
  `((?:/[\\w@.+-]+)+\\.(?:${DETECTABLE_EXTS}))(?::(\\d+))?\\b`,
  'gi'
)

interface FileLinkedTextProps {
  text: string
  className?: string
}

interface PathSegment {
  type: 'text' | 'path'
  value: string
  lineNumber?: number
}

// Probe cache to avoid re-probing the same paths
const probeCache = new Map<string, boolean>()

export function FileLinkedText({ text, className }: FileLinkedTextProps) {
  const [existingPaths, setExistingPaths] = useState<Set<string>>(new Set())
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [probed, setProbed] = useState(false)
  const textRef = useRef(text)
  textRef.current = text

  // Parse text into segments
  const segments = useMemo((): PathSegment[] => {
    const result: PathSegment[] = []
    let lastIndex = 0
    // Reset regex state
    FILE_PATH_RE.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      // Add preceding text
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: text.slice(lastIndex, match.index) })
      }
      result.push({
        type: 'path',
        value: match[1],
        lineNumber: match[2] ? parseInt(match[2], 10) : undefined,
      })
      lastIndex = match.index + match[0].length
    }

    // Add remaining text
    if (lastIndex < text.length) {
      result.push({ type: 'text', value: text.slice(lastIndex) })
    }

    return result
  }, [text])

  // Extract unique paths from segments
  const detectedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const seg of segments) {
      if (seg.type === 'path') paths.add(seg.value)
    }
    return paths
  }, [segments])

  // Probe server for file existence
  useEffect(() => {
    if (detectedPaths.size === 0) {
      setProbed(true)
      return
    }

    // Check cache first
    const uncached: string[] = []
    const cached = new Set<string>()
    for (const p of detectedPaths) {
      if (probeCache.has(p)) {
        if (probeCache.get(p)) cached.add(p)
      } else {
        uncached.push(p)
      }
    }

    if (uncached.length === 0) {
      setExistingPaths(cached)
      setProbed(true)
      return
    }

    authFetch('/api/files/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: uncached }),
    })
      .then((r) => r.json())
      .then((data: { results: Record<string, { exists: boolean; isFile: boolean }> }) => {
        const newExisting = new Set(cached)
        for (const [p, info] of Object.entries(data.results)) {
          probeCache.set(p, info.exists && info.isFile)
          if (info.exists && info.isFile) newExisting.add(p)
        }
        // Only update if text hasn't changed
        if (textRef.current === text) {
          setExistingPaths(newExisting)
        }
      })
      .catch(() => {
        // On error, just use cached results
        if (textRef.current === text) {
          setExistingPaths(cached)
        }
      })
      .finally(() => {
        if (textRef.current === text) {
          setProbed(true)
        }
      })
  }, [detectedPaths, text])

  const handlePathClick = useCallback((path: string) => {
    setPreviewPath(path)
  }, [])

  // If no paths detected, render plain text
  if (detectedPaths.size === 0) {
    return <span className={className}>{text}</span>
  }

  return (
    <>
      <span className={className}>
        {segments.map((seg, i) => {
          if (seg.type === 'text') {
            return <span key={i}>{seg.value}</span>
          }
          // Path segment: only make clickable if confirmed to exist
          const exists = existingPaths.has(seg.value)
          if (exists) {
            return (
              <span
                key={i}
                onClick={() => handlePathClick(seg.value)}
                className="text-blue-500 dark:text-blue-400 underline decoration-blue-500/30 hover:decoration-blue-500 cursor-pointer transition-colors hover:text-blue-600 dark:hover:text-blue-300"
                title={`Preview ${seg.value}`}
              >
                {seg.value}
                {seg.lineNumber != null && `:${seg.lineNumber}`}
              </span>
            )
          }
          // Not probed yet or doesn't exist — render as plain text
          return (
            <span key={i}>
              {seg.value}
              {seg.lineNumber != null && `:${seg.lineNumber}`}
            </span>
          )
        })}
      </span>

      {/* Preview modal */}
      {previewPath && (
        <FilePreviewModal
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  )
}
