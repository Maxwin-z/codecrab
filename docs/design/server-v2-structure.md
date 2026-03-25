# server-v2 File Structure

> Four-layer architecture: Gateway / Core / Agent / Soul+Cron
> 31 source files, 8 test files, 168 tests, 6753 lines total

```
packages/server-v2/
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
└── src/
    ├── index.ts                                  (59 lines)   Entry point — boot sequence
    ├── types/
    │   └── index.ts                             (449 lines)   Shared types, CoreEventMap, AgentStreamEvent
    │
    ├── agent/                                                  Layer 1 — Pure SDK wrapper, no state
    │   ├── index.ts                             (630 lines)   ClaudeAgent — AsyncChannel-based SDK wrapper
    │   └── extensions/
    │       ├── index.ts                          (93 lines)   MCP extension registry
    │       ├── chrome/tools.ts                    (6 lines)   Chrome DevTools tools (placeholder)
    │       ├── cron/tools.ts                      (6 lines)   Cron tools (placeholder)
    │       └── push/tools.ts                      (6 lines)   Push notification tools (placeholder)
    │
    ├── core/                                                   Layer 2 — Domain state, EventEmitter
    │   ├── index.ts                              (46 lines)   CoreEngine — typed EventEmitter facade
    │   ├── project.ts                            (80 lines)   ProjectManager — config from ~/.codecrab/
    │   ├── session.ts                           (192 lines)   SessionManager — SDK SoT + extension meta
    │   ├── turn.ts                              (429 lines)   TurnManager — turn lifecycle orchestration
    │   ├── queue.ts                             (308 lines)   QueryQueue — per-project FIFO + timeout
    │   └── __tests__/
    │       ├── project.test.ts                  (259 lines)   16 tests — load, list, get, model defaults
    │       ├── queue.test.ts                    (446 lines)   28 tests — FIFO, priority, timeout, pause/resume
    │       ├── session.test.ts                  (358 lines)   26 tests — create, register, usage, persist/load
    │       └── turn.test.ts                     (550 lines)   27 tests — stream events, status transitions, abort
    │
    ├── gateway/                                                Layer 3 — Client connections, thin routing
    │   ├── index.ts                              (51 lines)   setupGateway() — wires Express, WS, Broadcaster
    │   ├── ws.ts                                (335 lines)   WebSocket server + client message routing
    │   ├── http.ts                               (81 lines)   REST routes (health, auth, projects, sessions)
    │   ├── broadcaster.ts                       (291 lines)   Core events → client WebSocket push
    │   ├── heartbeat.ts                          (97 lines)   Throttled activity heartbeat broadcast
    │   ├── auth.ts                               (87 lines)   Token auth (HTTP middleware + WS verification)
    │   └── __tests__/
    │       ├── broadcaster.test.ts              (638 lines)   32 tests — event mapping, project routing, skipping
    │       └── heartbeat.test.ts                (469 lines)   16 tests — throttling, activity types, cleanup
    │
    ├── soul/                                                   Consumer — Persona evolution
    │   ├── agent.ts                              (34 lines)   turn:close subscriber → evolution trigger
    │   ├── settings.ts                           (39 lines)   Soul enable/disable persistence
    │   └── __tests__/
    │       └── soul.test.ts                     (151 lines)   6 tests — filter logic, enable/disable
    │
    └── cron/                                                   Consumer — Scheduled tasks
        ├── scheduler.ts                         (184 lines)   CronScheduler — schedule, pause, resume, trigger
        ├── store.ts                              (54 lines)   CronStore — JSON file persistence
        ├── history.ts                            (39 lines)   CronHistory — JSONL execution log
        └── __tests__/
            └── scheduler.test.ts                (286 lines)   17 tests — schedule, cancel, pause/resume, create
```

## Data Flow

```
User Prompt:
  Client → Gateway(ws) → Core.submitTurn() → Agent.query(SDK) → stream events
                                                    ↓
  Client ← Gateway(broadcaster) ← Core events ← Agent stream

Cron Task:
  CronScheduler → Core.submitTurn() → Agent.query(SDK) → stream events
                                            ↓
  Client ← Gateway(broadcaster) ← Core events

Soul Evolution:
  Core emit turn:close → Soul subscribes → Soul.triggerEvolution()
```

## Test Coverage

| Layer       | Files | Tests | Lines |
|-------------|-------|-------|-------|
| Core        | 4     | 97    | 1,613 |
| Gateway     | 2     | 48    | 1,107 |
| Cron        | 1     | 17    | 286   |
| Soul        | 1     | 6     | 151   |
| **Total**   | **8** | **168** | **3,157** |
