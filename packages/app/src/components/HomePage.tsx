import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface HomePageProps {
  onOpenSetup: () => void
}

export function HomePage({ onOpenSetup }: HomePageProps) {
  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <h1 className="text-lg font-semibold tracking-tight">CodeClaws</h1>
        <Button variant="ghost" size="icon" onClick={onOpenSetup} aria-label="Settings">
          <Settings className="h-5 w-5" />
        </Button>
      </header>

      {/* Main content area — placeholder for future chat UI */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <h2 className="text-xl font-medium mb-2">Ready to go</h2>
          <p className="text-muted-foreground text-sm">
            Your model is configured. Start a conversation or manage settings from the top-right corner.
          </p>
        </div>
      </main>
    </div>
  )
}
