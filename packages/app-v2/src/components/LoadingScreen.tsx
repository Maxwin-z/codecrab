import { Loader2 } from 'lucide-react'

export function LoadingScreen() {
  return (
    <div className="h-dvh flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  )
}
