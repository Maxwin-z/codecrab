// Cron MCP — Scheduled task management
//
// Components:
//   scheduler.ts  — node-cron task scheduling
//   executor.ts   — WebSocket-based execution dispatch
//   store.ts      — JSON file persistence (~/.codeclaws/cron/)
//   routes.ts     — REST endpoints (/api/cron/*)
//   mcp-server.ts — MCP tool definitions (cron_create, cron_list, cron_get, cron_delete)
//
// Supports:
//   - One-time (at), recurring (every), cron expression schedules
//   - Natural language parsing via chrono-node
//   - Run history stored as JSONL per job
