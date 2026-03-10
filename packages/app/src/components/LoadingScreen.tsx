export function LoadingScreen() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6">
        {/* Animated logo / spinner */}
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-muted" />
          <div className="absolute inset-0 rounded-full border-2 border-t-primary animate-spin" />
        </div>
        <div className="flex flex-col items-center gap-1">
          <h1 className="text-xl font-semibold tracking-tight">CodeClaws</h1>
          <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    </div>
  )
}
