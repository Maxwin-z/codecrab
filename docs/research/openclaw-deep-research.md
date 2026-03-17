# OpenClaw 深度研究报告

> 研究日期: 2026-03-13
> 目标: 分析 OpenClaw 的深度任务执行、自主进化、核心架构和关键 Prompt，为 CodeCrab 设计类似能力提供参考。

---

## 1. 项目概述

OpenClaw 是一个**本地优先的个人 AI 助手平台**，以 Gateway 为中心的架构，支持 21+ 消息通道（WhatsApp、Telegram、Slack、Discord、iMessage 等），运行在用户设备上。

**核心定位**: "The AI that actually does things" — 不只是聊天，而是真正在计算机上执行任务。

**技术栈**: TypeScript (ESM), Node 22+, pnpm monorepo, pi-agent-core (核心 agent runtime)

**关键代码位置**: `~/workspace/openclaw/`

---

## 2. 核心架构

### 2.1 Gateway 控制面

Gateway 是整个系统的中枢，通过 WebSocket 协调所有组件：

```
                    ┌─────────────────────────────────┐
                    │         Gateway (WS:18789)       │
                    │  ┌──────────┐  ┌──────────────┐  │
                    │  │ Sessions │  │ Agent Runtime │  │
                    │  │  Store   │  │  (Pi Agent)   │  │
                    │  └──────────┘  └──────────────┘  │
                    │  ┌──────────┐  ┌──────────────┐  │
                    │  │  Tools   │  │   Routing    │  │
                    │  │ Registry │  │   Engine     │  │
                    │  └──────────┘  └──────────────┘  │
                    └────────┬────────────┬────────────┘
                             │            │
              ┌──────────────┼────────────┼──────────────┐
              │              │            │              │
        ┌─────┴────┐  ┌─────┴────┐ ┌─────┴────┐  ┌─────┴────┐
        │ Telegram  │  │ Discord  │ │  Slack   │  │  Web UI  │
        │ Channel   │  │ Channel  │ │ Channel  │  │ Channel  │
        └──────────┘  └──────────┘ └──────────┘  └──────────┘
```

### 2.2 Agent Runtime (Pi Agent)

核心运行时基于 `@mariozechner/pi-agent-core` 和 `@mariozechner/pi-coding-agent`，以嵌入模式运行在 Gateway 进程中。

**关键文件**:
- `src/agents/pi-embedded-runner/run.ts` — 主运行逻辑，管理 failover、compaction、auth rotation
- `src/agents/pi-embedded-runner/run/attempt.ts` — 单次运行尝试，构建 session、tools、system prompt
- `src/agents/pi-embedded-runner/runs.ts` — 运行状态管理（activeRuns map）
- `src/agents/pi-embedded-subscribe.ts` — 将 pi-agent-core 事件桥接为 OpenClaw stream 事件

### 2.3 模块组织

```
src/
├── agents/           # Agent runtime, tools, system prompt, skills, subagents (~555 files!)
├── memory/           # Vector memory: embeddings, hybrid search, QMD, temporal decay
├── sessions/         # Session store, persistence, compaction
├── providers/        # Model provider adapters (Copilot, Google, Qwen, etc.)
├── plugins/          # Plugin SDK, hook runner, tool registration
├── browser/          # Chrome DevTools Protocol automation
├── channels/         # Channel abstraction layer
├── routing/          # Message routing, session key resolution
├── context-engine/   # Context window management
├── cron/             # Scheduled task execution
├── security/         # Security policies, exec approval
├── cli/              # CLI commands
└── gateway/          # Gateway server, WS handlers
```

---

## 3. 深度任务执行 (Deep Task Execution)

这是 OpenClaw 最核心的能力。它通过多层机制实现了一个能够持续、深入地执行复杂任务的 Agent。

### 3.1 Agent Loop 执行流程

```
intake → context assembly → model inference → tool execution → streaming → persistence
         ↑                                            │
         └────────────── (tool results) ──────────────┘
```

**详细流程** (源码: `src/agents/pi-embedded-runner/run/attempt.ts`):

1. **Session Resolution & Validation** — 验证参数，解析 sessionKey，持久化 session 元数据
2. **Model & Context Preparation** — 解析 model/thinking/verbose 默认值，加载 skills snapshot
3. **Prompt Assembly** — 构建 system prompt，注入 bootstrap 文件、skills、context
4. **Session Write Lock** — 获取写锁，防止并发修改
5. **Agent Runtime Execution** — `runEmbeddedPiAgent` 通过 per-session + global queues 串行化运行
6. **Tool Streaming** — tool start/update/end 事件实时流式发送
7. **Compaction & Retry** — 自动 compaction 释放 context window，触发重试

### 3.2 核心工具系统

OpenClaw 提供了丰富的工具集，使 Agent 能够深入执行任务：

**文件工具** (源码: `src/agents/tool-catalog.ts`):
| 工具 | 描述 |
|------|------|
| `read` | 读取文件内容 |
| `write` | 创建或覆写文件 |
| `edit` | 精确编辑文件 |
| `apply_patch` | 多文件 patch |

**运行时工具**:
| 工具 | 描述 |
|------|------|
| `exec` | 执行 shell 命令（支持 sandbox/gateway/node 三种执行位置）|
| `process` | 管理后台进程（PTY 支持、background sessions）|

**Web 工具**:
| 工具 | 描述 |
|------|------|
| `web_search` | 网络搜索 |
| `web_fetch` | 获取网页内容 |
| `browser` | Chrome DevTools Protocol 浏览器自动化 |

**记忆工具**:
| 工具 | 描述 |
|------|------|
| `memory_search` | 语义搜索记忆 |
| `memory_get` | 读取记忆文件 |

**会话工具** (多 Agent 协作):
| 工具 | 描述 |
|------|------|
| `sessions_list` | 列出会话 |
| `sessions_history` | 查看会话历史 |
| `sessions_send` | 向其他会话发送消息 |
| `sessions_spawn` | 派生子 Agent |
| `sessions_yield` | 结束当前 turn 等待子 Agent 结果 |
| `subagents` | 管理子 Agent |

**自动化工具**:
| 工具 | 描述 |
|------|------|
| `cron` | 定时任务 |
| `node.invoke` | 调用设备节点（macOS/iOS/Android）|
| `canvas` | Agent 驱动的可视化工作区 |
| `tts` | 文本转语音 |

### 3.3 Exec 工具 — 深度执行的关键

`exec` 工具 (源码: `src/agents/bash-tools.exec.ts`) 是深度任务执行的核心：

**三层执行位置**:
- **Sandbox**: 容器化隔离环境（默认）
- **Gateway**: 宿主机执行，需要 approval
- **Node**: 配对的设备节点

**关键能力**:
- **PTY 支持**: 伪终端模式，支持交互式 CLI
- **后台执行**: `background:true` 启动后台会话，返回 sessionId
- **进程控制**: poll / log / write / submit / send-keys / paste / kill
- **扩展超时**: 默认 1800 秒
- **安全审批**: 通过 `exec-approvals.json` 控制命令执行权限

### 3.4 子 Agent 系统

OpenClaw 支持 Agent 派生子 Agent 来并行执行任务：

```typescript
// 源码: src/agents/subagent-spawn.ts, subagent-registry.ts
sessions_spawn → 创建子 Agent 会话
sessions_yield → 暂停当前 turn，等待子 Agent 结果
subagents → 查询/管理子 Agent 状态
```

**关键设计**:
- 子 Agent 有独立的 session key (`subagent:*`)
- 子 Agent 的 system prompt 使用 `minimal` 模式（只包含核心工具和工作区信息）
- 深度限制防止无限递归
- 完成后自动通知父 Agent

### 3.5 Coding Agent 技能 — 深度编码任务

`skills/coding-agent/SKILL.md` 定义了如何委派编码任务给外部 Agent（Codex、Claude Code、Pi）：

```bash
# 后台启动 Codex 处理编码任务
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a snake game'"

# 监控进度
process action:log sessionId:XXX

# 完成后通知
openclaw system event --text "Done: Built snake game" --mode now
```

**这实现了 Agent-of-Agents 模式**: OpenClaw Agent 作为编排者，将复杂编码任务委派给专门的编码 Agent。

### 3.6 并发执行与队列

```
Session Lane (per-session) ──┐
                              ├──→ Agent Run (serialized)
Global Lane (cross-session) ─┘
```

- 运行通过 **session lane** + **global lane** 串行化
- 消息通道可配置队列模式: `collect` / `steer` / `followup`
- `steer` 模式: 新消息可中断当前 tool call
- `collect/followup`: 消息排队等待 turn 完成

### 3.7 Context Window 管理

**自动 Compaction** (源码: `src/agents/pi-embedded-runner/compact.ts`):
- 当 session 接近 token 限制时自动触发
- 压缩旧的 tool results 和对话历史
- 压缩前触发 silent memory flush，让 Agent 将重要信息写入持久记忆
- Compaction 后可触发 retry

**Tool Result 截断** (源码: `src/agents/pi-embedded-runner/tool-result-truncation.ts`):
- 自动截断过大的 tool results
- 保留关键信息，移除冗余

### 3.8 Failover & 可靠性

**多 Provider Failover** (源码: `src/agents/pi-embedded-runner/run.ts`):
- 支持多个 model provider 和 auth profile
- 自动 failover: rate limit → 切换 profile → 切换 provider
- Backoff 策略: `initialMs: 250, maxMs: 1500, factor: 2, jitter: 0.2`
- Context overflow → 自动 compaction → retry
- Auth 错误 → profile cooldown → 尝试下一个 profile

### 3.9 Thinking Levels (思考深度)

7 级思考深度控制:

| Level | 描述 | 使用场景 |
|-------|------|---------|
| off | 关闭推理 | 简单查询 |
| minimal | 基础推理 | 一般对话 |
| low | 增强反思 | 需要分析 |
| medium | 深度分析 | 复杂问题 |
| high | 最大预算 (ultrathink) | 重要任务 |
| xhigh | 高级模型专用 | GPT-5.2, Codex |
| adaptive | Provider 管理 | Claude 4.6 默认 |

**解析优先级**: inline directive > session override > global config > provider fallback

---

## 4. 自主进化 (Autonomous Evolution)

OpenClaw 的"进化"不是通过重新训练模型，而是通过**持久化记忆 + 技能系统 + 工具扩展**实现的"环境进化"。

### 4.1 Memory System — 记忆驱动的进化

**架构** (源码: `src/memory/`):

```
                     ┌─────────────────────────────┐
                     │    Memory Manager            │
                     │  ┌─────────┐ ┌────────────┐  │
                     │  │ Vector  │ │   BM25     │  │
                     │  │ Search  │ │  Keyword   │  │
                     │  └────┬────┘ └─────┬──────┘  │
                     │       └──────┬─────┘         │
                     │         Hybrid Merge          │
                     │       ┌──────┴─────┐         │
                     │       │   MMR      │         │
                     │       │ Dedupe     │         │
                     │       └──────┬─────┘         │
                     │       ┌──────┴─────┐         │
                     │       │ Temporal   │         │
                     │       │  Decay     │         │
                     │       └────────────┘         │
                     └─────────────────────────────┘
```

**两层记忆组织**:
1. **Daily logs** (`memory/YYYY-MM-DD.md`): 追加式日志，加载今天和昨天的
2. **Long-term memory** (`MEMORY.md`): 策划的持久知识，仅私聊加载

**高级检索**:
- **Vector memory indexing**: 支持 OpenAI / Gemini / Voyage / Mistral / 本地 GGUF embeddings
- **Hybrid search**: 向量相似度 + BM25 关键词匹配
- **MMR (Maximal Marginal Relevance)**: 平衡相关性和多样性
- **Temporal decay**: 指数时间衰减，最近记忆优先，MEMORY.md 永不衰减
- **Query expansion**: 自动扩展查询词以提高召回率

**Memory flush before compaction**:
```
Session 接近 token limit
  → 触发 silent agentic turn
  → Agent 将重要事实写入 MEMORY.md
  → 然后进行 compaction
  → 关键信息不会丢失
```

**QMD backend (实验性)**: 本地优先的搜索引擎，结合 BM25 + vectors + reranking

### 4.2 Skills System — 能力扩展式进化

**技能是 OpenClaw 进化的主要载体** — 通过不断添加新技能，Agent 获得新能力。

**技能结构** (源码: `skills/*/SKILL.md`):

```
skill-name/
├── SKILL.md              # 必需: YAML frontmatter + Markdown 指令
├── scripts/              # 可执行脚本（确定性可靠任务）
├── references/           # 按需加载的参考文档
└── assets/               # 输出用文件（模板、图标等）
```

**三级渐进加载** (Progressive Disclosure):
1. **Metadata** (name + description): 始终在 context 中 (~100 words)
2. **SKILL.md body**: 技能触发时加载 (<5k words)
3. **Bundled resources**: Agent 按需加载（无限制）

**技能触发机制** (源码: `src/agents/system-prompt.ts` `buildSkillsSection`):
```
System Prompt 中注入:
"Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md, then follow it.
- If multiple could apply: choose the most specific one.
- If none clearly apply: do not read any SKILL.md."
```

**50+ 内置技能**, 包括:
- `coding-agent` — 委派编码任务
- `skill-creator` — 创建新技能（元技能）
- `github` / `gh-issues` — GitHub 操作
- `1password` — 密码管理
- `discord` / `slack` — 消息平台集成
- `nano-pdf` / `obsidian` / `notion` — 文件处理
- `weather` / `goplaces` — 信息查询
- `model-usage` — 模型使用分析
- `video-frames` / `camsnap` — 多媒体处理

**Skill Creator 元技能** (源码: `skills/skill-creator/SKILL.md`):
OpenClaw 可以**自己创建新技能**:
```bash
scripts/init_skill.py <skill-name> --path skills/public
# → 生成技能目录模板
# → Agent 编辑 SKILL.md 和资源
# → scripts/package_skill.py 打包为 .skill 文件
```

**ClawHub** (`clawhub.ai`): 技能市场，支持自动发现和按需安装

### 4.3 Plugin System — 深度定制式进化

**Plugin API** (源码: `src/plugins/`, `src/plugin-sdk/`):

```typescript
// Plugin 注册工具
api.registerTool({
  name: "my_tool",
  description: "...",
  parameters: { /* JSON Schema */ },
  optional: true,  // 不自动启用
  execute: async (id, params) => ({ content: [{ type: "text", text: "result" }] })
});
```

**Plugin Hooks** — 允许插件介入 Agent 生命周期的关键点:

| Hook | 时机 | 用途 |
|------|------|------|
| `before_model_resolve` | session 前 | 覆盖 provider/model 选择 |
| `before_prompt_build` | session 加载后 | 注入 context 或 system guidance |
| `before_tool_call` | tool 执行前 | 拦截/修改 tool 参数 |
| `after_tool_call` | tool 执行后 | 拦截/修改 tool 结果 |
| `tool_result_persist` | 写入 transcript 前 | 转换 tool result |
| `agent_end` | 运行结束 | 检查最终消息 |
| `before_compaction` / `after_compaction` | compaction 前后 | 观察压缩周期 |
| `message_received` / `message_sending` / `message_sent` | 消息生命周期 | 消息处理 |
| `session_start` / `session_end` | session 边界 | session 管理 |

**Extensions** (源码: `extensions/`):
- 20+ 扩展: msteams, matrix, zalo, voice-call 等
- 作为独立 workspace 包，有自己的 `package.json`
- 通过 plugin manifest 注册 channel adapters 和 tools

### 4.4 Self-Update 机制

System prompt 中包含 Self-Update 指导:
```
## Self-Update
Guidance on running config.apply and update.run
```

Agent 可以：
- 通过 `config.apply` 更新自身配置
- 通过 `update.run` 触发更新
- 通过 `openclaw doctor` 诊断问题

### 4.5 Bootstrap Files — 个性化进化

每个 Agent 通过以下 bootstrap 文件定义自己的"个性"：

| 文件 | 用途 | 加载时机 |
|------|------|---------|
| `AGENTS.md` | 操作指令和记忆 | 每次 turn |
| `SOUL.md` | 人格、边界、语气 | 每次 turn |
| `IDENTITY.md` | Agent 名称/风格/emoji | 每次 turn |
| `USER.md` | 用户画像 | 每次 turn |
| `TOOLS.md` | 用户维护的工具指导 | 每次 turn |
| `HEARTBEAT.md` | 心跳行为 | 每次 turn |
| `BOOTSTRAP.md` | 自定义引导内容 | 每次 turn |
| `MEMORY.md` | 记忆索引 | 每次 turn |

**限制**: 每文件 20,000 字符，总计 150,000 字符。子 Agent 只接收 AGENTS.md 和 TOOLS.md。

---

## 5. 关键 Prompt 设计

### 5.1 System Prompt 结构

System prompt 由 `buildSystemPrompt()` 函数构建 (源码: `src/agents/system-prompt.ts`)，包含以下固定 section:

```
1. Tooling         — 当前工具清单及简要描述
2. Safety          — 防止权力寻求或规避监督的安全护栏
3. Skills          — 技能加载指令（条件包含）
4. Memory Recall   — 记忆搜索指令
5. Self-Update     — 自更新指导
6. Workspace       — 工作目录路径
7. Documentation   — 本地文档路径
8. Workspace Files — Bootstrap 文件指示
9. Sandbox         — 运行时约束（条件包含）
10. Current Date   — 用户时区（用于缓存稳定性）
11. Reply Tags     — Provider 特定的响应格式
12. Heartbeats     — 心跳行为
13. Runtime        — OS, Node 版本, Model, Repo root, Thinking level
14. Reasoning      — 可见性级别和切换提示
```

**PromptMode 分三级**:
- `full`: 所有 section（主 Agent）
- `minimal`: 仅 Tooling + Workspace + Runtime（子 Agent）
- `none`: 仅身份行

### 5.2 Skills Prompt 注入

```typescript
// src/agents/system-prompt.ts:20-36
function buildSkillsSection(params) {
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    "- If exactly one skill clearly applies: read its SKILL.md at <location>, then follow it.",
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "- When a skill drives external API writes, assume rate limits...",
    trimmed,  // 实际的技能列表
  ];
}
```

### 5.3 Memory Recall Prompt

```typescript
// src/agents/system-prompt.ts:38-64
"## Memory Recall"
"Before answering anything about prior work, decisions, dates, people, preferences, or todos:
 run memory_search on MEMORY.md + memory/*.md;
 then use memory_get to pull only the needed lines.
 If low confidence after search, say you checked."
"Citations: include Source: <path#line> when it helps the user verify memory snippets."
```

### 5.4 Tool Loop Detection

```typescript
// src/agents/tool-loop-detection.ts
// 检测 Agent 是否陷入工具调用循环
// 例如: 反复调用同一个工具，参数相同但结果相同
```

### 5.5 Lobster Workflow Runtime

Lobster 是一个**类型化工作流运行时**，用于将多步骤工具序列封装为单个确定性操作：

```json
{
  "action": "run",
  "pipeline": "inbox list --json | inbox categorize --json | inbox apply --json | approve --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

**关键特性**:
- 链式管道: 小型 JSON CLI 命令通过 pipe 组合
- Approval Gates: 在副作用步骤暂停等待人类审批
- 可恢复状态: 暂停后返回 token，approve 后继续执行
- LLM 集成: `llm-task` 插件允许在确定性管道中嵌入 LLM 步骤

---

## 6. 对 CodeCrab 的设计建议

基于 OpenClaw 的深度研究，以下是 CodeCrab 应该实现的关键能力设计：

### 6.1 深度任务执行引擎

**当前 CodeCrab 状态**: 使用 EngineAdapter + ClaudeAdapter 的简单流式对话模式。

**建议增强**:

#### 6.1.1 Agent Loop 重构

```
当前: prompt → LLM → stream response → done
目标: prompt → context assembly → LLM → tool execution → feedback → LLM → ... → done
```

**具体实施**:
1. 在 `packages/server/src/engine/` 中实现 `AgentLoop` 类
2. 支持多轮 tool call — LLM 调用工具后，将结果反馈回 LLM 继续推理
3. 实现 tool dispatch — 根据 tool name 路由到对应的工具实现
4. 支持 abort — 通过 AbortSignal 中断运行

```typescript
// 建议的 AgentLoop 核心接口
interface AgentLoop {
  run(params: {
    sessionId: string;
    prompt: string;
    tools: ToolDefinition[];
    systemPrompt: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentEvent>;
}

type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'error'; error: string }
  | { type: 'done'; usage: Usage };
```

#### 6.1.2 Tool System

在 `packages/server/src/tools/` 中实现工具系统：

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(params: unknown, context: ToolContext): Promise<ToolResult>;
}

// 核心工具集
const CORE_TOOLS = [
  'read_file',      // 读取文件
  'write_file',     // 写入文件
  'edit_file',      // 精确编辑
  'exec',           // 执行命令
  'web_search',     // 网络搜索
  'web_fetch',      // 获取网页
  'list_files',     // 列出文件
  'search_code',    // 搜索代码
];
```

#### 6.1.3 Exec 工具安全模型

```typescript
// 三级执行策略
type ExecPolicy = 'sandbox' | 'approved' | 'elevated';

// Allowlist 机制
interface ExecApproval {
  binary: string;       // 允许的二进制路径
  args?: string[];      // 允许的参数模式
  autoApprove: boolean; // 是否自动审批
}
```

### 6.2 记忆系统

**当前 CodeCrab 状态**: 无持久记忆。

**建议实现**:

#### 6.2.1 文件型记忆

```
~/.codecrab/memory/
├── MEMORY.md           # 长期记忆索引
├── daily/
│   └── 2026-03-13.md   # 每日记忆
└── topics/
    ├── user-preferences.md
    └── project-decisions.md
```

#### 6.2.2 语义搜索

```typescript
// 1. 使用 embeddings 索引记忆文件
// 2. Hybrid search: vector + keyword (BM25)
// 3. MMR 去重
// 4. Temporal decay 时间衰减

interface MemoryManager {
  search(query: string): Promise<MemorySnippet[]>;
  get(path: string, lineRange?: [number, number]): Promise<string>;
  write(path: string, content: string): Promise<void>;
  flush(): Promise<void>; // compaction 前的记忆刷新
}
```

#### 6.2.3 Memory Flush Before Compaction

```
Token limit approaching
  → Silent turn: "Write important facts to memory"
  → Agent writes to MEMORY.md
  → Compaction proceeds safely
```

### 6.3 技能系统

**当前 CodeCrab 状态**: 无技能系统。

**建议实现**:

#### 6.3.1 Skill Format

```
~/.codecrab/skills/
└── my-skill/
    ├── SKILL.md          # name + description frontmatter + instructions
    ├── scripts/          # 可执行脚本
    ├── references/       # 参考文档
    └── assets/           # 资产文件
```

#### 6.3.2 Skill 加载机制

1. **Metadata 始终注入**: 所有技能的 name + description 注入 system prompt
2. **Lazy Loading**: 技能被触发时才加载 SKILL.md body
3. **Progressive Disclosure**: 技能中的 references 按需加载

#### 6.3.3 System Prompt 注入

```
## Skills (mandatory)
Before replying: scan <available_skills> descriptions.
- If one clearly applies: read its SKILL.md, then follow it.
- If none apply: do not read any SKILL.md.
```

#### 6.3.4 Skill Creator

实现 meta-skill 让 Agent 可以自己创建新技能。

### 6.4 Session 管理增强

**当前 CodeCrab 状态**: 基本 session 持久化。

**建议增强**:

#### 6.4.1 Session Compaction

```typescript
interface SessionCompaction {
  // 当 token 使用接近限制时
  shouldCompact(session: Session): boolean;
  // 执行 compaction: 压缩旧 tool results，保留关键上下文
  compact(session: Session): Promise<CompactedSession>;
}
```

#### 6.4.2 Session Reset Policy

```typescript
interface SessionResetPolicy {
  daily?: { time: string };     // 每日重置时间
  idle?: { minutes: number };   // 空闲重置
}
```

### 6.5 多 Agent 协作

**建议实现**:

#### 6.5.1 Sub-Agent Spawn

```typescript
// 主 Agent 可以派生子 Agent 执行独立任务
interface SubAgentSpawn {
  spawn(params: {
    task: string;
    workdir?: string;
    tools?: string[];
    promptMode?: 'full' | 'minimal';
  }): Promise<{ agentId: string; sessionId: string }>;

  yield(message?: string): Promise<void>;  // 暂停等待子 Agent
  getResults(agentId: string): Promise<SubAgentResult>;
}
```

#### 6.5.2 Coding Agent Integration

支持委派编码任务给外部 Agent：

```bash
# 通过 exec 工具启动 Claude Code
claude --permission-mode bypassPermissions --print 'Build feature X'
```

### 6.6 Plugin Hook System

**建议实现**:

```typescript
interface PluginHooks {
  before_model_resolve?: (event) => Promise<ModelOverride | undefined>;
  before_prompt_build?: (event) => Promise<PromptOverride | undefined>;
  before_tool_call?: (event) => Promise<ToolCallOverride | undefined>;
  after_tool_call?: (event) => Promise<ToolResultOverride | undefined>;
  agent_end?: (event) => Promise<void>;
}
```

### 6.7 System Prompt 工程

**建议实现分层 System Prompt**:

```
1. [Identity]     — Agent 身份和人格
2. [Tooling]      — 可用工具描述
3. [Safety]       — 安全护栏
4. [Skills]       — 技能加载指令
5. [Memory]       — 记忆搜索指令
6. [Bootstrap]    — AGENTS.md, USER.md 等自定义内容
7. [Context]      — 工作目录, 时间, OS 信息
8. [Runtime]      — Model, thinking level, 运行环境
```

**关键原则**:
- Conditional inclusion: 根据上下文动态包含/排除 section
- Token conservation: 按需加载，不浪费 context window
- Cache stability: 时区而非精确时间，提高 prompt cache 命中率

### 6.8 实施优先级建议

| 优先级 | 特性 | 价值 | 复杂度 |
|--------|------|------|--------|
| P0 | Agent Loop (多轮 tool call) | 极高 — 这是深度执行的基础 | 高 |
| P0 | Core Tools (read/write/edit/exec) | 极高 — Agent 需要操作环境的能力 | 中 |
| P1 | Session Compaction | 高 — 防止长对话 context overflow | 中 |
| P1 | Memory System (file-based) | 高 — 跨会话记忆 | 中 |
| P2 | Skills System | 高 — 能力扩展和进化 | 中 |
| P2 | Thinking Levels | 中 — 控制推理深度 | 低 |
| P2 | Plugin Hooks | 中 — 深度定制能力 | 中 |
| P3 | Sub-Agent System | 中 — 并行任务执行 | 高 |
| P3 | Lobster Workflow | 中 — 确定性工作流 | 高 |
| P3 | Semantic Memory Search | 中 — 智能记忆检索 | 高 |

---

## 7. 总结

OpenClaw 的强大来自于几个关键设计决策:

1. **Gateway-centric**: 所有能力通过一个 WebSocket 中心协调，而非分散在各处
2. **Tool-first**: Agent 的能力完全由 Tools 定义，工具即能力
3. **File-based Memory**: 简单但有效的文件型记忆，配合向量搜索实现语义检索
4. **Progressive Disclosure Skills**: 三级渐进加载，最大化 context window 利用
5. **Compaction + Memory Flush**: 保证长对话不丢失关键信息
6. **Plugin Hooks**: 深度定制的扩展机制，不改核心代码也能改变行为
7. **Multi-Provider Failover**: 高可靠性的 model 调用，自动切换 provider
8. **Agent-of-Agents**: 支持 Agent 派生子 Agent，实现任务分解和并行执行

CodeCrab 应当借鉴这些核心理念，按优先级逐步实现，最终达到类似的深度任务执行和自主进化能力。
