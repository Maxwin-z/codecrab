import { Button } from '@/components/ui/button'
import { Shield, Check, X } from 'lucide-react'
import type { PendingPermission } from '@/store/types'

export function PermissionRequestUI({
  permission,
  onAllow,
  onDeny,
}: {
  permission: PendingPermission
  onAllow: () => void
  onDeny: () => void
}) {
  const inputStr = typeof permission.input === 'string'
    ? permission.input
    : JSON.stringify(permission.input, null, 2)

  return (
    <div className="mx-4 mb-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center gap-2 mb-2">
        <Shield className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">Permission Required</span>
      </div>

      <div className="text-sm mb-2">
        <span className="text-muted-foreground">Tool: </span>
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{permission.toolName}</code>
      </div>

      {permission.reason && (
        <p className="text-sm text-muted-foreground mb-2">{permission.reason}</p>
      )}

      {inputStr && (
        <pre className="text-xs bg-muted/50 rounded p-2 mb-3 overflow-x-auto max-h-40">
          {inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr}
        </pre>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="gap-1" onClick={onAllow}>
          <Check className="h-3.5 w-3.5" />
          Allow
        </Button>
        <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={onDeny}>
          <X className="h-3.5 w-3.5" />
          Deny
        </Button>
      </div>
    </div>
  )
}
