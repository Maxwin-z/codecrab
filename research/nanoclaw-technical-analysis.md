# NanoClaw 竞品技术调研

**调研日期**: 2026-03-23
**仓库地址**: https://github.com/qwibitai/nanoclaw

---

## 一、项目概述

NanoClaw 是一个轻量级个人 AI 助手框架，将 Claude 代理连接到消息平台（WhatsApp、Telegram、Discord、Slack、Gmail）。每次 agent 调用都在独立 Docker 容器中运行，提供安全沙箱隔离。

核心能力：

- **多渠道消息接入** — 接收聊天平台消息，路由给 Claude，返回响应
- **群组隔离** — 每个聊天群有独立文件系统、CLAUDE.md 记忆和容器沙箱
- **定时任务** — cron、interval、once 三种调度模式
- **Agent Swarms** — 支持 Claude Code 的多 agent 协作
- **远程控制** — 通过聊天触发 `claude remote-control` 会话
- **浏览器** — 容器内含 Chromium 支持 agent 驱动的 web 访问

---

## 二、架构设计

### 2.1 整体架构

单进程 Node.js，无微服务，无 HTTP 服务器，无 Web 框架。

```
┌─────────────────────────────────────────────────────┐
│                    Host Process                      │
│                                                      │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Message Loop │  │ Scheduler │  │ IPC Watcher  │  │
│  │ (2s poll)    │  │ (60s poll)│  │ (fs polling) │  │
│  └──────┬───────┘  └─────┬─────┘  └──────┬───────┘  │
│         │                │               │           │
│         └────────┬───────┘               │           │
│                  ▼                       │           │
│         ┌───────────────┐               │           │
│         │  GroupQueue   │               │           │
│         │ (concurrency) │               │           │
│         └───────┬───────┘               │           │
│                 │                        │           │
│  ┌──────────────┤────────────────────────┤──────┐   │
│  │              ▼                        ▼      │   │
│  │     Container Runner          IPC Handler    │   │
│  │     (docker run -i)          (JSON files)    │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────┐  ┌───────────────────────────┐    │
│  │ Credential   │  │ Channels                  │    │
│  │ Proxy :3001  │  │ (WhatsApp/TG/Discord/...) │    │
│  └──────────────┘  └───────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ SQLite (messages, tasks, sessions, state)    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
         │ docker run -i --rm
         ▼
┌─────────────────────────────────────────────────────┐
│               Docker Container                       │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ Agent Runner (index.ts)                      │   │
│  │  - Reads ContainerInput from stdin           │   │
│  │  - Calls SDK query() with MessageStream      │   │
│  │  - Outputs results via stdout markers        │   │
│  └──────────────────────┬───────────────────────┘   │
│                         │                            │
│  ┌──────────────────────┴───────────────────────┐   │
│  │ Claude Agent SDK                             │   │
│  │  - permissionMode: bypassPermissions         │   │
│  │  - Tools: Bash, Read, Write, Edit, Glob...   │   │
│  │  - MCP: nanoclaw (ipc-mcp-stdio.ts)          │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────┐  ┌───────────────────────────┐    │
│  │ /workspace/  │  │ Chromium + agent-browser  │    │
│  │  group/      │  └───────────────────────────┘    │
│  │  ipc/        │                                    │
│  │  global/ (ro)│                                    │
│  └──────────────┘                                    │
└─────────────────────────────────────────────────────┘
```

### 2.2 技术栈

| 类别 | 技术 |
|------|------|
| 语言/运行时 | TypeScript 5.7+, Node.js 20+ |
| AI SDK | `@anthropic-ai/claude-agent-sdk` (v0.2.76+) |
| MCP | `@modelcontextprotocol/sdk` (v1.12.1) |
| 数据库 | `better-sqlite3` (嵌入式 SQLite) |
| 容器 | Docker |
| 日志 | `pino` + `pino-pretty` |
| 调度 | `cron-parser` |
| 校验 | `zod` v4 |
| 测试 | `vitest` |
| 浏览器 | Chromium + `agent-browser` (容器内) |

### 2.3 安全模型（纵深防御）

| 层级 | 机制 |
|------|------|
| 文件系统 | 容器只能写本群文件夹；主群项目根只读挂载 |
| 密钥隔离 | `.env` 用 `/dev/null` 遮蔽；凭证代理注入 API key，容器内看不到 |
| 挂载控制 | 白名单存储在项目根外（`~/.config/nanoclaw/`），agent 无法修改 |
| IPC 授权 | 非主群只能向自己的 JID 发消息 |
| 触发控制 | 发送者白名单 + 触发模式（trigger/drop） |

---

## 三、核心代码实现

### 3.1 Agent Query 处理

**文件**: `container/agent-runner/src/index.ts`

容器内调用 SDK `query()`，使用自定义 `MessageStream`（AsyncIterable）保持多轮对话不退出：

```typescript
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

SDK 调用配置：

```typescript
query({
  prompt: stream,  // MessageStream async iterable
  options: {
    cwd: '/workspace/group',
    resume: sessionId,
    resumeSessionAt: resumeAt,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: globalClaudeMd  // 全局 CLAUDE.md 追加到系统提示词
    },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage', 'TodoWrite',
      'ToolSearch', 'Skill', 'NotebookEdit', 'mcp__nanoclaw__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      nanoclaw: { command: 'node', args: [mcpServerPath] }
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook()] }]
    },
  }
})
```

**流式消息处理极简** — 只关心最终结果：

| SDK 消息类型 | 处理方式 |
|-------------|---------|
| `system` (subtype `init`) | 记录 sessionId |
| `system` (subtype `task_notification`) | 打日志 |
| `assistant` | 记录 uuid 用于 resumeAt |
| `result` | `writeOutput()` 输出到 stdout |
| `text_delta`, `thinking_delta`, `tool_use`, `tool_result` 等 | **全部忽略** |

**查询循环**：query 完成 → 等待 IPC 输入 → 收到新消息 → 开启新 query → 循环。通过 `_close` 哨兵文件退出。

### 3.2 容器通信协议

**文件**: `src/container-runner.ts`

```
宿主机 → 容器:  stdin 传 ContainerInput JSON

容器 → 宿主机:  stdout 输出哨兵标记包裹的 JSON
                ---NANOCLAW_OUTPUT_START---
                {"status":"success","result":"...","newSessionId":"..."}
                ---NANOCLAW_OUTPUT_END---

双向 IPC:      共享挂载 /workspace/ipc/ 目录
                - messages/   容器写 → 宿主机读（发消息）
                - tasks/      容器写 → 宿主机读（任务 CRUD）
                - input/      宿主机写 → 容器读（后续消息注入）
                - input/_close 宿主机写（关闭哨兵）
```

容器超时策略：
- 硬超时 = `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)`
- 有流式输出时重置超时计时器
- 超时后先 `docker stop`（优雅），失败则 `SIGKILL`

### 3.3 消息循环与并发控制

**文件**: `src/index.ts`, `src/group-queue.ts`

消息循环（`startMessageLoop`）每 2 秒轮询 SQLite：

```
while (true) {
  messages = getNewMessages(registeredGroupJids, lastTimestamp)
  for each group with new messages:
    if group has active container:
      queue.sendMessage(jid, formatted)  // 管道注入到活跃容器
    else:
      queue.enqueueMessageCheck(jid)     // 排队等新容器
  sleep(POLL_INTERVAL)
}
```

`GroupQueue` 并发管理：

```
GroupState {
  active: boolean          // 是否有运行中的容器
  idleWaiting: boolean     // 容器是否空闲等待新消息
  isTaskContainer: boolean // 是否是定时任务容器
  runningTaskId: string    // 当前运行的任务 ID
  pendingMessages: boolean // 是否有待处理消息
  pendingTasks: QueuedTask[] // 待执行任务队列
  process: ChildProcess    // 容器进程引用
  retryCount: number       // 重试计数
}

规则：
- 全局并发上限 MAX_CONCURRENT_CONTAINERS (默认 5)
- 超出上限的群组进入 waitingGroups 等待队列
- 容器完成后: 先排空 pendingTasks → 再处理 pendingMessages → 再释放给 waitingGroups
- 任务优先于消息
- 失败时指数退避重试 (5 次, base=5000ms)
- 优雅关闭时不杀容器，让其自然结束
```

错误恢复 — 消息游标回滚：

```typescript
// 处理前保存旧游标
const previousCursor = lastAgentTimestamp[chatJid] || '';
lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;

// 如果出错且未发送过输出，回滚游标让重试能重新处理
if (hadError && !outputSentToUser) {
  lastAgentTimestamp[chatJid] = previousCursor;
}
```

### 3.4 定时任务调度

**文件**: `src/task-scheduler.ts`

三种调度类型：

| 类型 | 实现 |
|------|------|
| `cron` | `cron-parser` 解析表达式，支持时区 |
| `interval` | 固定毫秒间隔，**锚定到计划时间**而非当前时间防漂移 |
| `once` | 一次性，执行后不计算下次 |

```typescript
// interval 防漂移逻辑
let next = new Date(task.next_run!).getTime() + ms;
while (next <= now) {
  next += ms;  // 跳过所有错过的间隔，总是落在未来
}
```

调度器每 60 秒轮询 `getDueTasks()`，通过 `GroupQueue.enqueueTask()` 排队。任务在独立容器中执行，支持 `context_mode`：
- `isolated` — 新 session
- `group` — 复用群组当前 session

任务完成后 10 秒延迟关闭容器（给 MCP 调用留时间）。

容器内 MCP server（`ipc-mcp-stdio.ts`）提供 8 个工具：

| 工具 | 功能 |
|------|------|
| `send_message` | 通过 IPC 发消息到聊天平台 |
| `schedule_task` | 创建新定时任务 |
| `list_tasks` | 列出所有任务 |
| `pause_task` | 暂停任务 |
| `resume_task` | 恢复任务 |
| `cancel_task` | 取消定时任务（非中止运行中的 query） |
| `update_task` | 更新任务配置 |
| `register_group` | 注册新群组 |

### 3.5 取消/中止机制

**不支持用户主动中止正在运行的 query。**

- 没有 `AbortController`，没有信号机制
- SDK `query()` 的 `for await` 循环无法从外部中断
- `_close` 哨兵文件只是优雅关闭，等当前 query 完成后才退出循环
- 硬超时是最后手段（默认 IDLE_TIMEOUT + 30s），不是用户可触发的

### 3.6 用户交互（Ask User Question / 权限请求）

**完全没有。**

```typescript
permissionMode: 'bypassPermissions',
allowDangerouslySkipPermissions: true,
```

SDK 配置为跳过所有权限检查，永远不生成 `ask_user_question` 或 `permission_request` 事件。安全性完全依赖 Docker 容器沙箱。

---

## 四、提示词工程

### 4.1 分层系统提示词架构

```
Layer 1: SDK claude_code preset（基座系统提示词）
  │
  └─ Layer 2: global/CLAUDE.md（append 到系统提示词）
       │       → 助手人设 "Andy"、沟通规则、<internal> 标签用法、渠道格式规则
       │
       └─ Layer 3: 每个群组 CLAUDE.md（SDK 从 cwd 自动加载）
            │       → 主群: 管理员指令（群组管理、任务、数据库、挂载安全）
            │       → 其他群: 个性化定制
            │
            └─ Layer 4: 额外挂载目录 CLAUDE.md + container skills
                        → browser、capabilities、slack-formatting、status
```

### 4.2 XML 结构化消息格式

```xml
<context timezone="America/New_York" />
<messages>
<message sender="John" time="Mar 23, 2026, 10:30 AM">Hello @Andy</message>
<message sender="Jane" time="Mar 23, 2026, 10:31 AM">I'd like to know too</message>
</messages>
```

关键设计：
- 所有用户内容 **XML 转义**，防止 prompt 注入
- 时间戳 **本地化** 到配置时区
- 消息 **批量发送**（两次 agent 响应之间累积的所有消息一起发）
- Bot 自身消息在数据库层过滤

### 4.3 特殊提示词技术

| 技术 | 实现 |
|------|------|
| `<internal>` 隐藏推理 | agent 用标签包裹思考过程，`stripInternalTags()` 发送前剥离 |
| 定时任务前缀 | `[SCHEDULED TASK - ...]` 提示模型非实时用户消息 |
| MCP 工具描述 | 600+ 字描述作为隐式 prompt engineering |
| 渠道感知格式 | 按群组前缀（`slack_`/`whatsapp_`/`telegram_`/`discord_`）应用不同格式 |
| Container Skills | 4 个 skill 作为可调用知识（browser、capabilities、slack-formatting、status） |

### 4.4 会话管理

- 每个群组独立 session，存 SQLite，通过 `resume` + `resumeSessionAt` 跨查询恢复
- `PreCompact` hook 在上下文压缩前归档完整对话为 Markdown（长期记忆）
- `sessions-index.json` 索引所有 session 的摘要和首条提示词

---

## 五、与 CodeCrab 对比

### 5.1 功能对比表

| 维度 | CodeCrab | NanoClaw |
|------|----------|----------|
| **定位** | Web/iOS 交互式编码引擎 | 消息平台 AI 助手框架 |
| **交互方式** | WebSocket 实时双向通信 + REST API | 轮询 SQLite + 文件系统 IPC |
| **前端** | React Chat UI + 原生 iOS App | 无自有 UI，依赖第三方聊天平台 |
| **架构** | 6 包 pnpm monorepo | 单进程 + 容器两部分 |
| **安全模型** | Token 认证 + 权限提示系统 | Docker 容器沙箱 + 凭证代理 |
| **流式输出** | 实时推送所有事件 | 只取最终 result，丢弃中间事件 |
| **中止查询** | WebSocket `abort` 即时中止 | 无（只能等超时杀容器） |
| **用户交互** | ask_user_question + permission_request 双向 | 无（bypass 一切权限） |
| **隔离粒度** | 按 project/session | 按聊天群，每次新容器 |
| **SDK 调用** | 服务端直接调用 | 容器内调用 |
| **MCP 扩展** | cron、push、Chrome DevTools | send_message、task 管理 |
| **Web 服务器** | Express 5 + WebSocket | 无（仅凭证代理 HTTP） |
| **持久化** | 文件系统 JSON | SQLite |
| **并发控制** | 按 session | GroupQueue + MAX_CONCURRENT_CONTAINERS |
| **错误恢复** | WebSocket 重连 | 指数退避重试 + 游标回滚 |
| **定时任务** | MCP cron（pause/resume/trigger） | SQLite 调度器（cron/interval/once） |
| **部署** | 自部署/局域网 + Relay 中继 | 单机自部署 |

### 5.2 核心设计理念差异

**CodeCrab** — 完整的编码平台，强调实时交互体验（流式输出、工具调用可视化、权限请求 UI），传统 client-server 架构。

**NanoClaw** — 消息路由框架，核心价值在于将已有聊天平台作为前端，用 Docker 隔离实现"无权限提示"的全自动 agent 执行。没有自己的 UI，设计上是 bot 框架。

### 5.3 值得借鉴的设计

1. **凭证代理模式** — 容器永远看不到真实 API key，通过 HTTP proxy 注入。CodeCrab 可参考此模式在多租户场景下增强密钥隔离
2. **MessageStream async iterable** — 保持 SDK query 不退出，允许运行中注入新消息。适用于需要向活跃 query 追加上下文的场景
3. **PreCompact hook** — 上下文压缩前归档完整对话到 Markdown，实现跨 session 长期记忆
4. **消息游标回滚** — 错误且未发送输出时回滚游标，确保消息不丢失可重试
5. **`<internal>` 标签机制** — 让模型做 chain-of-thought 推理但不暴露给用户

### 5.4 CodeCrab 的优势

1. **实时流式输出** — 用户可见思考过程、工具调用、中间结果
2. **即时中止** — `abort` WebSocket 消息可立即停止 SDK 进程
3. **交互式权限/问答** — ask_user_question + permission_request 完整双向流
4. **低延迟** — WebSocket 双向通信 vs 轮询 + 文件 IPC
5. **自有 UI** — 丰富的前端体验（React + iOS native）
6. **无容器开销** — 直接进程内调用 SDK，不需要每次 docker run
