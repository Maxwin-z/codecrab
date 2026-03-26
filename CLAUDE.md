# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeCrab is an AI-powered coding engine — a monorepo with 6 TypeScript packages and a native iOS app, providing a server, React chat UI, iOS chat UI, documentation site, relay server, CLI, and shared library.

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

**Testing (server only):**
```bash
cd packages/server
pnpm test                 # Run tests once (vitest)
pnpm test:watch           # Watch mode
```

No lint commands are configured yet.

## Architecture

**Monorepo:** pnpm workspaces, TypeScript 5.9.3 (strict, ES2022, bundler module resolution), Vite 7.3.1 for frontends, tsx for backend dev.

**Packages and dependency flow:**
```
cli → server, shared
server → shared, express          (legacy — frozen, do NOT modify)
server-v2 → shared, express       (active — all server changes go here)
app → shared, react               (legacy — frozen, do NOT modify)
app-v2 → shared, react            (active — all frontend changes go here)
iOS → server (via API/WS)
relay → shared
web → (standalone)
shared → (no internal deps)
```

> **IMPORTANT:** `packages/server` and `packages/app` are legacy (frozen). All new server-side changes MUST go into `packages/server-v2`, all new frontend changes MUST go into `packages/app-v2`. Do NOT modify the legacy packages.

**Server v2 (`packages/server-v2`)** — Four-layer architecture on port 4200:
- **Agent** (`src/agent/`) — Pure SDK wrapper (`ClaudeAgent`). Translates SDK messages into `AgentStreamEvent` via AsyncChannel. Handles permission/question blocking with promise-based resolvers.
- **Core** (`src/core/`) — State & orchestration (`CoreEngine` extends EventEmitter). Three managers:
  - `ProjectManager` — Project CRUD, provider config resolution, env building
  - `SessionManager` — Session lifecycle: create (temporary `pending-xxx` ID) → register (real SDK ID) → persist. Metadata: provider, permissionMode, usage stats
  - `TurnManager` — Query execution via `QueryQueue` (per-project, priority-based). Streams `AgentStreamEvent` → emits core events
- **Gateway** (`src/gateway/`) — HTTP/WS protocol layer:
  - `ws.ts` — WebSocket message dispatch (prompt, abort, new_session, resume_session, switch_project, set_provider, etc.)
  - `broadcaster.ts` — Subscribes to all core events, translates to `ServerMessage`, broadcasts to project subscribers
  - `heartbeat.ts` — Activity tracking & throttled heartbeat broadcasts
  - `http.ts` — REST API routes (projects, sessions, providers, files)
  - `auth.ts` — Token verification
- **Consumers** — Soul module (`src/soul/`) and Cron scheduler (`src/cron/`) subscribe to core events

**Server (legacy) (`packages/server`)** — Express 5 + WebSocket, monolithic `ws/index.ts`. Frozen — do not modify.

**App v2 (`packages/app-v2`)** — React 19 chat UI (port 5740). Vite proxies `/api` and `/ws` to server on port 4200. Key files:
- `src/hooks/useWebSocket.ts` — WebSocket connection, message handling, project state management (`ProjectChatState`)
- `src/hooks/WebSocketContext.tsx` — React context provider
- `src/components/ChatPage.tsx` — Main chat page with session management, provider selector, input/output
- `src/components/MessageList.tsx` — Message rendering with streaming support
- `src/components/SessionSidebar.tsx` — Session list and selection
- `src/components/InputBar.tsx` — User input with image attachments

**App (legacy) (`packages/app`)** — React 19 chat UI (port 5730). Frozen — do not modify.

**iOS (`packages/iOS`)** — Native iOS/macOS app (Swift, SwiftUI, Xcode project). Provides the same chat UI functionality as the web app, connecting to the server via REST API and WebSocket.

**Web (`packages/web`)** — Static documentation/setup guide site. Pages: Home, Setup, Docs, Plugins.

**Relay (`packages/relay`)** — Public relay for remote/LAN access. Handles tunnel auth, subdomain/path-based routing.

**CLI (`packages/cli`)** — Commands: setup, start, stop, status, models, token, open. Interactive setup wizard.

**Shared (`packages/shared`)** — WebSocket message protocol types, model configuration types, project/session types.

## WebSocket Protocol

Client→Server: prompt, command, set_cwd, abort, resume_session, respond_question, respond_permission, set_model, set_permission_mode, switch_project, probe_sdk
Server→Client: system, stream_delta, assistant_text, thinking, tool_use, tool_result, result, query_start, query_end, query_summary, query_suggestions, query_queue_status, query_queued, cleared, aborted, cwd_changed, error, session_resumed, session_created, session_status_changed, ask_user_question, model_changed, permission_mode_changed, permission_request, message_history, message_history_chunk, user_message, available_models, project_statuses, cron_task_completed, activity_heartbeat, sdk_event, sdk_event_history

## Authentication

All API requests and WebSocket connections must include the access token:

**REST API:** Include token in `Authorization: Bearer <token>` header
```typescript
import { authFetch } from '@/lib/auth'
const res = await authFetch('/api/projects')
```

**WebSocket:** Include token in query param
```typescript
const ws = new WebSocket(`ws://host/ws?token=${getToken()}`)
```

**Protected Endpoints:**
- `/api/*` (except `/api/auth/*` and `/api/setup/detect*`) — requires Bearer token
- `/ws` — requires `token` query parameter

**Public Endpoints (no token required):**
- `GET /api/auth/status` — check auth configuration
- `POST /api/auth/verify` — verify a token (for login page)
- `POST /api/auth/refresh` — generate a new token (requires current valid token in body)
- `GET /api/setup/detect` — check if Claude Code is installed
- `GET /api/setup/detect/probe` — full probe of CLI availability
- `GET /api/discovery` — service discovery (returns service name and version)
- `GET /api/health` — health check

## Configuration Files

User config stored in `~/.codecrab/`:
- `config.json` — access token, network mode
- `models.json` — model configurations (API keys, base URLs)
- `projects.json` — project definitions
- `sessions/` — session state
- `cron/` — cron job history (JSONL)

## TypeScript

Root `tsconfig.json` is the base config. Each package extends it with its own `tsconfig.json` using composite project references. App uses path alias `@/*` → `./src/*`.
