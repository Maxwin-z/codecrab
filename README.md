# CodeCrab

AI-powered coding engine — a monorepo with server, React chat UI, iOS app, documentation site, relay server, CLI, and shared library.

## Quick Start

### Global Install (npm)

```bash
npm install -g codecrab
```

```bash
codecrab init              # Generate token, start server, open browser for setup
codecrab start             # Start server only
codecrab start --open      # Start server and open browser
codecrab token             # Show current access token
codecrab token refresh     # Generate a new access token
codecrab --help            # Show help
codecrab --version         # Show version
```

`codecrab init` will:
1. Generate a random access token and save to `~/.codecrab/config.json`
2. Start the server at `http://localhost:4200`
3. Open your browser with the token, auto-login and redirect to the setup page
4. You can then configure model API keys in the web UI

### Local Development

**Prerequisites:** Node.js 20+, pnpm 10+

```bash
git clone <repo-url>
cd codecrab
pnpm install
```

**Development servers:**

```bash
pnpm dev                   # Run server + app + web concurrently
pnpm dev:server            # Server only (port 4200)
pnpm dev:app               # React app only (port 5730, proxies API to server)
pnpm dev:web               # Docs site only (port 5731)
pnpm dev:relay             # Relay server only
```

**CLI (local):**

```bash
pnpm cli init              # Initialize: generate token, start server, open browser
pnpm cli start             # Start server
pnpm cli start --open      # Start server and open browser
pnpm cli token             # Show access token
pnpm cli token refresh     # Regenerate access token
```

**Build:**

```bash
pnpm build                 # TypeScript build all packages
pnpm start                 # Start server in production mode
```

**Testing:**

```bash
cd packages/server
pnpm test                  # Run tests once (vitest)
pnpm test:watch            # Watch mode
```

## Architecture

Monorepo using pnpm workspaces, TypeScript 5.9, Vite 7 for frontends, tsx for backend dev.

```
packages/
├── cli/      → CLI entry point (codecrab command)
├── server/   → Express 5 + WebSocket server (port 4200)
├── app/      → React 19 chat UI
├── iOS/      → Native iOS/macOS app (Swift, SwiftUI)
├── web/      → Documentation site
├── relay/    → Public relay for remote/LAN access
└── shared/   → Shared types and protocol definitions
```

**Dependency flow:**

```
cli → server, shared
server → shared, express, claude-agent-sdk
app → shared, react
iOS → server (via API/WS)
relay → shared
web → (standalone)
shared → (no internal deps)
```

## Configuration

All user config is stored in `~/.codecrab/`:

| File | Description |
|------|-------------|
| `config.json` | Access token, network mode |
| `models.json` | Model configurations (API keys, base URLs) |
| `projects.json` | Project definitions |
| `sessions/` | Persisted session state |
| `cron/` | Cron job history |

## Authentication

All API and WebSocket connections require an access token.

- **REST API:** `Authorization: Bearer <token>` header
- **WebSocket:** `ws://host/ws?token=<token>` query parameter
- **Health/discovery endpoints** are public (no token required)

## License

MIT
