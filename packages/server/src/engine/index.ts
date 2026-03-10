// Engine registry — register and resolve engine adapters
//
// Responsibilities:
//   1. Register available engine adapters (claude, opencode, ...)
//   2. Resolve adapter by model config
//   3. Manage adapter lifecycle (init/dispose)
//
// Usage:
//   registerEngine('claude', new ClaudeAdapter())
//   const engine = getEngine('claude')
