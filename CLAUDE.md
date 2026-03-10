# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeClaws is an AI-powered coding engine — a monorepo with 6 TypeScript packages providing a server, React chat UI, documentation site, relay server, CLI, and shared library.

## Commands

```bash
pnpm install              # Install all dependencies
pnpm dev                  # Run server + app + web concurrently
pnpm dev:server           # Server only (port 4200)
pnpm dev:app              # React app only (port 5730, proxies API to server)
pnpm dev:web              # Docs site only (port 5731)
pnpm dev:relay            # Relay server only
pnpm build                # TypeScript build all packages (pnpm -r build)
pnpm start                # Start server in production mode
```

No test or lint commands are configured yet.

## Architecture

**Monorepo:** pnpm workspaces, TypeScript 5.9.3 (strict, ES2022, bundler module resolution), Vite 7.3.1 for frontends, tsx for backend dev.

**Packages and dependency flow:**
```
cli → server, shared
server → shared, express
app → shared, react
relay → shared
web → (standalone)
shared → (no internal deps)
```

**Server (`packages/server`)** — Express 5 + WebSocket on port 4200. Key subsystems:
- `src/engine/` — EngineAdapter interface with ClaudeAdapter implementation. Streaming events: text_delta, thinking_delta, tool_use, tool_result.
- `src/ws/` — WebSocket connection & message routing (bidirectional protocol defined in shared/protocol.ts).
- `src/api/` — REST routes for projects, models, sessions, files.
- `src/auth/` — Token-based auth (middleware + WS upgrade hook).
- `src/mcp/` — MCP extensions: cron (scheduled tasks), push (web push notifications), chrome (DevTools Protocol automation).

**App (`packages/app`)** — React 19 chat UI. Vite proxies `/api` and `/ws` to the server. Components: ChatPage, InputBar, MessageList, ModelSelector, SessionSidebar, SetupWizard, FileBrowser, ProjectList. State via hooks (useWebSocket, WebSocketContext).

**Web (`packages/web`)** — Static documentation/setup guide site. Pages: Home, Setup, Docs, Plugins.

**Relay (`packages/relay`)** — Public relay for remote/LAN access. Handles tunnel auth, subdomain/path-based routing.

**CLI (`packages/cli`)** — Commands: setup, start, stop, status, models, token, open. Interactive setup wizard.

**Shared (`packages/shared`)** — WebSocket message protocol types, model configuration types, project/session types.

## WebSocket Protocol

Client→Server: prompt, command, set_cwd, abort, resume_session, respond_question, respond_permission
Server→Client: stream_delta, assistant_text, thinking, tool_use, tool_result, result, permission_request

## Configuration Files

User config stored in `~/.codeclaws/`:
- `config.json` — access token, network mode
- `models.json` — model configurations (API keys, base URLs)
- `projects.json` — project definitions
- `sessions/` — session state
- `cron/` — cron job history (JSONL)

## TypeScript

Root `tsconfig.json` is the base config. Each package extends it with its own `tsconfig.json` using composite project references. App uses path alias `@/*` → `./src/*`.
