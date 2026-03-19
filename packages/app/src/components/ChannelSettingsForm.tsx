// ChannelSettingsForm — Common settings for channel instances (mode, project, limits)

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface ChannelSettings {
  defaultProjectId: string
  interactiveMode: string
  responseMode: string
  maxMessageLength: string
  projectMapping: string
}

interface ChannelSettingsFormProps {
  settings: ChannelSettings
  onChange: (settings: ChannelSettings) => void
  projects: Array<{ id: string; name: string }>
}

export function ChannelSettingsForm({ settings, onChange, projects }: ChannelSettingsFormProps) {
  const update = (key: keyof ChannelSettings, value: string) => {
    onChange({ ...settings, [key]: value })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Default Project */}
      <div className="flex flex-col gap-1.5">
        <Label>Default Project</Label>
        <Select value={settings.defaultProjectId} onValueChange={v => update('defaultProjectId', v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a project..." />
          </SelectTrigger>
          <SelectContent>
            {projects.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Fallback project when no mapping rule matches</p>
      </div>

      {/* Interactive Mode */}
      <div className="flex flex-col gap-1.5">
        <Label>Interactive Mode</Label>
        <Select value={settings.interactiveMode} onValueChange={v => update('interactiveMode', v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forward">Forward to user</SelectItem>
            <SelectItem value="auto_allow">Auto-allow</SelectItem>
            <SelectItem value="auto_deny">Auto-deny</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">How to handle permission requests and questions</p>
      </div>

      {/* Response Mode */}
      <div className="flex flex-col gap-1.5">
        <Label>Response Mode</Label>
        <Select value={settings.responseMode} onValueChange={v => update('responseMode', v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="streaming">Streaming</SelectItem>
            <SelectItem value="buffered">Buffered</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Streaming sends incremental updates; buffered waits for completion</p>
      </div>

      {/* Max Message Length */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="maxMessageLength">Max Message Length</Label>
        <Input
          id="maxMessageLength"
          type="number"
          value={settings.maxMessageLength}
          onChange={e => update('maxMessageLength', e.target.value)}
          placeholder="4096"
        />
        <p className="text-xs text-muted-foreground">Platform message length limit (optional)</p>
      </div>

      {/* Project Mapping */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="projectMapping">Project Mapping (JSON)</Label>
        <textarea
          id="projectMapping"
          value={settings.projectMapping}
          onChange={e => update('projectMapping', e.target.value)}
          placeholder='[{"projectId": "...", "externalUserIds": ["..."]}]'
          rows={4}
          className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 placeholder:text-muted-foreground font-mono dark:bg-input/30"
        />
        <p className="text-xs text-muted-foreground">Advanced: route users/conversations to specific projects</p>
      </div>
    </div>
  )
}
