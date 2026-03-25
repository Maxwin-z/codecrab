# Server Architecture Refactoring — Design Document

> Date: 2026-03-25
> Status: Draft

## 1. Motivation

当前 `packages/server` 存在明显的架构问题：

- **ws/index.ts (~2200 行)** 承担了 5 个角色：WebSocket 连接管理、Session CRUD + 持久化、Turn 执行编排、Stream 事件广播/心跳、Soul/Push 副作用触发
- **engine/claude.ts** 混合了 SDK 封装、ClientState/ProjectState 管理、模型配置加载
- **无 Service 层**：业务逻辑散布在 ws/、api/、engine/ 之间
- **双重 Session 存储**：CodeCrab 自己维护 `~/.codecrab/sessions/` JSON 文件 + SDK 内部的 `~/.claude/` JSONL transcript，两套数据容易不一致
- **ClientState 定义在 engine，却由 ws 管理**，职责边界模糊

## 2. Design Principles

1. **SDK-first**：以 Claude Agent SDK 为核心，保持与 CLI 一致的行为
2. **单一状态源**：SDK Session 作为 Source of Truth，不再双写消息历史
3. **事件驱动**：Core 层通过 EventEmitter 对外发事件，消费者（Gateway/Soul/Cron）订阅
4. **无状态 Agent 层**：纯 SDK 封装，不持有业务状态
5. **薄 Gateway**：只管客户端连接和消息推送，不包含业务逻辑

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Gateway                                         │
│  ├── ws.ts           WebSocket 连接管理          │
│  ├── http.ts         REST 路由 (薄封装)          │
│  ├── broadcaster.ts  Core 事件 → 客户端推送      │
│  ├── heartbeat.ts    活动心跳, 节流              │
│  └── auth.ts         Token 认证                  │
└──────────────────┬──────────────────────────────┘
                   │ 调用 Core / 订阅 Core 事件
┌──────────────────▼──────────────────────────────┐
│  Core (统一状态管理, EventEmitter)                │
│  ├── project.ts      Project 生命周期 + 默认配置 │
│  ├── session.ts      SDK Session 为 SoT + 元数据 │
│  ├── turn.ts         Turn 生命周期管理           │
│  └── queue.ts        每项目 FIFO 查询队列        │
└──────────────────┬──────────────────────────────┘
                   │ 调用 Agent 执行
┌──────────────────▼──────────────────────────────┐
│  Agent (纯 SDK 封装, 无状态)                      │
│  ├── index.ts        query() / abort()           │
│  └── extensions/     CodeCrab 自定义 MCP         │
│      ├── chrome/     DevTools Protocol           │
│      ├── cron/       定时任务工具                 │
│      └── push/       推送通知工具                 │
└─────────────────────────────────────────────────┘

独立消费者 (订阅 Core 事件):
├── Soul             turn:close → 人格演化
└── CronScheduler    定时触发 → core.submitTurn()
```

### Data Flow

```
用户 Prompt:
  Client → Gateway(ws) → Core.submitTurn() → Agent.query(SDK) → stream events
                                                    ↓
  Client ← Gateway(broadcaster) ← Core events ← Agent stream

Cron 任务:
  CronScheduler → Core.submitTurn() → Agent.query(SDK) → stream events
                                            ↓
  Client ← Gateway(broadcaster) ← Core events

Soul 演化:
  Core emit turn:close → Soul 订阅 → Soul.triggerEvolution() → Agent.query(SDK, internal)
```

## 4. Layer Specifications

### 4.1 Gateway Layer

**职责**：客户端连接管理、认证、消息路由、状态推送。不持有业务状态。

#### 4.1.1 `gateway/ws.ts` — WebSocket Server

```typescript
interface Client {
  ws: WebSocket
  connectionId: string
  clientId: string
  subscribedProjects: Map<string, { sessionId?: string }>
}

// 模块状态：仅连接注册表
const clients = new Map<string, Client>()
```

职责：
- WebSocket 连接建立 / 断开
- 认证检查 (token from query param)
- 收到客户端消息 → 翻译为 Core 调用
- 客户端断开 → 清理连接注册

**不负责**：Session 管理、Query 执行、任何业务逻辑。

#### 4.1.2 `gateway/http.ts` — REST Routes

薄封装，每个 route handler 直接调用 Core：

```typescript
// 示例
router.get('/api/sessions', async (req, res) => {
  const sessions = await core.sessions.list(req.query.projectId)
  res.json(sessions)
})

router.delete('/api/sessions/:id', async (req, res) => {
  await core.sessions.delete(req.params.id)
  res.json({ ok: true })
})
```

#### 4.1.3 `gateway/broadcaster.ts` — 事件推送

订阅 Core 事件，推送到关联的客户端：

```typescript
core.on('turn:delta', (event) => {
  const clients = findClientsForProject(event.projectId)
  for (const client of clients) {
    send(client, {
      type: 'stream_delta',
      deltaType: event.deltaType,
      text: event.text,
      projectId: event.projectId,
      sessionId: event.sessionId,
    })
  }
})

core.on('session:created', (event) => {
  broadcastToProject(event.projectId, {
    type: 'session_created',
    sessionId: event.sessionId,
    projectId: event.projectId,
  })
})
```

#### 4.1.4 `gateway/heartbeat.ts` — 心跳节流

```typescript
const HEARTBEAT_THROTTLE_MS = 10_000
const PERIODIC_HEARTBEAT_INTERVAL_MS = 10_000

// 订阅 Core 的 turn:activity 事件
core.on('turn:activity', (event) => {
  throttledBroadcast(event.projectId, {
    type: 'activity_heartbeat',
    ...event,
  })
})
```

#### 4.1.5 `gateway/auth.ts` — 认证

保持现有逻辑：
- HTTP: `Authorization: Bearer <token>` middleware
- WS: `?token=<token>` query param

---

### 4.2 Core Layer

**职责**：所有领域状态的唯一权威。管理 Project → Session → Turn 生命周期。对外通过 EventEmitter 发布状态变更。

```typescript
// core/index.ts
class CoreEngine extends EventEmitter {
  readonly projects: ProjectManager
  readonly sessions: SessionManager
  readonly turns: TurnManager

  constructor(agent: AgentInterface) {
    this.projects = new ProjectManager()
    this.sessions = new SessionManager()
    this.turns = new TurnManager(agent, this.sessions, this)
  }

  /** 提交一个 Turn — Gateway 和 CronScheduler 都调这个 */
  async submitTurn(params: {
    projectId: string
    sessionId: string
    prompt: string
    type: 'user' | 'cron' | 'channel'
    images?: ImageAttachment[]
    enabledMcps?: string[]
    metadata?: TurnMetadata
  }): Promise<void>
}
```

#### 4.2.1 Core Events Protocol

Core 对外发出的所有事件：

```typescript
interface CoreEvents {
  // Turn 生命周期
  'turn:start':        { projectId, sessionId, turnId, queryId, prompt, type }
  'turn:delta':        { projectId, sessionId, turnId, deltaType: 'text' | 'thinking', text }
  'turn:tool_use':     { projectId, sessionId, turnId, toolName, toolId, input, summary }
  'turn:tool_result':  { projectId, sessionId, turnId, toolId, content, isError }
  'turn:close':        { projectId, sessionId, turnId, result, usage, cost, duration }
  'turn:error':        { projectId, sessionId, turnId, error }
  'turn:activity':     { projectId, sessionId, queryId, elapsedMs, activityType, toolName?, textSnippet? }

  // SDK 原始事件 (debug/高级用)
  'turn:sdk_event':    { projectId, sessionId, turnId, event: DebugEvent }

  // 交互请求 (需要客户端响应)
  'interaction:ask_question':       { projectId, sessionId, turnId, questions }
  'interaction:permission_request': { projectId, sessionId, turnId, requestId, toolName, input, reason? }

  // Session 生命周期
  'session:created':   { projectId, sessionId }
  'session:resumed':   { projectId, sessionId }
  'session:updated':   { projectId, sessionId }

  // Project 状态
  'project:status_changed': { projectId, status, activityType? }
  'project:activity':       { projectId, activityType, toolName?, textSnippet? }

  // Queue 状态
  'queue:status':      { projectId, queryId, status, position?, queueLength? }
}
```

#### 4.2.2 `core/project.ts` — ProjectManager

```typescript
interface ProjectConfig {
  id: string
  name: string
  path: string
  icon: string
  defaultModel: string                // 新 session 的默认 model
  defaultPermissionMode: PermissionMode  // 新 session 的默认 permissionMode
}

class ProjectManager {
  /** 从 ~/.codecrab/projects.json 加载 */
  list(): ProjectConfig[]
  get(projectId: string): ProjectConfig | null
  getPath(projectId: string): string | null

  /** 运行时状态 (活跃 session、队列状态等) */
  getStatus(projectId: string): ProjectStatus
  getAllStatuses(): ProjectStatus[]
}
```

存储位置：`~/.codecrab/projects.json` (保持不变)

#### 4.2.3 `core/session.ts` — SessionManager

**SDK Session 作为 Source of Truth。** 我们只存储 SDK 无法提供的扩展元数据。

```typescript
import { listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk'

/** SDK 提供的 session 信息 */
interface SDKSessionInfo {
  sessionId: string         // UUID
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
}

/** CodeCrab 扩展元数据 (SDK 不提供的部分) */
interface SessionMeta {
  sdkSessionId: string                // 关联到 SDK session UUID
  projectId: string
  status: 'idle' | 'processing' | 'error'
  model: string                       // 创建时锁定, 不可变
  permissionMode: PermissionMode      // session 级别, 可变
  pendingQuestion?: {
    toolId: string
    questions: any[]
  } | null
  pendingPermissionRequest?: {
    requestId: string
    toolName: string
    input: any
    reason?: string
  } | null
  cronJobId?: string
  cronJobName?: string
  createdAt: number
}

class SessionManager {
  // 内存缓存: sdkSessionId → SessionMeta
  private metas = new Map<string, SessionMeta>()

  /** 列出 session — 合并 SDK sessions + 我们的元数据 */
  async list(projectId?: string): Promise<SessionInfo[]> {
    const sdkSessions = await listSessions({ dir: projectId ? getProjectPath(projectId) : undefined })
    return sdkSessions.map(sdk => ({
      ...sdk,
      ...this.metas.get(sdk.sessionId),  // merge 元数据
    }))
  }

  /** 获取消息历史 — 直接从 SDK 读取 */
  async getHistory(sessionId: string): Promise<SessionMessage[]> {
    return getSessionMessages(sessionId)
  }

  /** 创建 session — model 锁定在此刻 */
  create(projectId: string, project: ProjectConfig): SessionMeta {
    const meta: SessionMeta = {
      sdkSessionId: '',  // SDK 创建后回填
      projectId,
      status: 'idle',
      model: project.defaultModel,           // 锁定
      permissionMode: project.defaultPermissionMode,
      createdAt: Date.now(),
    }
    // sdkSessionId 在首次 query 的 onSessionInit 回调中获得
    return meta
  }

  /** 更新元数据 */
  update(sessionId: string, partial: Partial<SessionMeta>): void

  /** 持久化元数据到磁盘 */
  persist(sessionId: string): Promise<void>

  /** 响应权限请求 */
  resolvePermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void

  /** 响应问题 */
  resolveQuestion(sessionId: string, answers: Record<string, string | string[]>): void
}
```

存储位置：`~/.codecrab/session-meta/{sdkSessionId}.json` — 仅存扩展元数据，不存消息历史。

**与 CLI Session 的统一**：

```
CLI 创建的 session:
  SDK storage (~/.claude/)  → listSessions() 可见
  无 SessionMeta            → 在 list() 中显示, meta 字段为空
  用户可在 CodeCrab 中打开  → 首次操作时创建 SessionMeta

CodeCrab 创建的 session:
  SDK storage (~/.claude/)  → CLI /resume 可见
  有 SessionMeta            → 完整元数据
```

#### 4.2.4 `core/turn.ts` — TurnManager

```typescript
interface Turn {
  id: string               // turn-{timestamp}
  sessionId: string
  projectId: string
  queryId: string           // queue 分配的 ID
  type: 'user' | 'cron' | 'channel'
  prompt: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout'
  startedAt?: number
  completedAt?: number
}

class TurnManager {
  constructor(
    private agent: AgentInterface,
    private sessions: SessionManager,
    private core: CoreEngine,
  ) {}

  private queue: QueryQueue

  /** 执行一个 Turn */
  async execute(params: {
    projectId: string
    sessionId: string
    prompt: string
    type: 'user' | 'cron' | 'channel'
    images?: ImageAttachment[]
    enabledMcps?: string[]
    metadata?: TurnMetadata
  }): Promise<void> {
    const session = this.sessions.getMeta(params.sessionId)

    // 入队
    this.queue.enqueue({
      type: params.type,
      projectId: params.projectId,
      sessionId: params.sessionId,
      prompt: params.prompt,
      executor: (queuedQuery) => this.run(queuedQuery, session, params),
    })
  }

  /** 实际执行 — 调用 Agent 层 */
  private async run(
    queuedQuery: QueuedQuery,
    session: SessionMeta,
    params: TurnParams,
  ): Promise<QueryResult> {
    const turnId = `turn-${Date.now()}`

    this.core.emit('turn:start', {
      projectId: params.projectId,
      sessionId: params.sessionId,
      turnId,
      queryId: queuedQuery.id,
      prompt: params.prompt,
      type: params.type,
    })

    const stream = this.agent.query(params.prompt, {
      model: session.model,                    // session 锁定的 model
      permissionMode: session.permissionMode,
      cwd: this.core.projects.getPath(params.projectId),
      resume: session.sdkSessionId || undefined,
      enabledMcps: params.enabledMcps,
      images: params.images,
    })

    // 消费 stream events, 转换为 Core events
    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta':
          this.core.emit('turn:delta', {
            projectId: params.projectId,
            sessionId: params.sessionId,
            turnId,
            deltaType: 'text',
            text: event.text,
          })
          this.queue.touchActivity(queuedQuery.id, 'text_delta')
          break

        case 'thinking_delta':
          this.core.emit('turn:delta', {
            projectId: params.projectId,
            sessionId: params.sessionId,
            turnId,
            deltaType: 'thinking',
            text: event.text,
          })
          this.queue.touchActivity(queuedQuery.id, 'thinking_delta')
          break

        case 'tool_use':
          this.core.emit('turn:tool_use', { ... })
          this.queue.touchActivity(queuedQuery.id, 'tool_use', event.toolName)
          break

        case 'tool_result':
          this.core.emit('turn:tool_result', { ... })
          this.queue.touchActivity(queuedQuery.id, 'tool_result')
          break

        case 'ask_user_question':
          this.sessions.setPending(params.sessionId, 'question', event.questions)
          this.queue.pauseTimeout(queuedQuery.id)
          this.core.emit('interaction:ask_question', { ... })
          break

        case 'permission_request':
          this.sessions.setPending(params.sessionId, 'permission', event)
          this.queue.pauseTimeout(queuedQuery.id)
          this.core.emit('interaction:permission_request', { ... })
          break

        case 'result':
          this.core.emit('turn:close', {
            projectId: params.projectId,
            sessionId: params.sessionId,
            turnId,
            result: event.result,
            usage: event.usage,
            cost: event.cost,
            duration: event.duration,
          })
          break
      }
    }
  }

  /** Abort 当前 turn */
  abort(projectId: string): void

  /** 响应权限/问题 — 从 session 取出 pending, 恢复 turn */
  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void
  respondQuestion(sessionId: string, answers: Record<string, string | string[]>): void
}
```

#### 4.2.5 `core/queue.ts` — QueryQueue

基本保持现有 `engine/query-queue.ts` 不变。变更点：

- 从 engine/ 移入 core/
- `onStatusChange` 回调改为通过 CoreEngine emit `queue:status` 事件
- 不再直接 broadcast to project（由 Gateway broadcaster 处理）

---

### 4.3 Agent Layer

**职责**：纯 Claude Agent SDK 封装。无状态，不持有 ClientState/ProjectState。

```
agent/
├── index.ts              — 门面: query(), abort(), probe()
└── extensions/           — CodeCrab 自定义 MCP 扩展
    ├── index.ts          — 扩展注册表, buildExtensionServers()
    ├── chrome/           — DevTools Protocol 自动化工具
    │   ├── tools.ts
    │   └── types.ts
    ├── cron/             — 定时任务工具
    │   ├── tools.ts
    │   └── scheduler.ts
    └── push/             — 推送通知工具
        └── tools.ts
```

#### 4.3.1 `agent/index.ts` — Agent Interface

```typescript
import { query as sdkQuery, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { buildExtensionServers } from './extensions/index.js'

interface AgentQueryOptions {
  model: string
  permissionMode: PermissionMode
  cwd: string
  resume?: string                     // SDK session ID for resume
  enabledMcps?: string[]              // 哪些扩展 MCP 启用
  images?: ImageAttachment[]
  maxTurns?: number
  abortSignal?: AbortSignal

  // 回调 — Turn Manager 提供
  onTextDelta?: (text: string) => void
  onThinkingDelta?: (text: string) => void
  onToolUse?: (toolName: string, toolId: string, input: any) => void
  onToolResult?: (toolId: string, content: string, isError: boolean) => void
  onAskQuestion?: (questions: any[]) => void
  onPermissionRequest?: (request: any) => void
  onSessionInit?: (sdkSessionId: string, tools: string[]) => void
  onResult?: (result: any) => void
  onSdkMessage?: (msg: any) => void    // 原始 SDK 消息 (debug)
}

interface AgentInterface {
  query(prompt: string, options: AgentQueryOptions): AsyncIterable<AgentStreamEvent>
  abort(sessionId: string): void
  probe(cwd: string, model?: string): Promise<SdkInitInfo>
}

/** Agent stream event — 归一化后的事件类型 */
type AgentStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; toolName: string; toolId: string; input: any }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { type: 'ask_user_question'; toolId: string; questions: any[] }
  | { type: 'permission_request'; requestId: string; toolName: string; input: any; reason?: string }
  | { type: 'session_init'; sdkSessionId: string; tools: string[] }
  | { type: 'result'; result: string; usage: any; cost: number; duration: number }
  | { type: 'sdk_event'; raw: any }    // 原始 SDK 消息透传

class ClaudeAgent implements AgentInterface {
  async *query(prompt: string, options: AgentQueryOptions): AsyncIterable<AgentStreamEvent> {
    const extensionServers = buildExtensionServers(options.enabledMcps)

    const sdkOptions = {
      model: options.model,
      cwd: options.cwd,
      resume: options.resume,
      maxTurns: options.maxTurns ?? 200,
      settingSources: ['project', 'user'] as const,  // CLI 一致
      mcpServers: {
        ...extensionServers,
      },
      permissionMode: options.permissionMode,
      abortSignal: options.abortSignal,
    }

    const q = sdkQuery({ prompt, options: sdkOptions })

    for await (const msg of q) {
      // 将 SDK 原始消息归一化为 AgentStreamEvent
      yield* this.normalize(msg)
    }
  }

  private *normalize(msg: SDKMessage): Generator<AgentStreamEvent> {
    // 解析 SDK stream_event, system, assistant, user, result
    // 转换为统一的 AgentStreamEvent 类型
    // ...
  }
}
```

#### 4.3.2 MCP/Skills 加载策略

```
┌──────────────────────────────────────────────────────────┐
│  SDK 自动加载 (via settingSources: ['project', 'user'])  │
│                                                          │
│  ~/.claude/settings.json     → 用户级 MCP servers        │
│  .claude/settings.json       → 项目级 MCP servers        │
│  ~/.claude/skills/           → 用户级 Skills             │
│  .claude/skills/             → 项目级 Skills             │
│  ~/.claude/agents/           → 用户级 Agents             │
│  .claude/agents/             → 项目级 Agents             │
│                                                          │
│  与 CLI 完全一致, 不需要我们管理                           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  CodeCrab 扩展 (via options.mcpServers, programmatic)    │
│                                                          │
│  chrome  → createSdkMcpServer({ name, tools })           │
│  cron    → createSdkMcpServer({ name, tools })           │
│  push    → createSdkMcpServer({ name, tools })           │
│                                                          │
│  通过 enabledMcps 参数按需启用                            │
└──────────────────────────────────────────────────────────┘
```

---

### 4.4 Soul Layer

**职责**：人格演化。作为 Core 事件的独立消费者。

```
soul/
├── agent.ts          — 订阅 core turn:close, 触发演化
└── settings.ts       — 开关配置
```

```typescript
// soul/agent.ts
export function initSoul(core: CoreEngine): void {
  core.on('turn:close', async (event) => {
    if (event.type !== 'user') return     // 仅用户交互触发
    if (!isSoulEvolutionEnabled()) return

    await triggerSoulEvolution(event)
  })
}
```

Soul 不再被 ws/ 直接调用。

---

### 4.5 Cron Scheduler

**职责**：定时任务调度。作为 Core 的另一个消费者。

```
cron/
├── scheduler.ts      — node-cron 调度, 触发 → core.submitTurn()
├── store.ts          — 任务配置持久化 (~/.codecrab/cron/)
└── history.ts        — 执行历史 (JSONL)
```

```typescript
// cron/scheduler.ts
export function initCronScheduler(core: CoreEngine): void {
  // 加载所有 cron 任务
  const jobs = loadCronJobs()

  for (const job of jobs) {
    cron.schedule(job.schedule, async () => {
      await core.submitTurn({
        projectId: job.projectId,
        sessionId: job.sessionId,   // 或自动创建
        prompt: job.prompt,
        type: 'cron',
        metadata: { cronJobId: job.id, cronJobName: job.name },
      })
    })
  }
}
```

Cron 和用户操作对 Core 来说是一样的：都是提交一个 Turn。

---

## 5. State Management

### 5.1 状态归属

| 状态 | 归属 | 存储 |
|------|------|------|
| 客户端连接 (Client) | Gateway | 内存 Map |
| Project 配置 | Core → ProjectManager | `~/.codecrab/projects.json` |
| Session 消息历史 | SDK (Source of Truth) | `~/.claude/` (JSONL transcript) |
| Session 扩展元数据 | Core → SessionManager | `~/.codecrab/session-meta/{id}.json` |
| Turn 运行时状态 | Core → TurnManager | 内存 (transient) |
| Query 队列 | Core → Queue | 内存 (transient) |
| Model 配置 | Core → ProjectManager | `~/.codecrab/models.json` |
| Cron 任务定义 | CronScheduler | `~/.codecrab/cron/` |
| Soul 人格 | Soul | `~/.codecrab/soul/` |
| Auth Token | Gateway → auth | `~/.codecrab/config.json` |

### 5.2 ClientState 拆分

**Before (当前)**：
```typescript
// engine/claude.ts — 混合了连接信息和业务状态
interface ClientState {
  clientId: string           // 连接信息
  projectId?: string         // 连接信息
  sessionId?: string         // 连接信息
  cwd: string                // 业务状态
  model?: string             // 业务状态 → Session
  permissionMode: PermissionMode  // 业务状态 → Session
  activeQuery: ActiveQuery | null  // 运行时 → TurnManager
  pendingPermissions: Map<...>     // 交互 → Session
  pendingQuestionResolve: ...      // 交互 → Session
  accumulatingText: string         // 流式累积 → TurnManager
  accumulatingThinking: string     // 流式累积 → TurnManager
}
```

**After (重构后)**：

```typescript
// Gateway — 仅连接信息
interface Client {
  ws: WebSocket
  connectionId: string
  clientId: string
  subscribedProjects: Map<string, { sessionId?: string }>
}

// Core → SessionMeta — 业务状态
interface SessionMeta {
  model: string                    // 创建时锁定
  permissionMode: PermissionMode   // session 级别
  pendingQuestion?: ...
  pendingPermissionRequest?: ...
}

// Core → Turn — 运行时状态 (transient)
interface Turn {
  id: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  accumulatingText: string
  accumulatingThinking: string
  currentToolCalls: ...
}
```

### 5.3 Session Model 锁定规则

```typescript
// 创建 Session 时
const session = core.sessions.create(projectId, {
  model: project.defaultModel,            // 从 Project 默认值继承
  permissionMode: project.defaultPermissionMode,
})

// Session 生命周期中
session.model              // 只读, 不可变
session.permissionMode     // 可变 (用户可调整)

// Model 切换 → 必须创建新 Session
// 客户端发 set_model → Gateway 创建新 Session, 切换客户端订阅
```

---

## 6. Client-Server Message Mapping

客户端消息 → Core 调用映射：

| Client Message | Gateway 处理 | Core 调用 |
|---|---|---|
| `prompt` | 路由到 Core | `core.submitTurn({ type: 'user', ... })` |
| `abort` | 路由到 Core | `core.turns.abort(projectId)` |
| `respond_permission` | 路由到 Core | `core.turns.respondPermission(sessionId, ...)` |
| `respond_question` | 路由到 Core | `core.turns.respondQuestion(sessionId, ...)` |
| `set_model` | 创建新 Session | `core.sessions.create(projectId, { model })` |
| `set_permission_mode` | 路由到 Core | `core.sessions.update(sessionId, { permissionMode })` |
| `resume_session` | 路由到 Core | `core.sessions.resume(sessionId)` |
| `switch_project` | 更新订阅 | Gateway 内部处理 + `core.sessions.autoResume(projectId)` |
| `set_cwd` | 路由到 Core | `core.projects.updateCwd(projectId, cwd)` |
| `probe_sdk` | 路由到 Agent | `agent.probe(cwd, model)` |
| `command` | Gateway 内部 | 部分命令转发到 Core |

---

## 7. Directory Structure

```
packages/server/src/
├── index.ts                    — 启动入口 (精简: 创建 Core, Gateway, 注册消费者)
│
├── gateway/
│   ├── index.ts                — 导出 setupGateway()
│   ├── ws.ts                   — WebSocket server + 客户端注册
│   ├── http.ts                 — Express 路由 (薄封装)
│   ├── broadcaster.ts          — Core events → 客户端推送
│   ├── heartbeat.ts            — 活动心跳, 节流广播
│   └── auth.ts                 — Token 认证 (middleware + WS hook)
│
├── core/
│   ├── index.ts                — CoreEngine (EventEmitter 门面)
│   ├── project.ts              — ProjectManager
│   ├── session.ts              — SessionManager (SDK SoT + meta)
│   ├── turn.ts                 — TurnManager (生命周期 + Agent 交互)
│   └── queue.ts                — QueryQueue (从 engine/ 迁入)
│
├── agent/
│   ├── index.ts                — ClaudeAgent (纯 SDK 封装)
│   └── extensions/
│       ├── index.ts            — 扩展注册表
│       ├── chrome/             — DevTools Protocol
│       ├── cron/               — 定时任务工具
│       └── push/               — 推送通知
│
├── soul/
│   ├── agent.ts                — 人格演化 (订阅 Core events)
│   └── settings.ts             — 开关配置
│
├── cron/
│   ├── scheduler.ts            — 定时调度 (调用 core.submitTurn)
│   ├── store.ts                — 任务配置持久化
│   └── history.ts              — 执行历史
│
└── types/                      — 共享类型定义
```

## 8. Startup Sequence

```typescript
// index.ts
async function main() {
  // 1. 创建 Agent 层
  const agent = new ClaudeAgent()

  // 2. 创建 Core (传入 Agent)
  const core = new CoreEngine(agent)
  await core.init()   // 加载 projects, session metas

  // 3. 注册消费者
  initSoul(core)
  initCronScheduler(core)

  // 4. 创建 Gateway (传入 Core)
  const { app, server } = setupGateway(core)

  // 5. 启动
  server.listen(PORT)
}
```

## 9. Migration Strategy

分阶段迁移，每个阶段保持可运行：

| Phase | 内容 | 风险 |
|-------|------|------|
| **Phase 1** | 创建 `core/`, `agent/`, `gateway/` 目录结构。先抽取 Agent 层 (最独立) | 低 |
| **Phase 2** | 抽取 Core — ProjectManager, Queue 迁入 | 中 |
| **Phase 3** | 抽取 Core — SessionManager (切换到 SDK SoT) | 高 — session 存储变更 |
| **Phase 4** | 抽取 Core — TurnManager (从 ws/ 移出执行逻辑) | 高 — 主逻辑迁移 |
| **Phase 5** | 瘦化 Gateway — ws/ 只保留连接管理, broadcaster 独立 | 中 |
| **Phase 6** | Soul/Cron 改为事件订阅模式 | 低 |
| **Phase 7** | 清理：删除旧 engine/, 更新 API routes | 低 |
