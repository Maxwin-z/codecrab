// MCP extension registry
//
// Responsibilities:
//   1. Register MCP sub-modules (cron, push, chrome, ...)
//   2. Create MCP server instances per session
//   3. Route MCP tool calls to the correct sub-module
//   4. Manage MCP server lifecycle (start/stop)
//
// Each MCP sub-module exports:
//   - routes: Express router for REST endpoints
//   - createMcpServer: factory function for MCP server instance
