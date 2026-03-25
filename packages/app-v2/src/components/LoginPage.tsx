import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { verifyToken, setToken } from '@/lib/auth'
import { Loader2 } from 'lucide-react'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return

    setLoading(true)
    setError('')

    const valid = await verifyToken(token.trim())
    if (valid) {
      setToken(token.trim())
      onLogin()
    } else {
      setError('Invalid token')
    }
    setLoading(false)
  }

  return (
    <div className="h-dvh flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">CodeCrab v2</h1>
          <p className="text-muted-foreground text-sm">Enter your access token to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Access token"
            value={token}
            onChange={e => setTokenValue(e.target.value)}
            autoFocus
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !token.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  )
}
