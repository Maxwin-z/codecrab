// Model configuration types
//
// Auth is always handled by the Claude Code CLI via ~/.claude (OAuth session).
// CLAUDE_CONFIG_DIR always points to ~/.claude so skills, commands, settings,
// and auth are shared seamlessly between Claude Code CLI and CodeCrab.
//
// For 3rd-party models, apiKey + baseUrl override the API endpoint while
// still using ~/.claude for SDK runtime (skills, commands, etc.).

export interface ProviderConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'google' | 'custom'
  /** @deprecated No longer used. CLAUDE_CONFIG_DIR is always ~/.claude. Kept for backward compat with existing models.json files. */
  configDir?: string
  /** API key for 3rd-party provider access. When omitted, SDK uses CLI's OAuth session from ~/.claude. */
  apiKey?: string
  /** Model identifier for the API (e.g. "claude-sonnet-4-20250514"). */
  modelId?: string
  baseUrl?: string
}

export interface ProviderSettings {
  providers: ProviderConfig[]
  defaultProviderId?: string
}

/** @deprecated Use ProviderConfig instead */
export type ModelConfig = ProviderConfig
/** @deprecated Use ProviderSettings instead */
export interface ModelSettings {
  models: ModelConfig[]
  defaultModelId?: string
}

export interface SetupStatus {
  initialized: boolean
  modelCount: number
}

export interface DetectResult {
  /** ~/.claude directory exists */
  claudeCodeInstalled: boolean
  /** `claude` binary found in PATH */
  cliAvailable: boolean
  /** CLI version string (e.g. "2.1.71") */
  cliVersion?: string
  /** Result from `claude auth status` */
  auth?: {
    loggedIn: boolean
    authMethod?: string
    subscriptionType?: string
  }
  configDir: string
  error?: string
}
