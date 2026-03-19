// ChannelConfigForm — Schema-driven form renderer for channel plugin config fields

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ChannelConfigField } from '@/hooks/useChannels'

interface ChannelConfigFormProps {
  schema: ChannelConfigField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}

export function ChannelConfigForm({ schema, values, onChange }: ChannelConfigFormProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set())

  const toggleReveal = (key: string) => {
    setRevealedSecrets(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const setValue = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="flex flex-col gap-4">
      {schema.map(field => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <Label htmlFor={`config-${field.key}`}>
            {field.label}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          {field.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!values[field.key]}
                onChange={e => setValue(field.key, e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <span className="text-sm text-muted-foreground">{field.description}</span>
            </label>
          ) : field.type === 'secret' ? (
            <div className="relative">
              <Input
                id={`config-${field.key}`}
                type={revealedSecrets.has(field.key) ? 'text' : 'password'}
                value={(values[field.key] as string) || ''}
                onChange={e => setValue(field.key, e.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => toggleReveal(field.key)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {revealedSecrets.has(field.key)
                  ? <EyeOff className="h-4 w-4" />
                  : <Eye className="h-4 w-4" />
                }
              </button>
            </div>
          ) : (
            <Input
              id={`config-${field.key}`}
              type={field.type === 'number' ? 'number' : 'text'}
              value={(values[field.key] as string | number) ?? ''}
              onChange={e => setValue(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
            />
          )}
          {field.description && field.type !== 'boolean' && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
        </div>
      ))}
    </div>
  )
}
