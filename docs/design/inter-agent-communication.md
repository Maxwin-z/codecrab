# Inter-Agent Communication Architecture

> 通用多 Agent 协作通讯系统设计文档

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、数据模型](#三数据模型)
- [四、系统架构](#四系统架构)
- [五、Agent Tools](#五agent-tools)
- [六、消息路由与投递](#六消息路由与投递)
- [七、Auto-Resume 机制](#七auto-resume-机制)
- [八、终止与兜底](#八终止与兜底)
- [九、存储设计](#九存储设计)
- [十、事件系统扩展](#十事件系统扩展)
- [十一、API 端点](#十一api-端点)
- [十二、架构约束与边界](#十二架构约束与边界)
- [附录：验证用例 — AIGC 内容生产流程](#附录验证用例--aigc-内容生产流程)

---

## 一、概述

### 问题定义

当前 Agent 系统中，每个 Agent 独立运行，无法感知其他 Agent 的存在。用户需要手动在 Agent 之间传递信息、中转工作结果。这限制了以下场景：

- **串行协作** — Agent A 完成工作后，结果需要交给 Agent B 继续处理
- **评审迭代** — Agent A 提交工作，Agent B 评审后反馈，A 根据反馈迭代，多轮往复
- **扇出分发** — 一个 Agent 将任务拆解后分发给多个 Agent 并行处理
- **跨角色沟通** — 不同专业领域的 Agent 之间需要信息交换和协商

### 设计目标

1. **Mailbox 通讯** — 双向异步消息传递，Agent 间像两个人一样工作沟通
2. **异步自治** — Agent 收到消息后自动 resume 处理，无需用户确认
3. **制品共享** — 工作产物（文档、数据等）在 Agent 间共享，不受 token 限制
4. **多方协作** — 一个协作线程中可以有任意数量的 Agent 参与，支持定向和广播
5. **完全可观测** — 用户可查看所有线程、消息、制品，信息尽可能丰富
6. **自主终止 + 兜底** — Agent 自己判断何时结束，加最大轮次兜底防止无限循环

### 触发方式

| 方式 | 示例 | 说明 |
|------|------|------|
| 用户 Prompt | `"帮我调研 xxx，完成后 @reviewer 做评审"` | @ 是自然语言指令，Agent 解读后调用 tool |
| Agent CLAUDE.md | `"完成后 send_message(@xxx)"` | Agent 定义中预设协作关系 |
| Cron | 定时触发 Agent，Agent 自行决定是否通知 | 与现有 Cron 系统兼容 |

### 主流方案参考

| 框架 | 通讯方式 | 制品共享 |
|------|---------|---------|
| CrewAI | Tool 调用委派 (hub-and-spoke) | Task `context` 链式注入 |
| AutoGen | 广播群聊 + HandoffMessage | 共享消息历史 |
| LangGraph | 共享状态对象 (无直接消息) | Typed State + Reducer |
| OpenAI Agents SDK | 对话历史转发 + Handoff | 对话历史即状态 |
| Claude Code Teams | Mailbox + 共享 Task List | 外部存储 + 轻量引用 |

本设计采用 **Mailbox + 外部 Artifact 存储** 模式（与 Anthropic 推荐的多 Agent 研究系统一致）。选择该模式的原因：

- Mailbox 支持真正的双向异步通讯（非 handoff 式的控制权转移）
- 外部 Artifact 存储避免 token 爆炸，Agent 可按需读取
- 与 CodeCrab 现有的 Session / QueryQueue / Event 架构天然兼容

---

## 二、核心概念

### 概念模型

```
┌──────────────────────────────────────────────┐
│                  Thread                       │
│  跨 Agent 协作的消息关联容器                    │
│                                               │
│  ┌─────────┐    Message    ┌─────────┐       │
│  │ Agent A  │ ───────────► │ Agent B  │       │
│  │(session) │ ◄─────────── │(session) │       │
│  └─────────┘              └─────────┘       │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │           Artifacts (共享制品)            │  │
│  │  report.md  │  draft.md  │  review.md   │  │
│  └─────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### Thread（协作线程）

Thread 是多 Agent 协作的基本单元。它不是 "任务" 或 "工作流"，而是消息关联的轻量容器（类比邮件线程）。

- 每个 Thread 有独立的消息历史和制品存储
- 每个参与 Agent 在 Thread 中有一个独立的 Session
- Thread 支持父子关系（`parentThreadId`），实现扇出场景

### Session 与 Thread 的关系

```
Session : Thread = 1 : 1（或 1 : 0）

Agent 在每个 Thread 中有一个独立的 Session:
  Agent A ──── Thread-1: session-a1
          └─── Thread-2: session-a2
          └─── Thread-3: session-a3

同一 Agent 不同 Thread 的 Session 上下文完全隔离。
```

选择单 Session 模式的原因：
- SDK 自动维护完整对话历史，Agent 天然拥有该 Thread 内所有之前的上下文
- 多轮迭代时 Agent 记得自己之前做了什么、收到过什么反馈
- 不需要额外的上下文拼接逻辑

### Message（消息）

Agent 间通讯的基本单位。支持定向发送（指定目标 Agent）和广播（Thread 内所有参与者）。

### Artifact（制品）

Agent 的工作产物。存储在文件系统中，通过引用在消息中传递。目标 Agent 通过现有的 Read tool 按需读取，不占用 context window。

---

## 三、数据模型

### Thread

```typescript
interface Thread {
  id: string                        // "thread-xxxxx"
  title: string                     // 由创建者指定
  parentThreadId: string | null     // 父 thread（扇出场景）
  status: ThreadStatus
  participants: ThreadParticipant[]
  config: ThreadConfig
  createdAt: number
  updatedAt: number
}

type ThreadStatus = 'active' | 'completed' | 'stalled'

interface ThreadParticipant {
  agentId: string
  agentName: string
  sessionId: string                 // 该 Agent 在此 Thread 中的 Session
  joinedAt: number
  lastActiveAt: number              // 最近活动时间（发消息、完成 turn 等）
}

interface ThreadConfig {
  maxTurns: number                  // Thread 内 auto-resume turn 的总上限，默认 10
}
```

### ThreadMessage

```typescript
interface ThreadMessage {
  id: string                        // "msg-xxxxx"
  threadId: string
  from: AgentRef
  to: AgentRef | 'broadcast'
  content: string                   // 消息正文
  artifacts: ArtifactRef[]          // 附带的制品引用
  status: MessageStatus
  createdAt: number
}

interface AgentRef {
  agentId: string
  agentName: string
}

type MessageStatus = 'pending' | 'delivered' | 'failed'
```

### Artifact

```typescript
interface Artifact {
  id: string                        // "artifact-xxxxx"
  threadId: string
  name: string                      // "report.md"
  mimeType: string                  // "text/markdown", "image/png"
  createdBy: AgentRef
  path: string                      // 文件系统绝对路径
  size: number
  createdAt: number
}

type ArtifactRef = Pick<Artifact, 'id' | 'name' | 'path'>
```

### 对现有模型的扩展

```typescript
// SessionMeta（已有，新增字段）
interface SessionMeta {
  // ... 现有字段 ...
  threadId?: string                 // 关联的 Thread（如有）
  autoResumeCount: number           // 该 Session 被 auto-resume 的次数
}

// Agent（已有，不变）
// Agent 的协作行为通过 CLAUDE.md 定义，不需要在数据模型层面修改
```

---

## 四、系统架构

### 组件总览

```
┌────────────────────────────────────────────────────────────────┐
│                        CoreEngine                              │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ ProjectMgr   │  │ SessionMgr   │  │    TurnManager       │  │
│  │ (existing)   │  │ (existing)   │  │    (extended)        │  │
│  └──────────────┘  └──────────────┘  │                      │  │
│                                      │  tool call 拦截:     │  │
│  ┌──────────────┐  ┌──────────────┐  │  send_message        │  │
│  │ AgentMgr     │  │ ThreadMgr    │  │  save_artifact       │  │
│  │ (existing)   │  │   (NEW)      │  │  list_threads        │  │
│  └──────────────┘  └──────────────┘  │  get_thread_messages  │  │
│                                      │  complete_thread      │  │
│                                      └──────────┬───────────┘  │
│  ┌──────────────────────────────────────────────┐│             │
│  │            MessageRouter (NEW)                ││             │
│  │                                               ││             │
│  │  sendMessage() ─► 存储消息                    ◄┘             │
│  │                ─► 解析目标 Agent                             │
│  │                ─► 查找/创建 Session                          │
│  │                ─► 构造 auto-resume prompt                   │
│  │                ─► 提交 turn 到 QueryQueue                   │
│  └──────────────────────────────────────────────┘              │
│                                                                │
│  EventEmitter ──► thread:created, message:sent, agent:resumed  │
└────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│   Broadcaster    │     │    Gateway        │
│   (extended)     │     │    (extended)     │
│                  │     │                  │
│ thread events    │     │ GET /api/threads │
│ → ServerMessage  │     │ GET /api/threads │
│ → WebSocket      │     │     /:id/msgs   │
└──────────────────┘     └──────────────────┘
```

### 新增组件

#### ThreadManager — Thread 生命周期管理

```typescript
class ThreadManager {
  // CRUD
  create(title: string, parentThreadId?: string, config?: Partial<ThreadConfig>): Thread
  get(threadId: string): Thread | null
  list(filters?: { status?: ThreadStatus; agentId?: string }): Thread[]

  // 参与者管理
  addParticipant(threadId: string, agentId: string, agentName: string, sessionId: string): void
  getParticipantSession(threadId: string, agentId: string): string | null  // → sessionId

  // 状态管理
  complete(threadId: string): void
  stall(threadId: string, reason: string): void

  // 查询
  getThreadsByAgent(agentId: string): Thread[]
  getChildThreads(parentThreadId: string): Thread[]

  // Artifact 管理
  saveArtifact(threadId: string, name: string, content: string, createdBy: AgentRef): Artifact
  listArtifacts(threadId: string): Artifact[]

  // 消息管理
  saveMessage(message: ThreadMessage): void
  getMessages(threadId: string, limit?: number): ThreadMessage[]

  // 终止检查
  getTurnCount(threadId: string): number
}
```

#### MessageRouter — 消息路由与 Auto-Resume

```typescript
class MessageRouter {
  constructor(
    private threads: ThreadManager,
    private sessions: SessionManager,
    private turns: TurnManager,
    private agents: AgentManager
  )

  /**
   * 处理 send_message tool call
   * 返回 tool result 给调用方 Agent
   */
  async handleSendMessage(
    fromAgentId: string,
    fromSessionId: string,
    params: SendMessageParams
  ): Promise<SendMessageResult>

  /**
   * 将消息投递给目标 Agent，触发 auto-resume
   */
  private async deliverMessage(message: ThreadMessage, thread: Thread): Promise<void>

  /**
   * 构造 auto-resume 的 prompt
   */
  private buildResumePrompt(message: ThreadMessage, thread: Thread): string

  /**
   * 检查是否达到终止条件
   */
  private checkTermination(thread: Thread): { terminated: boolean; reason?: string }
}
```

---

## 五、Agent Tools

所有 Agent 始终拥有以下 inter-agent tools（通过内部 MCP Server 或 tool 拦截层提供）。Agent 是否使用这些 tools 由其 CLAUDE.md 引导。

### send_message

核心通讯 tool。发送消息给其他 Agent。

```typescript
interface SendMessageParams {
  to: string              // "@agentName" 或 "broadcast"
  content: string         // 消息内容
  artifacts?: string[]    // 要附带的 artifact ID 列表（save_artifact 返回的 artifactId）
  new_thread?: boolean    // 是否创建新的子 Thread（默认 false）
  thread_title?: string   // new_thread=true 时必填
}

interface SendMessageResult {
  messageId: string
  threadId: string
  status: 'delivered' | 'queued' | 'thread_stalled'
}
```

**LLM Tool Description:**

> Send a message to another agent. Use @name to specify the target, or "broadcast" to send to all participants in the current thread.
> Set new_thread=true to create an independent sub-thread for this message.
> Use the artifacts parameter to attach previously saved work artifacts by their IDs (returned from save_artifact).

### save_artifact

保存工作制品到当前 Thread。

```typescript
interface SaveArtifactParams {
  name: string            // 文件名，如 "report.md"
  content: string         // 内容
}

interface SaveArtifactResult {
  artifactId: string
  path: string            // 可被 Read tool 读取的绝对路径
}
```

### list_threads

查看自己参与的协作线程。

```typescript
interface ListThreadsParams {
  status?: ThreadStatus   // 过滤条件
}

interface ListThreadsResult {
  threads: {
    id: string
    title: string
    status: ThreadStatus
    participants: { agentName: string }[]
    messageCount: number
    lastActivity: number
  }[]
}
```

### get_thread_messages

查看指定线程的消息历史。

```typescript
interface GetThreadMessagesParams {
  threadId: string
  limit?: number          // 默认 20
}

interface GetThreadMessagesResult {
  messages: {
    id: string
    from: string          // agent name
    to: string            // agent name or "broadcast"
    content: string
    artifacts: ArtifactRef[]
    timestamp: number
  }[]
}
```

### complete_thread

显式标记当前 Thread 为已完成。Agent 在判断自己的工作已全部结束时调用。

```typescript
interface CompleteThreadParams {
  summary?: string        // 可选的完结摘要，记录到 Thread 中
}

interface CompleteThreadResult {
  threadId: string
  status: 'completed'
}
```

**LLM Tool Description:**

> Mark the current thread as completed. Call this when your work in this collaboration thread is done.
> Optionally provide a summary of what was accomplished.

**行为：**
- 将 Thread `status` 设为 `completed`
- 如果提供了 `summary`，保存为 Thread 的最后一条系统消息
- emit `thread:completed` 事件
- 不会终止其他参与者正在执行的 Turn（已排队的 Turn 照常执行）

---

## 六、消息路由与投递

### 核心流程

当 Agent A 调用 `send_message(@B, content, artifacts)` 时：

```
Agent A (tool call)
  │
  ▼
TurnManager 拦截 send_message tool call
  │
  ▼
MessageRouter.handleSendMessage()
  │
  ├─► 1. 确定 Thread
  │     ├─ new_thread=true → 创建子 Thread (parentThreadId = 当前 Thread)
  │     ├─ 已有 Thread → 使用当前 Thread
  │     └─ 无 Thread（首次 send_message）→ 创建根 Thread
  │
  ├─► 2. 确保发送方在 Thread 中
  │     └─ 未加入 → addParticipant(A)
  │
  ├─► 3. 解析目标
  │     ├─ "@name" → AgentManager 按名称查找 agentId
  │     └─ "broadcast" → Thread 中除发送方外的所有参与者
  │
  ├─► 4. 检查终止条件
  │     └─ 达到 maxTurns → 返回 { status: 'thread_stalled' }，不投递
  │
  ├─► 5. 存储消息
  │     └─ ThreadManager.saveMessage()
  │
  ├─► 6. 投递（per target agent）
  │     ├─ 目标已有 Thread Session → resume 该 Session
  │     └─ 目标无 Thread Session → 创建 Session → 加入 Thread → 启动首 Turn
  │
  ├─► 7. 触发事件
  │     └─ emit: message:sent, agent:auto_resume, thread:created (if new)
  │
  └─► 8. 返回 tool result 给 Agent A
        { messageId, threadId, status: 'delivered' }
```

### 时序图：基本的两方通讯

```
Agent A Session (Turn 1)                Server                        Agent B Session (auto-created)
      │                                   │                                    │
      │  save_artifact("output.md", ...)  │                                    │
      │ ─────────────────────────────────►│                                    │
      │  ◄── { artifactId, path } ───────│                                    │
      │                                   │                                    │
      │  send_message("@B",              │                                    │
      │    "工作完成，请处理",              │                                    │
      │    artifacts=["artifact-xxx"])    │                                    │
      │ ─────────────────────────────────►│                                    │
      │                                   │  1. 创建 Thread                    │
      │                                   │  2. A 加入 Thread                  │
      │                                   │  3. 解析 @B → agentId              │
      │                                   │  4. 创建 B 的 Session              │
      │                                   │  5. B 加入 Thread                  │
      │                                   │  6. 存储 Message                   │
      │                                   │  7. 构造 resume prompt             │
      │                                   │  8. 提交 turn 到 B 的 QueryQueue   │
      │  ◄── { messageId, status } ──────│─────────────────────────────────── │
      │                                   │                                    │
      │  Turn 1 结束, idle                │          prompt:                   │
      │                                   │          "[来自 @A 的消息]          │
      │                                   │           Thread: xxx              │
      │                                   │           工作完成，请处理           │
      │                                   │           附件:                    │
      │                                   │           - output.md: /path/..."  │
      │                                   │                                    │
      │                                   │                        B 处理并回复 │
      │                                   │◄───────────────────────────────────│
      │                                   │  send_message("@A", "处理完成")    │
      │                                   │                                    │
      │  auto-resume ◄────────────────────│                                    │
      │  Turn 2: 收到 B 的回复             │                                    │
```

### 时序图：扇出（fan-out）

```
Agent A (Turn 1)                          Server                     Agent B / Agent C
      │                                      │                            │
      │  send_message("@B", "任务1",          │                            │
      │    new_thread=true,                   │                            │
      │    thread_title="子任务1")             │                            │
      │ ────────────────────────────────────►│                            │
      │                                      │  创建 Thread-child-1       │
      │  ◄── { threadId: "tc1" } ───────────│──► B session (Thread-c1)   │
      │                                      │                            │
      │  send_message("@C", "任务2",          │                            │
      │    new_thread=true,                   │                            │
      │    thread_title="子任务2")             │                            │
      │ ────────────────────────────────────►│                            │
      │                                      │  创建 Thread-child-2       │
      │  ◄── { threadId: "tc2" } ───────────│──► C session (Thread-c2)   │
      │                                      │                            │
      │  Turn 1 结束                          │  B 和 C 并行执行            │
      │                                      │  （独立 QueryQueue）        │
```

### Lazy Session Creation

发起方在子 Thread 中的 Session 采用延迟创建策略：

| 时机 | 行为 |
|------|------|
| Agent A 发 `send_message(@B, new_thread=true)` | A 不加入子 Thread。A 只是消息的发送者。 |
| Agent B 回复 `send_message(@A)` | MessageRouter 发现 A 无该 Thread 的 Session → 创建 Session → 加入 Thread |

**原因：**
- 避免不必要的 Session 创建（A 发完可能不需要参与后续）
- Session 上下文隔离 — 每个 Thread 的 Session 只包含该 Thread 内的对话

---

## 七、Auto-Resume 机制

### Prompt 构造

当 Agent B 发消息给 Agent A，A 的 Session 自动 resume。Resume turn 的 prompt 构造如下：

```typescript
function buildResumePrompt(message: ThreadMessage, thread: Thread): string {
  const lines: string[] = []

  lines.push(`[来自 @${message.from.agentName} 的消息]`)
  lines.push(`Thread: ${thread.title}`)
  lines.push('')
  lines.push(message.content)

  if (message.artifacts.length > 0) {
    lines.push('')
    lines.push('附件:')
    for (const ref of message.artifacts) {
      lines.push(`- ${ref.name}: ${ref.path}`)
    }
  }

  return lines.join('\n')
}
```

这个 prompt 作为 **user message** 发送给 SDK Session，与正常的用户 prompt 格式完全一致，不需要修改 SDK 层。

### 首次加入 Thread 的上下文注入

当 Agent 第一次被拉入一个 Thread 时，在其 Session 的 system prompt 末尾追加协作上下文：

```typescript
function buildThreadContext(thread: Thread, existingMessages: ThreadMessage[]): string {
  const lines: string[] = []

  lines.push('\n## 当前协作线程')
  lines.push(`- Thread: ${thread.title}`)
  lines.push(`- 参与者: ${thread.participants.map(p => `@${p.agentName}`).join(', ')}`)

  if (thread.parentThreadId) {
    const parent = threadManager.get(thread.parentThreadId)
    if (parent) lines.push(`- 来源: ${parent.title}`)
  }

  // 如果 Thread 已有历史消息（Agent 是后来加入的），提供摘要
  if (existingMessages.length > 0) {
    lines.push('\n### 已有消息记录')
    for (const msg of existingMessages.slice(-5)) {
      lines.push(`- @${msg.from.agentName}: ${msg.content.slice(0, 200)}`)
    }
  }

  return lines.join('\n')
}
```

### 并发处理

当 Agent 正在处理中收到新消息：

```
Agent A: Turn 1 (processing) ─────────────────► Turn 1 done → Turn 2 (处理排队的消息)
                                ↑
                      B 的消息到达，auto-resume turn 入 QueryQueue 排队
```

消息触发的 auto-resume turn 是一个普通的 query，进入该 Agent 所在 project 的 QueryQueue 排队。与现有机制完全兼容，无需新增调度逻辑。

---

## 八、终止与兜底

### 终止条件检查

```typescript
function checkTermination(thread: Thread): { terminated: boolean; reason?: string } {
  const turnCount = threadManager.getTurnCount(thread.id)

  if (turnCount >= thread.config.maxTurns) {
    return {
      terminated: true,
      reason: `Thread auto-resume turn count reached limit (${thread.config.maxTurns})`
    }
  }

  return { terminated: false }
}
```

`maxTurns` 统计的是该 Thread 内所有 auto-resume 触发的 turn 总数（不计用户手动触发的 turn）。默认值为 10。

### 终止后的行为

1. Thread `status` 设为 `stalled`
2. `send_message` tool 返回 `{ status: 'thread_stalled' }` 给调用方 Agent
3. emit `thread:stalled` 事件，前端展示提醒
4. 用户可手动介入：
   - 通过 API `PATCH /api/threads/:id/config` 调整 `maxTurns`
   - 直接对相关 Agent 发新 prompt 继续工作

### Agent 自主终止

Agent 可以在 CLAUDE.md 中定义终止条件（如 "最多反馈 3 轮"）。Agent 判断工作完成时，调用 `complete_thread` 显式标记 Thread 为已完成。如果 Agent 不调用 `complete_thread` 而只是不再发消息，Thread 仍保持 `active` 状态但所有参与者处于 idle 状态。

推荐的终止方式优先级：
1. **显式完成** — Agent 调用 `complete_thread(summary)` 标记 Thread 完成（推荐）
2. **隐式 idle** — Agent 不再发消息，Thread 保持 `active` 但无新活动
3. **兜底终止** — 达到 `maxTurns` 上限，Thread 自动 `stalled`

---

## 九、存储设计

### 文件系统布局

```
~/.codecrab/
├── threads/
│   ├── index.json                              # Thread 索引（快速查询用）
│   │
│   └── {threadId}/
│       ├── thread.json                         # 完整 Thread 对象
│       ├── messages/
│       │   ├── {timestamp}-{messageId}.json    # 单条消息
│       │   └── ...
│       └── artifacts/
│           ├── report.md                       # Agent 工作制品
│           └── draft-v1.md
│
├── session-meta/
│   └── {sessionId}.json                        # 现有，新增 threadId 字段
│
├── agents.json                                 # 现有，不变
└── agents/
    └── {agentId}/
        └── CLAUDE.md                           # 现有，不变
```

### index.json 格式

轻量索引，用于快速列出和过滤 Thread，避免遍历所有目录：

```json
[
  {
    "id": "thread-a1b2c3",
    "title": "某次协作",
    "status": "active",
    "parentThreadId": null,
    "updatedAt": 1711699200000
  },
  {
    "id": "thread-d4e5f6",
    "title": "子任务-1",
    "status": "completed",
    "parentThreadId": "thread-a1b2c3",
    "updatedAt": 1711702800000
  }
]
```

### 消息文件命名

文件名格式：`{timestamp}-{messageId}.json`。timestamp 前缀保证文件系统自然排序与时间顺序一致，无需额外排序。

---

## 十、事件系统扩展

### 新增 CoreEventMap 条目

```typescript
interface CoreEventMap {
  // ... 现有事件 ...

  // Thread 生命周期
  'thread:created':    { thread: Thread }
  'thread:updated':    { thread: Thread }
  'thread:completed':  { thread: Thread }
  'thread:stalled':    { thread: Thread; reason: string }

  // 消息事件
  'message:sent':      { message: ThreadMessage; threadId: string }
  'message:delivered': { message: ThreadMessage; targetAgentId: string; targetSessionId: string }

  // Auto-resume 事件（前端用于展示跨 Agent 活动）
  'agent:auto_resume': {
    agentId: string
    agentName: string
    sessionId: string
    threadId: string
    threadTitle: string
    triggeredBy: AgentRef
  }
}
```

### 新增 ServerMessage 类型（WebSocket → 前端）

```typescript
type ServerMessage =
  | /* ... 现有类型 ... */
  | { type: 'thread_created';    data: Thread }
  | { type: 'thread_updated';    data: Thread }
  | { type: 'thread_completed';  data: Thread }
  | { type: 'thread_stalled';    data: { thread: Thread; reason: string } }
  | { type: 'agent_message';     data: { message: ThreadMessage; threadId: string } }
  | { type: 'agent_auto_resume'; data: { agentId: string; agentName: string; threadId: string; threadTitle: string; triggeredBy: AgentRef } }
```

### 广播策略

Thread 事件 **全局广播**（不限于某个 project 的 subscriber），因为用户需要在任何页面都能看到跨 Agent 的协作活动。

---

## 十一、API 端点

### Thread 查询

```
GET    /api/threads                              # 列出所有 Threads
  Query: ?status=active&agentId=xxx              # 可选过滤
  Response: { threads: Thread[] }

GET    /api/threads/:threadId                    # 获取 Thread 详情（含 participants）
  Response: Thread

GET    /api/threads/:threadId/messages           # 获取 Thread 消息历史
  Query: ?limit=20&before={timestamp}            # 分页
  Response: { messages: ThreadMessage[] }

GET    /api/threads/:threadId/artifacts          # 列出 Thread 制品
  Response: { artifacts: Artifact[] }

GET    /api/threads/:threadId/artifacts/:name    # 获取制品内容
  Response: 文件内容 (Content-Type 按 mimeType)
```

### Agent 视角

```
GET    /api/agents/:agentId/threads              # 该 Agent 参与的 Threads
  Response: { threads: Thread[] }
```

### Thread 操作

```
POST   /api/threads/:threadId/complete           # 手动完成 Thread
PATCH  /api/threads/:threadId/config             # 修改配置（如调整 maxTurns）
  Body: { maxTurns: 20 }
```

---

## 十二、架构约束与边界

| 约束 | 说明 |
|------|------|
| Session 与 Thread 1:1 | 一个 Session 只属于一个 Thread（或不属于任何 Thread） |
| Thread 内消息有序 | 消息按 timestamp 排序，不保证跨 Thread 的全局顺序 |
| Artifact 属于 Thread | 制品存储在 Thread 目录下，跨 Thread 引用通过绝对路径 |
| Auto-resume 异步 | send_message 返回不等待目标 Agent 的回复 |
| 终止兜底 | maxTurns 默认 10，可在 Thread 创建时或运行中调整 |
| Agent 名称唯一 | @mention 按名称解析，AgentManager 保证名称唯一 |
| Tool 始终可用 | 所有 Agent 始终拥有 inter-agent tools，是否使用由 CLAUDE.md 引导 |
| 显式完成优先 | Agent 应通过 `complete_thread` 显式标记 Thread 完成，而非依赖隐式 idle |
| Lazy Session | 发起方在子 Thread 中的 Session 延迟到收到回复时才创建 |
| 全局广播 | Thread 事件全局推送到所有 WebSocket 连接 |

---

## 附录：验证用例 — AIGC 内容生产流程

以下用一个完整的业务场景验证架构设计的合理性。

### 场景描述

AIGC 内容生产流水线，涉及 4 个 Agent 协作：

| Agent | 角色 | 协作关系（CLAUDE.md 定义） |
|-------|------|--------------------------|
| Crawler | 资讯爬取 | 完成后 `send_message(@master)` |
| Master | 流程主控 + 质量评审 | 评审内容，与用户确认，分发任务，最多 3 轮反馈 |
| Creator | 内容创作 | 收到反馈后迭代修改，提交给消息发送方 |
| Ops | 运营发布 | 决定发布时间和平台 |

### 完整数据流

```
Step 1: Cron 触发 Crawler
────────────────────────────────────────────
  创建: session-c1 (Crawler, 无 Thread)
  执行: Turn 1 — 爬取资讯

Step 2: Crawler → Master（创建根 Thread）
────────────────────────────────────────────
  创建: Thread-1 "3/29 AIGC资讯"
         participants: [Crawler/session-c1]
  创建: Artifact "日报.md" in Thread-1
  创建: Message msg-001 (Crawler → Master)
  创建: session-m1 (Master, Thread-1)
         Thread-1 participants 更新: +Master/session-m1
  事件: thread:created, message:sent, agent:auto_resume

Step 3: Master 评审 + 用户确认
────────────────────────────────────────────
  执行: session-m1 Turn 1
         读取日报.md → 筛选 → ask_user_question("做哪些?")
  用户: "做第1条Sora、第3条GPT-5"

Step 4: Master 扇出（创建子 Thread）
────────────────────────────────────────────
  执行: session-m1 Turn 1 (继续)

  调用: save_artifact("sora-brief.md") → Thread-1
  调用: send_message(@creator, new_thread=true, title="Sora发布")
    创建: Thread-2, parentThreadId=Thread-1
    创建: session-c2 (Creator, Thread-2)
    注意: Master 不加入 Thread-2（lazy creation）

  调用: save_artifact("gpt5-brief.md") → Thread-1
  调用: send_message(@creator, new_thread=true, title="GPT-5传闻")
    创建: Thread-3, parentThreadId=Thread-1
    创建: session-c3 (Creator, Thread-3)

  session-m1 Turn 1 结束

Step 5: Creator 并行创作
────────────────────────────────────────────
  session-c2 Turn 1 (Thread-2): 创作 → save_artifact("draft-v1.md") → send_message(@master)
  session-c3 Turn 1 (Thread-3): 创作 → save_artifact("draft-v1.md") → send_message(@master)
  （两个 Session 在独立 QueryQueue 中并行执行）

Step 6: Master 评审（lazy Session 创建）
────────────────────────────────────────────
  创建: session-m2 (Master, Thread-2) ← Creator 的消息触发
  执行: session-m2 Turn 1: 评审 → send_message(@creator, "标题需修改")

  创建: session-m3 (Master, Thread-3) ← Creator 的消息触发
  执行: session-m3 Turn 1: 评审通过 → send_message(@ops, new_thread=true, title="GPT-5-运营") → complete_thread()

Step 7: Creator 迭代 (Thread-2)
────────────────────────────────────────────
  session-c2 Turn 2 (auto-resume): 修改 → send_message(@master)
  session-m2 Turn 2 (auto-resume): 评审通过 → send_message(@ops, new_thread=true, title="Sora-运营") → complete_thread()

Step 8: Ops 排期发布
────────────────────────────────────────────
  创建: Thread-4 (GPT-5运营), Thread-5 (Sora运营)
  创建: session-o1, session-o2 (Ops)
  Ops 执行发布排期逻辑 → complete_thread()
```

### Session 全景

```
Agent     │ Sessions
──────────┼──────────────────────────────────────
Crawler   │ session-c1  (Thread-1)
Master    │ session-m1  (Thread-1)  — 日报评审 + 扇出
          │ session-m2  (Thread-2)  — Sora 评审
          │ session-m3  (Thread-3)  — GPT-5 评审
Creator   │ session-c2  (Thread-2)  — Sora 创作
          │ session-c3  (Thread-3)  — GPT-5 创作
Ops       │ session-o1  (Thread-4)  — GPT-5 运营
          │ session-o2  (Thread-5)  — Sora 运营
```

### Thread 树

```
Thread-1 "3/29 AIGC资讯" (root)
├── Thread-2 "Sora发布内容创作"
│   └── Thread-5 "Sora-运营"
└── Thread-3 "GPT-5传闻内容创作"
    └── Thread-4 "GPT-5-运营"
```

### 验证覆盖的协作模式

| 协作模式 | 场景中的体现 |
|---------|------------|
| 串行传递 | Crawler → Master → Ops |
| 双向迭代 | Creator ↔ Master（评审循环） |
| 扇出分发 | Master → Creator ×2（new_thread） |
| 人工介入 | Master 通过 ask_user_question 与用户确认 |
| Lazy Session | Master 在子 Thread 中的 Session 延迟创建 |
| 并行执行 | 两个 Creator Session 独立运行 |
| Thread 树 | 5 个 Thread 形成两层树结构 |
