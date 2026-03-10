// ClaudeAdapter — Claude Code SDK implementation of EngineAdapter
//
// Wraps @anthropic-ai/claude-agent-sdk to conform to the EngineAdapter interface.
//
// Responsibilities:
//   1. Initialize Claude SDK with API key, base URL, config dir
//   2. Create/resume/destroy sessions via SDK
//   3. Execute queries with streaming (text, thinking, tool_use, tool_result)
//   4. Create MCP servers (cron, push) per session
//   5. Handle permission requests and user questions
//   6. Track cost/duration per query
//
// Migration note:
//   This file absorbs the core logic from the POC's server/claude.ts,
//   but strips out all hardcoded account switching (A/B/K).
//   Model selection is now driven by ModelConfig from @codeclaws/shared.
