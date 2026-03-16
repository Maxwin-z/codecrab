# Autonomous Agent System - Technical Architecture Design

> 设计日期: 2026-03-16
> 状态: Draft
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
- **分层清晰** — Agent（执行者）、Pipeline（处理器）、Orchestrator（编排者）、Identity（认知）、Workspace（产物）职责分离
- **成本敏感** — 高频轻量任务用小模型（Haiku），低频深度任务用大模型（Sonnet/Opus）

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
├──────────────┬──────────────┬────────────────────────────────┤
│  Layer 2a:   │  Layer 2b:   │  Layer 2c:                     │
│  Agents      │  Pipelines   │  Evolution                     │
│  (执行者)     │  (处理器)     │  (进化引擎)                     │
│              │              │                                 │
│ ┌──────────┐ │ ┌──────────┐ │ ┌────────────┐                 │
│ │CodeAgent │ │ │  SOUL    │ │ │ EvoEngine  │                 │
│ │(Claude)  │ │ │ Pipeline │ │ │ (可插拔策略) │                 │
│ ├──────────┤ │ ├──────────┤ │ ├────────────┤                 │
│ │Research  │ │ │ Summary  │ │ │PromptEvo   │ ← 默认          │
│ │Agent     │ │ │ Pipeline │ │ │FeedbackEvo │ ← EvoAgentX 理念 │
│ │(GPT-R)   │ │ │          │ │ │RuleBasedEvo│ ← 轻量回退       │
│ ├──────────┤ │ └──────────┘ │ └────────────┘                 │
│ │Analysis  │ │              │                                 │
│ │Agent     │ │              │                                 │
│ └──────────┘ │              │                                 │
├──────────────┴──────────────┴────────────────────────────────┤
│                Layer 1b: Workspace（工作产物，项目/任务级）       │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐              │
│  │Research/ │  │Plans/    │  │Artifacts/     │              │
│  │调研产物   │  │方案与计划 │  │其他交付物      │              │
│  └──────────┘  └──────────┘  └───────────────┘              │
├─────────────────────────────────────────────────────────────┤
│             Layer 1a: Identity Store（个人认知，长期）          │
│                                                               │
│  ┌────────┐  ┌──────────┐  ┌──────────┐                     │
│  │SOUL.md │  │Memory/   │  │Insights/ │                     │
│  │用户画像 │  │对话记忆   │  │持久洞察   │                     │
│  └────────┘  └──────────┘  └──────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Layer 1a & 1b 的关键区分：Identity Store vs Workspace

底层存储拆分为两层，区分"Agent 的认知"和"Agent 的产出"：

| 维度 | Identity Store (Layer 1a) | Workspace (Layer 1b) |
|------|--------------------------|----------------------|
| 本质 | Agent 对用户的理解与积累 | 任务执行的交付物 |
| 生命周期 | 长期，跨项目 | 任务/项目级，有时效性 |
| 隔离方式 | 全局唯一（一个用户一份） | 按项目隔离 |
| 进化机制 | EvolutionStrategy 作用于此 | 不参与进化 |
| 内容 | SOUL（用户画像）、Memory（对话记忆）、Insights（持久洞察） | Research（调研产物）、Plans（方案计划）、Artifacts（交付物） |
| 清理策略 | 仅追加/修正，不轻易删除 | 可归档、可清理过期产物 |

**Insights 是连接两层的桥梁。** 调研产物（Workspace）是临时的，但从多次调研中提炼的模式和规律（如"这个市场的 Top 3 痛点"、"用户最关心的指标"）会沉淀到 Insights（Identity Store），让 Agent 在后续任务中越来越"懂行"。

---

## 5. Layer 2a & 2b 的关键区分：Agent vs Pipeline

系统中有两种执行单元，它们的职责和接口完全不同：

| 维度 | Agent (Layer 2a) | Pipeline (Layer 2b) |
|------|------------------|---------------------|
| 本质 | 交互式 AI 引擎 | 批处理数据管线 |
| 会话 | 有（session lifecycle） | 无 |
| 工具 | 有（文件编辑、Bash、MCP 等） | 无（纯文本 in/out） |
| 流式输出 | 有（AsyncIterable\<StreamEvent\>） | 无（Promise\<Output\>） |
| 人工交互 | 支持（权限请求、问答） | 不支持 |
| 代表 | CodeAgent (Claude Code SDK), ResearchAgent | SoulPipeline, SummaryPipeline |
| 成本 | 高（完整上下文 + 工具定义） | 低（精简 prompt） |

**SOUL 是 Pipeline，不是 Agent。** 它不需要工具、不需要会话、不需要流式输出。把它和 ResearchAgent 放在同一层会导致接口不匹配。

---

## 6. 核心接口定义

### 6.1 EngineAdapter（已有，不改）

```typescript
// 文件: packages/server/src/engine/types.ts
// 交互式 Agent 的统一接口，CodeAgent 和 ResearchAgent 都实现它

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

### 6.2 Pipeline（新增）

```typescript
// 文件: packages/server/src/pipeline/types.ts
// 无会话、无工具的批处理管线

interface Pipeline<TInput, TOutput> {
  id: string
  name: string
  init(config: PipelineConfig): Promise<void>
  dispose(): Promise<void>
  run(input: TInput): Promise<TOutput>
}

interface PipelineConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'local'
  model: string          // "claude-haiku-4-5" for 高频轻量, "claude-sonnet-4-6" for 深度分析
  systemPrompt: string
  maxTokens?: number
}
```

### 6.3 EvolutionStrategy（新增）

```typescript
// 文件: packages/server/src/soul/evolution/types.ts
// SOUL 进化策略的可插拔接口

interface EvolutionStrategy {
  id: string
  name: string
  evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<SoulDocument>
}
```

### 6.4 Orchestrator（新增）

```typescript
// 文件: packages/server/src/orchestrator/types.ts
// 编排层 — 目标分解、任务调度、人工检查点

interface Orchestrator {
  submitGoal(goal: Goal): Promise<string>              // 用户提交大目标
  decomposeGoal(goalId: string): Promise<Task[]>       // LLM 拆解为具体任务
  scheduleTask(task: Task): Promise<void>              // 调度到合适的 Agent/Pipeline
  checkpoint(taskId: string): Promise<CheckpointResult> // 人工检查点
}
```

---

## 7. 数据类型定义

### 7.1 SOUL 相关

```typescript
interface SoulDocument {
  identity: {                    // 用户是谁
    name: string
    role: string
    expertise: string[]
  }
  preferences: {                 // 协作偏好
    communicationStyle: string   // "简洁直接" | "详细解释" | ...
    decisionStyle: string       // "数据驱动" | "直觉导向" | ...
    riskTolerance: string       // "保守" | "激进" | ...
  }
  values: Record<string, string> // 价值观和判断倾向
  context: {                     // 当前关注点
    activeGoals: string[]
    domain: string
    constraints: string[]
  }
  meta: {
    version: number
    lastUpdated: string
    evolutionLog: EvolutionEntry[]  // 每次进化的记录
  }
}

interface EvolutionEvidence {
  source: 'conversation' | 'feedback' | 'behavior'  // 证据来源
  timestamp: string
  content: string              // 原始内容
  signal: string               // 提取的信号（如 "用户偏好先看数据再做判断"）
  confidence: number           // 0-1
}

interface EvolutionEntry {
  timestamp: string
  strategyUsed: string         // 使用了哪个 EvolutionStrategy
  changes: SoulDiff[]
  reasoning: string
}

interface SoulDiff {
  path: string                 // 如 "preferences.communicationStyle"
  before: string
  after: string
}
```

### 7.2 SOUL Pipeline I/O

```typescript
interface SoulPipelineInput {
  currentSoul: SoulDocument
  conversations: ConversationChunk[]   // 最近 N 轮对话
  strategy: string                      // 使用哪个 EvolutionStrategy
}

interface SoulPipelineOutput {
  updatedSoul: SoulDocument
  changes: SoulDiff[]                  // 具体改了什么
  reasoning: string                    // 为什么改
}

interface ConversationChunk {
  timestamp: string
  userMessage: string
  assistantResponse: string
  feedbackSignals?: string[]           // 用户的隐式/显式反馈
}
```

### 7.3 编排相关

```typescript
interface Goal {
  id: string
  description: string          // "调研 2026 年 AI Agent 市场机会"
  priority: 'low' | 'medium' | 'high'
  deadline?: string
  checkpointPolicy: 'every-task' | 'daily' | 'on-completion' | 'critical-only'
}

interface Task {
  id: string
  goalId: string
  type: 'research' | 'analysis' | 'plan' | 'soul-update' | 'report'
  agentId: string              // 分配给哪个 Agent/Pipeline
  prompt: string
  schedule?: string            // cron 表达式（定时任务）
  dependencies: string[]       // 依赖的前置任务 ID
  status: 'pending' | 'scheduled' | 'running' | 'checkpoint' | 'completed' | 'failed'
  artifacts: string[]          // 产出的文件路径
}

interface CheckpointResult {
  decision: 'approve' | 'reject' | 'modify'
  feedback?: string
  modifiedTask?: Partial<Task>
}
```

---

## 8. Evolution Engine 策略

不建议将 EvoAgentX 作为直接插件（Python 生态），建议提取其核心思想实现为可插拔的 `EvolutionStrategy`：

### 8.1 PromptEvolution（默认策略）

```typescript
// 最简单：用 LLM 直接分析对话 → 更新 SOUL
class PromptEvolution implements EvolutionStrategy {
  id = 'prompt'
  name = 'Prompt-based Evolution'

  async evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<SoulDocument> {
    // 1. 构建 prompt：当前 SOUL + 新证据
    // 2. 调用 LLM（Haiku 级别，低成本）
    // 3. 解析返回的 JSON 更新 SOUL
    // 成本低，效果够用于早期
  }
}
```

### 8.2 FeedbackEvolution（借鉴 EvoAgentX 的 TextGrad）

```typescript
// 闭环迭代：SOUL 指导行为 → 用户反馈 → 计算"梯度" → 调整 SOUL
class FeedbackEvolution implements EvolutionStrategy {
  id = 'feedback'
  name = 'Feedback Loop Evolution'

  async evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<SoulDocument> {
    // 1. 从 evidence 中提取正/负反馈信号
    // 2. 识别 SOUL 中哪些字段与反馈相关
    // 3. 沿反馈方向"微调"对应字段
    // 4. 验证更新后的一致性
    // 更精确，但需要更多数据积累
  }
}
```

### 8.3 ExternalEvolution（桥接外部系统）

```typescript
// 通过 HTTP/MCP 调用外部 Python 进程（如 EvoAgentX）
class ExternalEvolution implements EvolutionStrategy {
  id = 'external'
  name = 'External Bridge Evolution'

  constructor(private endpoint: string) {} // HTTP endpoint

  async evolve(current: SoulDocument, evidence: EvolutionEvidence[]): Promise<SoulDocument> {
    // POST { current, evidence } → endpoint → 返回更新后的 SOUL
    // 最强大但最重，需要 Python 环境
  }
}
```

---

## 9. 模块通信流示例

### 9.1 用户下达研究目标

```
用户: "调研 AI coding 工具市场，找到差异化机会"
    │
    ▼
┌─ Orchestrator ─────────────────────────────────────────┐
│                                                         │
│  GoalPlanner（用 LLM 拆解目标）                          │
│    ├─ Task 1: 收集 Top 20 AI coding 工具信息  → ResearchAgent
│    ├─ Task 2: 分析用户痛点和评价              → ResearchAgent
│    ├─ Task 3: 竞品功能矩阵对比                → AnalysisAgent
│    ├─ Task 4: 差异化机会分析                  → AnalysisAgent  (依赖 1,2,3)
│    ├─ Task 5: MVP 方案草案                   → CodeAgent       (依赖 4)
│    └─ Task 6: 更新 SOUL（学习用户判断偏好）    → SoulPipeline    (贯穿全程)
│                                                         │
│  TaskScheduler                                          │
│    ├─ Task 1,2 并行执行（无依赖）                         │
│    ├─ Task 3 等待 1,2 完成                               │
│    ├─ Task 4 → checkpoint: 人工审阅竞品分析再继续          │
│    └─ Task 5 → checkpoint: MVP 方案需要用户确认            │
│                                                         │
│  AgentRouter                                            │
│    ├─ research 类型 → ResearchAgent                      │
│    ├─ analysis 类型 → AnalysisAgent (或复用 ResearchAgent) │
│    ├─ plan/code 类型 → CodeAgent (Claude Code SDK)        │
│    └─ soul-update 类型 → SoulPipeline                     │
└─────────────────────────────────────────────────────────┘
```

### 9.2 SOUL 进化流

```
对话结束 / 定时触发
    │
    ▼
提取最近 N 轮对话 → ConversationChunk[]
    │
    ▼
信号提取（轻量 LLM 调用）
    ├─ "用户纠正了分析方向 → feedback signal"
    ├─ "用户跳过了详细解释 → preference signal"
    └─ "用户主动要求竞品数据 → behavior signal"
    │
    ▼
EvolutionEvidence[]
    │
    ▼
EvolutionStrategy.evolve(currentSoul, evidence)
    │
    ▼
SoulPipelineOutput { updatedSoul, changes, reasoning }
    │
    ├─ 写入 Identity Store (soul/SOUL.md)
    ├─ 提炼持久洞察 → insights/（如有）
    ├─ 记录 evolutionLog
    └─ 通知用户（如果变更显著）
```

### 9.3 日常自主运行

```
Cron 触发（基于现有 CronScheduler）
    │
    ├─ 每日 09:00: ResearchAgent 抓取 HackerNews/ProductHunt/竞品动态
    │   → 产物写入 workspace/{project}/research/2026-03-16-daily.md
    │
    ├─ 每周一 10:00: AnalysisAgent 汇总周报
    │   → 产物写入 workspace/{project}/research/2026-W12-weekly.md
    │   → Push 通知用户阅读
    │
    ├─ 每次对话结束: SoulPipeline 分析对话
    │   → 更新 soul/SOUL.md
    │
    └─ 触发式: 检测到重要事件（竞品发布、市场变化）
        → checkpoint: 推送给用户决定是否深入调研
```

---

## 10. 与现有 CodeClaws 代码的对接

| 新模块 | 对接现有系统 | 改动量 |
|--------|------------|--------|
| ResearchAgent | 实现 `EngineAdapter`，注册到引擎列表 | 新文件，不改现有代码 |
| SoulPipeline | 新接口 `Pipeline<I,O>`，独立于 EngineAdapter | 新文件 |
| Orchestrator | 基于现有 `CronScheduler` 扩展，复用 `QueryQueue` | 扩展现有模块 |
| Identity Store | 复用 `~/.codeclaws/` 目录结构，新增 `soul/`、`memory/`、`insights/` | 文件约定 |
| Workspace | 复用 `~/.codeclaws/` 目录结构，新增 `workspace/`（按项目隔离） | 文件约定 |
| EvolutionStrategy | 纯新增，不触及现有代码 | 新文件 |
| CheckpointGate | 复用现有 WebSocket `ask_user_question` 消息类型 | 最小改动 |

### 新增文件结构（预期）

```
packages/server/src/
├── engine/
│   ├── types.ts              ← 不改
│   ├── claude.ts             ← 不改（CodeAgent）
│   └── research.ts           ← 新增（ResearchAgent，实现 EngineAdapter）
├── pipeline/
│   ├── types.ts              ← 新增（Pipeline<I,O> 接口）
│   └── soul.ts               ← 新增（SoulPipeline 实现）
├── soul/
│   ├── types.ts              ← 新增（SoulDocument, EvolutionEvidence 等）
│   └── evolution/
│       ├── types.ts          ← 新增（EvolutionStrategy 接口）
│       ├── prompt.ts         ← 新增（PromptEvolution）
│       ├── feedback.ts       ← 新增（FeedbackEvolution）
│       └── external.ts       ← 新增（ExternalEvolution 桥接）
├── orchestrator/
│   ├── types.ts              ← 新增（Goal, Task, Orchestrator 接口）
│   ├── planner.ts            ← 新增（GoalPlanner）
│   ├── scheduler.ts          ← 新增（TaskScheduler，复用 CronScheduler）
│   ├── router.ts             ← 新增（AgentRouter）
│   └── checkpoint.ts         ← 新增（CheckpointGate）
├── identity/
│   └── store.ts              ← 新增（Identity Store: SOUL + Memory + Insights 管理）
└── workspace/
    └── store.ts              ← 新增（Workspace: 按项目隔离的调研产物/计划/交付物管理）
```

### 存储目录结构（预期）

```
~/.codeclaws/
├── config.json               ← 不改
├── models.json               ← 不改
├── projects.json             ← 不改
├── sessions/                 ← 不改
├── cron/                     ← 不改
│
│  ── Identity Store（跨项目，长期积累）──
├── soul/                     ← 新增
│   ├── SOUL.md               ← 用户画像（结构化 YAML frontmatter + Markdown）
│   └── evolution-log.jsonl   ← 进化历史记录
├── memory/                   ← 新增
│   └── conversations/        ← 对话记忆摘要
├── insights/                 ← 新增
│   ├── market-patterns.md    ← 从多次调研中提炼的持久洞察
│   └── domain-knowledge.md   ← 积累的领域知识
│
│  ── Workspace（按项目隔离，任务级产物）──
└── workspace/                ← 新增
    └── {project-id}/         ← 按项目隔离
        ├── research/         ← 调研产物（带时效标签）
        │   ├── 2026-03-16-daily.md
        │   ├── 2026-W12-weekly.md
        │   └── reports/
        ├── plans/            ← 方案与计划
        │   └── goals/
        └── artifacts/        ← 其他交付物
```

---

## 11. 开源项目参考

| 项目 | Stars | 借鉴点 |
|------|-------|--------|
| **MetaGPT** | 65k | 多角色协作模式、PRD 生成流程 |
| **GPT Researcher** | 26k | 深度研究 agent 的 planner-executor 架构 |
| **EvoAgentX** | 2.6k | 自进化策略（TextGrad, MIPRO）、HITL 管理器 |
| **LangGraph** | 25k | 图工作流、human-in-the-loop 的 interrupt() 模式 |
| **CrewAI** | 44k | 角色扮演多 agent 编排 |
| **Agno** | 39k | 四层记忆系统、TypeScript 友好 |
| **OpenClaw Heartbeat** | 302k | 定时巡检、事件中继、后台维护模式 |

---

## 12. 实施优先级建议

| 阶段 | 模块 | 理由 |
|------|------|------|
| Phase 1 | Pipeline 接口 + SoulPipeline + PromptEvolution | 最独立、最小、最快能看到效果 |
| Phase 2 | ResearchAgent (EngineAdapter 实现) | 让系统能自主采集信息 |
| Phase 3 | Orchestrator (Planner + Scheduler) | 让系统能自主编排任务 |
| Phase 4 | CheckpointGate + Communication | 人工介入与通知推送 |
| Phase 5 | FeedbackEvolution + 高级进化策略 | 闭环迭代优化 |

---

## 13. 设计决策记录

### 决策 1: SOUL 生成用直接 API 调用，不用 Agent SDK

**原因：** Agent SDK 的系统提示重度面向软件工程，工具集过重（Bash、文件编辑等），对 SOUL 分析这种纯文本处理任务来说成本高且会引入不必要的行为倾向。

### 决策 2: SOUL 消费通过注入 CLAUDE.md 或同等机制

**原因：** Agent SDK 原生支持 CLAUDE.md 上下文注入，零额外开发成本。SOUL 内容聚焦"协作偏好"而非"角色扮演"，不会干扰编码能力。

### 决策 3: EvoAgentX 理念内化，不直接依赖

**原因：** EvoAgentX 是 Python 框架，直接作为 TypeScript 插件不可行。提取其 TextGrad/反馈循环的核心思想，用 TypeScript 原生实现为 `EvolutionStrategy`。保留 `ExternalEvolution` 接口作为未来桥接的预留口。

### 决策 4: ResearchAgent 实现 EngineAdapter 而非新接口

**原因：** 复用现有的会话管理、流式输出、WebSocket 协议。ResearchAgent 本质上也是"给 prompt → 流式返回结果"，和 CodeAgent 的交互模式一致。

### 决策 5: 底层存储拆分为 Identity Store 和 Workspace

**原因：** 原 Knowledge Store 混合了两种本质不同的数据——"Agent 对用户的认知"（SOUL、Memory、Insights）和"Agent 的工作产物"（Research、Plans、Artifacts）。前者是长期跨项目积累、越用越准的核心资产，后者是任务级的交付物、有时效性、按项目隔离。拆分后：
- **Identity Store** 是个人助手的"人格记忆"，EvolutionStrategy 只作用于此层
- **Workspace** 按项目隔离，支持独立归档/清理，不污染认知层
- **Insights** 作为桥梁：调研产物是临时的，但从中提炼的洞察可沉淀到 Identity Store，让 Agent 越来越"懂行"
