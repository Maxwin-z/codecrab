import { useSearchParams } from 'react-router'
import { FileBrowserPanel } from './FileBrowserPanel'

export function FileBrowserPage() {
  const [searchParams] = useSearchParams()
  const path = searchParams.get('path') ?? ''

  return (
    <div className="h-dvh flex bg-background text-foreground overflow-hidden">
      <FileBrowserPanel projectPath={path} fullPage />
    </div>
  )
}
