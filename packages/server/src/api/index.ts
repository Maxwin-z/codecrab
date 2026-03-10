// REST API routes — Express router registration
//
// All routes are prefixed with /api
//
// Sub-routers:
//   /api/models    — Model CRUD, default/project-level config (models.ts)
//   /api/projects  — Project CRUD (projects.ts)
//   /api/sessions  — Session listing and status (sessions.ts)
//   /api/files     — Directory browsing, search, mkdir (files.ts)
//   /api/push      — Push notification subscribe/unsubscribe/send (mcp/push)
//   /api/chrome    — Chrome status/start/stop (mcp/chrome)
//   /api/cron      — Cron execute/result/schedule/health (mcp/cron)
//   /api/health    — Server health check
