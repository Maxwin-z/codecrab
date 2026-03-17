# Autonomous Agent System - Technical Architecture Design

> 设计日期: 2026-03-16
> 状态: Draft v2
> 目标: 构建一个可拔插、可替换的自主智能体系统，能够自主调研、分析、决策，并在关键节点请求人工介入。

---

## 1. 设计目标

构建一个**持续运行的 AI 产品经理/商业分析师**，具备：

1. **自主信息采集** — 定时抓取市场数据、竞品动态、用户反馈
2. **分析与判断** — 用户分析、价值分析、商业判断
3. **方案产出** — MVP 规划、营销策略、上线计划
4. **自我进化** — 基于用户交互和反馈优化自身的分析能力（SOUL 机制）
5. **关键节点人类介入** — 半自主模式，不是全自主

---

## 2. 设计原则

- **可拔插** — 每个模块都可独立替换，不影响其他模块
- **增量添加** — 所有新模块都是增量添加，不改现有 EngineAdapter / MCP / Cron 接口
- **分层清晰** — Agent（执行者）、Orchestrator（编排者）、Identity（认知）、Workspace（产物）职责分离
- **统一引擎** — 所有 LLM 交互都走 EngineAdapter → Agent SDK 路径，不引入平行的 API 调用链
- **成本敏感** — 通过触发策略和模型选择控制成本，而非拆分调用路径

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Layer 4: Communication                   │
│              (WebSocket, Push, 定时报告, 人工介入)              │
├─────────────────────────────────────────────────────────────┤
│                     Layer 3: Orchestrator                     │
│           "大脑" — 目标分解、任务调度、人工检查点                  │
│                                                               │
│  GoalPlanner → TaskScheduler → AgentRouter → CheckpointGate  │
├──────────────┬────────────────────────────────────────────────┤
│  Layer 2a:   │  Layer 2b:                                     │
│  User Agents │  Internal Agents                               │
│  (用户会话)   │  (后台任务)                                     │
│              │                                                 │
│ ┌──────────┐ │ ┌──────────────┐  ┌──────────────┐            │
│ │CodeAgent │ │ │ SoulAgent    │  │ ResearchAgent│            │
│ │(用户交互) │ │ │ (SOUL 进化)  │  │ (信息采集)    │            │
│ └──────────┘ │ └──────────────┘  └──────────────┘            │
│              │                                                 │
│  全部通过 EngineAdapter 统一接口                                │
├──────────────┴────────────────────────────────────────────────┤
│                Layer 1b: Workspace（工作产物，项目/任务级）       │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐              │
│  │Research/ │  │Plans/    │  │Artifacts/     │              │
│  │调研产物   │  │方案与计划 │  │其他交付物      │              │
│  └──────────┘  └──────────┘  └───────────────┘              │
├─────────────────────────────────────────────────────────────┤
│         Layer 1a: Identity Store（SOUL 项目，长期认知）         │
│                                                               │
│  ~/.codecrab/soul/  ← 注册为内部项目                          │
│  ┌────────────┐  ┌──────────┐  ┌──────────┐                 │
│  │SOUL.json   │  │CLAUDE.md │  │Insights/ │                 │
│  │用户画像     │  │进化规则   │  │持久洞察   │                 │
│  └────────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 核心架构变更：SOUL 从 Pipeline 升级为 Agent

### 4.1 为什么改

v1 中 SOUL 是一个 Pipeline（直接调用 Anthropic API 的无状态批处理器）。经过 Phase 1 实现后发现：

1. **维护了两条 LLM 调用路径** — EngineAdapter (Agent SDK) 和直接 `@anthropic-ai/sdk` 调用，增加复杂度
2. **能力受限** — Pipeline 是纯文本 in/out，不能读写文件、不能查看历史、不能执行验证
3. **模型配置割裂** — Pipeline 需要单独的 API key 和模型配置，与主引擎的配置系统脱节
4. **SOUL 项目天然适合 Agent** — SOUL 数据就是文件（SOUL.json、insights/），Agent 可以直接读写

### 4.2 新方案

**把 SOUL 的 Identity Store 注册为一个内部项目**，用现有的 EngineAdapter 来执行进化：

```
用户 session query_end
    │
    ▼
提取本轮 { userMessage, assistantResponse, timestamp }
    │
    ▼
创建/复用 SOUL 项目的 session
    │
    ▼
发送进化 prompt → Agent 读取 SOUL.json → 分析 → 写回更新
    │
    ▼
前端通过 REST API 读取最新 SOUL 状态
```

Agent 在 SOUL 项目目录下工作，可以：
- 读取 SOUL.json 了解当前画像
- 分析对话内容提取信号
- 直接修改 SOUL.json 完成进化
- 写入 insights/ 沉淀洞察
- 参考 CLAUDE.md 中的进化规则

---

## 5. Layer 1a: Identity Store — SOUL 项目

SOUL 的 Identity Store 不再是一个自定义的文件管理类，而是一个**标准的 CodeCrab 项目**：

### 5.1 项目目录结构

```
~/.codecrab/soul/                   ← 注册为内部项目 (id: "__soul__")
├── CLAUDE.md                        ← 进化规则、行为约束、输出格式
├── SOUL.json                        ← 当前用户画像（Agent 直接读写）
├── evolution-log.jsonl              ← 进化历史（Agent 追加写入）
└── insights/                        ← 持久洞察（Agent 管理）
    ├── communication-patterns.md
    └── domain-expertise.md
```

### 5.2 CLAUDE.md — 进化规则

```markdown
# SOUL Evolution Agent

你是 SOUL 进化引擎，负责维护和更新用户画像文件 SOUL.json。

## 规则

1. **保守更新** — 只有在证据充分时才修改字段，宁可不改也不乱改
2. **渐进式** — 每次最多改 2-3 个字段，不做大幅重写
3. **可解释** — 每次修改都要在 evolution-log.jsonl 中记录原因
4. **不可臆造** — 只基于提供的对话证据推断，不编造用户特征

## 工作流

1. 读取当前 SOUL.json
2. 分析提供的对话内容
3. 决定是否需要更新（大多数情况下不需要）
4. 如果需要更新，修改 SOUL.json 并追加 evolution-log.jsonl
5. 如果发现可沉淀的洞察，写入 insights/ 目录

## 输出格式

完成后输出简短的总结，说明做了什么改动（或为什么没有改动）。
```

### 5.3 内部项目注册

在 `projects.json` 中自动注册，但标记为内部项目，前端隐藏：

```typescript
{
  id: '__soul__',
  name: 'SOUL',
  path: '~/.codecrab/soul',
  icon: '🧠',
  internal: true   // 前端 ProjectList 过滤掉
}
```

---

## 6. Layer 1a & 1b 的关键区分：Identity Store vs Workspace

底层存储拆分为两层，区分"Agent 的认知"和"Agent 的产出"：

| 维度 | Identity Store (Layer 1a) | Workspace (Layer 1b) |
|------|--------------------------|----------------------|
| 本质 | Agent 对用户的理解与积累 | 任务执行的交付物 |
| 实现 | 一个内部项目 (`__soul__`) | 按项目隔离的目录 |
| 生命周期 | 长期，跨项目 | 任务/项目级，有时效性 |
| 隔离方式 | 全局唯一（一个用户一份） | 按项目隔离 |
| 进化机制 | SoulAgent 作用于此 | 不参与进化 |
| 内容 | SOUL.json、Insights | Research、Plans、Artifacts |
| 清理策略 | 仅追加/修正，不轻易删除 | 可归档、可清理过期产物 |

---

## 7. Layer 2: 统一 Agent 架构

### 7.1 核心变更：去掉 Pipeline 层

v1 中有两种执行单元（Agent + Pipeline）。v2 **统一为 Agent**：

| 维度 | v1 (Agent + Pipeline) | v2 (统一 Agent) |
|------|----------------------|-----------------|
| LLM 调用路径 | 两条：Agent SDK + 直接 API | 一条：Agent SDK |
| SOUL 进化 | Pipeline (Haiku 直接调用) | SoulAgent (EngineAdapter) |
| 模型配置 | 两套：models.json + 硬编码 | 一套：models.json |
| 外部依赖 | `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/sdk` | 仅 `@anthropic-ai/claude-agent-sdk` |
| 文件操作 | 自定义 IdentityStore 类 | Agent 原生工具 (Read/Edit/Write) |

### 7.2 EngineAdapter（已有，不改）

```typescript
// 文件: packages/server/src/engine/types.ts
// 所有 Agent（User CodeAgent、SoulAgent、ResearchAgent）都通过此接口

interface EngineAdapter {
  id: string
  name: string
  init(config: EngineConfig): Promise<void>
  dispose(): Promise<void>
  createSession(opts: CreateSessionOpts): Promise<EngineSession>
  resumeSession(sessionId: string): Promise<EngineSession>
  destroySession(sessionId: string): Promise<void>
  query(session: EngineSession, prompt: string, opts: QueryOpts): AsyncIterable<StreamEvent>
  abort(session: EngineSession): void
}
```

### 7.3 Agent 类型划分

```
EngineAdapter
  ├── User Agents（前台，用户直接交互）
  │   └── CodeAgent — 现有的 Claude Code SDK 实现
  │
  └── Internal Agents（后台，系统自动触发）
      ├── SoulAgent — SOUL 进化，操作 __soul__ 项目
      └── ResearchAgent — 信息采集（Phase 2）
```

所有 Agent 共享：
- 同一个 `models.json` 配置
- 同一个 Agent SDK 初始化路径
- 同一个 session 管理机制

Internal Agent 的区别：
- `permissionMode: 'bypassPermissions'`（后台运行，无需用户审批）
- 独立的 `projectId`（不与用户项目混淆）
- 不广播到用户的 WebSocket（静默执行）
- 可指定不同的 model（通过 session 的 `model` 字段）

---

## 8. SoulAgent 详细设计

### 8.1 触发时机

```
用户 session 完成一轮 query
    │
    ▼
query_end 事件（ws/index.ts 中的 finally 块）
    │
    ▼
SoulAgent 触发器（异步，不阻塞用户）
    │
    ├── 提取 SessionTurn 数据：
    │   ├── turn.prompt.text → userMessage
    │   ├── turn.agent.messages (text events) 或 turn.summary → assistantResponse
    │   └── turn.timestamp → timestamp
    │
    ├── 批量策略（可选）：
    │   └── 攒 N 轮后批量处理，减少触发频率
    │
    └── 调用 EngineAdapter.query()
        ├── projectId: '__soul__'
        ├── cwd: '~/.codecrab/soul'
        └── prompt: 进化指令 + 对话数据
```

### 8.2 进化 Prompt 模板

```
以下是用户最近的一轮对话，请根据 CLAUDE.md 中的规则分析并决定是否需要更新 SOUL。

---对话---
时间: {timestamp}
用户: {userMessage}
助手: {assistantResponse}
---

请先读取 SOUL.json，然后分析这段对话是否揭示了用户的新特征或偏好变化。
如果需要更新，直接修改 SOUL.json 并记录到 evolution-log.jsonl。
```

### 8.3 Session 策略

**每次新建 session**，原因：

1. SOUL.json 本身就是持久化的状态，不需要靠 session 记忆
2. 避免长驻 session 的 context window 膨胀
3. 每次进化是独立判断，不应受上次 session 的上下文影响
4. 成本可控：单次 query 完成即销毁

### 8.4 成本控制

| 策略 | 说明 |
|------|------|
| 触发节流 | 不是每轮都触发，积攒 3-5 轮后批量处理 |
| 模型选择 | SoulAgent 可在 CreateSessionOpts 中指定较便宜的模型 |
| 短 prompt | 进化 prompt 精简，减少 input token |
| 快速退出 | CLAUDE.md 中明确指示"大多数情况下不需要更新"，Agent 快速判断后退出 |
| maxTurns 限制 | 设置较低的 maxTurns（如 5），防止 Agent 过度交互 |

---

## 9. Orchestrator（Layer 3）

```typescript
// 文件: packages/server/src/orchestrator/types.ts
// 编排层 — 目标分解、任务调度、人工检查点

interface Orchestrator {
  submitGoal(goal: Goal): Promise<string>
  decomposeGoal(goalId: string): Promise<Task[]>
  scheduleTask(task: Task): Promise<void>
  checkpoint(taskId: string): Promise<CheckpointResult>
}
```

---

## 10. 数据类型定义

### 10.1 SOUL 相关

```typescript
interface SoulDocument {
  identity: {
    name: string
    role: string
    expertise: string[]
  }
  preferences: {
    communicationStyle: string   // "简洁直接" | "详细解释" | ...
    decisionStyle: string        // "数据驱动" | "直觉导向" | ...
    riskTolerance: string        // "保守" | "激进" | ...
  }
  values: Record<string, string>
  context: {
    activeGoals: string[]
    domain: string
    constraints: string[]
  }
  meta: {
    version: number
    lastUpdated: string
    evolutionLog: EvolutionEntry[]
  }
}

interface EvolutionEntry {
  timestamp: string
  changes: SoulDiff[]
  reasoning: string
}

interface SoulDiff {
  path: string       // 如 "preferences.communicationStyle"
  before: string
  after: string
}
```

### 10.2 编排相关

```typescript
interface Goal {
  id: string
  description: string
  priority: 'low' | 'medium' | 'high'
  deadline?: string
  checkpointPolicy: 'every-task' | 'daily' | 'on-completion' | 'critical-only'
}

interface Task {
  id: string
  goalId: string
  type: 'research' | 'analysis' | 'plan' | 'soul-update' | 'report'
  agentId: string        // 分配给哪个 Agent
  projectId: string      // 在哪个项目下执行
  prompt: string
  schedule?: string      // cron 表达式
  dependencies: string[]
  status: 'pending' | 'scheduled' | 'running' | 'checkpoint' | 'completed' | 'failed'
  artifacts: string[]
}
```

---

## 11. 模块通信流示例

### 11.1 SOUL 进化流（v2）

```
用户在 CodeAgent session 中完成一轮对话
    │
    ▼
query_end (ws/index.ts finally block)
    │
    ▼
异步触发 SoulAgent
    │
    ▼
┌─ SoulAgent (在 __soul__ 项目中) ─────────────────┐
│                                                     │
│  1. 收到 prompt（包含对话数据）                       │
│  2. Read("SOUL.json") — 用 Agent 原生工具           │
│  3. 分析对话，判断是否有新信号                        │
│  4. 如果有：                                        │
│     ├── Edit("SOUL.json") — 更新字段                │
│     ├── Bash("echo '...' >> evolution-log.jsonl")  │
│     └── Write("insights/xxx.md") — 沉淀洞察        │
│  5. 如果没有：直接输出"无需更新"并结束                │
│                                                     │
│  整个过程: 1 session, 1-3 turns, 静默执行            │
└─────────────────────────────────────────────────────┘
    │
    ▼
前端 polling / REST API 读取最新 SOUL 状态
```

### 11.2 用户下达研究目标

```
用户: "调研 AI coding 工具市场，找到差异化机会"
    │
    ▼
┌─ Orchestrator ─────────────────────────────────────────┐
│                                                         │
│  GoalPlanner（用 LLM 拆解目标）                          │
│    ├─ Task 1: 收集 Top 20 AI coding 工具信息  → ResearchAgent
│    ├─ Task 2: 分析用户痛点和评价              → ResearchAgent
│    ├─ Task 3: 竞品功能矩阵对比                → CodeAgent
│    ├─ Task 4: 差异化机会分析                  → CodeAgent  (依赖 1,2,3)
│    ├─ Task 5: MVP 方案草案                   → CodeAgent   (依赖 4)
│    └─ Task 6: 更新 SOUL（学习用户判断偏好）    → SoulAgent   (贯穿全程)
│                                                         │
│  每个 Task 都通过 EngineAdapter 执行                     │
│  每个 Agent 在自己的 project 目录下工作                   │
└─────────────────────────────────────────────────────────┘
```

### 11.3 日常自主运行

```
Cron 触发（基于现有 CronScheduler）
    │
    ├─ 每日 09:00: ResearchAgent 抓取动态
    │   → 在 workspace/{project}/research/ 下工作
    │
    ├─ 每周一 10:00: CodeAgent 汇总周报
    │   → Push 通知用户
    │
    ├─ 每次对话结束: SoulAgent 分析对话
    │   → 在 __soul__ 项目下工作
    │
    └─ 触发式: 检测到重要事件
        → checkpoint: 推送给用户决定是否深入
```

---

## 12. 与现有 CodeCrab 代码的对接

| 新模块 | 对接方式 | 改动量 |
|--------|---------|--------|
| SoulAgent | 复用 EngineAdapter + executeQuery，新增触发逻辑 | 新文件 + ws/index.ts 小改 |
| __soul__ 项目 | 自动注册到 projects.json，创建 CLAUDE.md | 新目录 + 初始化逻辑 |
| ResearchAgent | 实现 EngineAdapter，注册到引擎列表 | 新文件 |
| Orchestrator | 基于现有 CronScheduler 扩展，复用 QueryQueue | 扩展现有模块 |
| Workspace | 复用 `~/.codecrab/` 目录结构，新增 `workspace/` | 文件约定 |
| CheckpointGate | 复用现有 WebSocket `ask_user_question` 消息类型 | 最小改动 |

### 代码变更清单

#### 删除（v1 Pipeline 相关）

```
packages/server/src/pipeline/          ← 整个目录删除
packages/server/src/soul/evolution/    ← 整个目录删除
packages/server/src/identity/          ← IdentityStore 不再需要（Agent 直接操作文件）
```

#### 新增

```
packages/server/src/
├── soul/
│   ├── types.ts              ← 保留（SoulDocument 等类型定义）
│   ├── agent.ts              ← 新增（SoulAgent 触发器 + prompt 构建）
│   └── project.ts            ← 新增（__soul__ 项目初始化 + CLAUDE.md 管理）
└── orchestrator/             ← Phase 3
    ├── types.ts
    ├── planner.ts
    ├── scheduler.ts
    ├── router.ts
    └── checkpoint.ts
```

#### 修改

```
packages/server/src/ws/index.ts       ← query_end 处添加 SoulAgent 异步触发
packages/server/src/api/soul.ts       ← 简化：读取 __soul__ 项目的文件，去掉 pipeline 调用
packages/server/src/engine/claude.ts  ← 可能需要支持 internal agent 的静默执行模式
packages/server/package.json          ← 移除 @anthropic-ai/sdk 直接依赖
```

### 存储目录结构

```
~/.codecrab/
├── config.json               ← 不改
├── models.json               ← 不改（SoulAgent 也用这里的配置）
├── projects.json             ← 自动注册 __soul__ 项目
├── sessions/                 ← SoulAgent 的 session 也在这里
├── cron/                     ← 不改
│
│  ── Identity Store (SOUL 项目) ──
├── soul/                     ← __soul__ 项目目录
│   ├── CLAUDE.md             ← 进化规则（Agent 的行为指南）
│   ├── SOUL.json             ← 用户画像（Agent 直接读写）
│   ├── evolution-log.jsonl   ← 进化历史（Agent 追加）
│   └── insights/             ← 持久洞察（Agent 管理）
│
│  ── Workspace（按项目隔离）──
└── workspace/
    └── {project-id}/
        ├── research/
        ├── plans/
        └── artifacts/
```

---

## 13. 实施优先级

| 阶段 | 模块 | 内容 |
|------|------|------|
| Phase 1 ✅ | SOUL 类型 + REST API + 前端 | 已完成（Dashboard、SoulCard、SoulPage） |
| Phase 1.5 | SoulAgent 重构 | 删除 Pipeline/EvolutionStrategy，实现 Agent 驱动的进化 |
| Phase 2 | 自动触发 | query_end hook + 触发节流 + 批量策略 |
| Phase 3 | ResearchAgent + Orchestrator | 自主信息采集和任务编排 |
| Phase 4 | CheckpointGate + Communication | 人工介入与通知推送 |

---

## 14. 设计决策记录

### 决策 1: ~~SOUL 生成用直接 API 调用~~ → SOUL 进化通过 Agent SDK

**v1 原因：** Agent SDK 的工具集过重，对纯文本处理成本高。
**v2 变更：** 实践发现维护两条 LLM 调用路径（Agent SDK + 直接 API）增加了不必要的复杂度。SOUL 进化需要文件读写能力，Agent 的工具集恰好满足。通过 CLAUDE.md 约束行为 + maxTurns 限制 + 触发节流控制成本。

### 决策 2: SOUL 消费通过注入 CLAUDE.md 或同等机制

**原因：** Agent SDK 原生支持 CLAUDE.md 上下文注入，零额外开发成本。SOUL 内容聚焦"协作偏好"而非"角色扮演"，不会干扰编码能力。

### 决策 3: EvoAgentX 理念内化，不直接依赖

**原因：** EvoAgentX 是 Python 框架，直接作为 TypeScript 插件不可行。其 TextGrad/反馈循环的核心思想通过 CLAUDE.md 中的进化规则来体现，而非实现为独立的 EvolutionStrategy 类。

### 决策 4: ResearchAgent 实现 EngineAdapter 而非新接口

**原因：** 复用现有的会话管理、流式输出、WebSocket 协议。ResearchAgent 本质上也是"给 prompt → 流式返回结果"，和 CodeAgent 的交互模式一致。

### 决策 5: 底层存储拆分为 Identity Store 和 Workspace

**原因：** "Agent 对用户的认知"（SOUL、Insights）和"Agent 的工作产物"（Research、Plans、Artifacts）本质不同。前者是长期跨项目积累，后者是任务级交付物。拆分后各自独立管理。

### 决策 6: SOUL Identity Store 实现为内部项目而非自定义存储类

**原因：** 把 `~/.codecrab/soul/` 注册为项目后，Agent 可以直接用原生工具（Read/Edit/Write/Bash）操作其中的文件。无需维护 IdentityStore 类的 loadSoul/saveSoul 等方法——Agent 就是 store。同时天然获得 CLAUDE.md 行为约束、session 管理、模型配置等基础设施。

---

## 15. 开源项目参考

| 项目 | Stars | 借鉴点 |
|------|-------|--------|
| **MetaGPT** | 65k | 多角色协作模式、PRD 生成流程 |
| **GPT Researcher** | 26k | 深度研究 agent 的 planner-executor 架构 |
| **EvoAgentX** | 2.6k | 自进化策略（TextGrad, MIPRO）、HITL 管理器 |
| **LangGraph** | 25k | 图工作流、human-in-the-loop 的 interrupt() 模式 |
| **CrewAI** | 44k | 角色扮演多 agent 编排 |
| **Agno** | 39k | 四层记忆系统、TypeScript 友好 |
| **OpenClaw Heartbeat** | 302k | 定时巡检、事件中继、后台维护模式 |
