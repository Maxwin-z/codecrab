// Model configuration types
//
// A "model" in CodeClaws is an account configuration — it points to either:
//   1. A Claude Code config directory (~/.claude) where the CLI handles auth, or
//   2. A manual API key for direct provider access.

export interface ModelConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'google' | 'custom'
  /** Claude Code config directory (e.g. ~/.claude). When set, auth is handled by the CLI. */
  configDir?: string
  /** API key for manual/direct provider access. Optional when configDir is used. */
  apiKey?: string
  baseUrl?: string
}

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
