# Claude Agent SDK 实现指南：对齐 Claude Code CLI 能力

本文档详细说明如何使用 Claude Agent SDK（`@anthropic-ai/claude-code`）实现与 Claude Code CLI 等价的能力，覆盖所有核心功能模块。

---

## 目录

1. [基础用法](#1-基础用法)
2. [权限控制](#2-权限控制)
3. [MCP 服务器集成](#3-mcp-服务器集成)
4. [Hooks 系统](#4-hooks-系统)
5. [Skills 技能系统](#5-skills-技能系统)
6. [Slash Commands 自定义命令](#6-slash-commands-自定义命令)
7. [Settings 配置加载](#7-settings-配置加载)
8. [Subagents 子代理](#8-subagents-子代理)
9. [Session 会话管理](#9-session-会话管理)
10. [流式输出与消息处理](#10-流式输出与消息处理)
11. [结构化输出](#11-结构化输出)
12. [高级功能](#12-高级功能)
13. [CLI 与 SDK 能力对照表](#13-cli-与-sdk-能力对照表)
14. [完整示例：构建一个对齐 CLI 的 Agent 服务](#14-完整示例构建一个对齐-cli-的-agent-服务)

---

## 1. 基础用法

### 安装

```bash
# TypeScript
npm install @anthropic-ai/claude-code

# Python
pip install claude-code-sdk
```

### 最小示例

**TypeScript:**

```typescript
import { query } from "@anthropic-ai/claude-code";

for await (const message of query({
  prompt: "读取 src/main.ts 并分析其结构",
  options: {
    cwd: "/path/to/project",
    allowedTools: ["Read", "Glob", "Grep"],
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if ("text" in block) process.stdout.write(block.text);
    }
  }
}
```

**Python:**

```python
import asyncio
from claude_code_sdk import query, ClaudeCodeOptions

async def main():
    async for message in query(
        prompt="读取 src/main.ts 并分析其结构",
        options=ClaudeCodeOptions(
            cwd="/path/to/project",
            allowed_tools=["Read", "Glob", "Grep"],
        ),
    ):
        if message.type == "assistant":
            for block in message.message.content:
                if hasattr(block, "text"):
                    print(block.text, end="")

asyncio.run(main())
```

### 内置工具列表

SDK 内置了与 CLI 完全相同的工具集：

| 工具 | 用途 | 只读 |
|------|------|------|
| `Read` | 读取文件 | 是 |
| `Write` | 创建/覆写文件 | 否 |
| `Edit` | 精确编辑文件（字符串替换） | 否 |
| `Bash` | 执行终端命令 | 否 |
| `Glob` | 按模式匹配搜索文件 | 是 |
| `Grep` | 按正则搜索文件内容 | 是 |
| `WebSearch` | 搜索互联网 | 是 |
| `WebFetch` | 获取网页内容 | 是 |
| `AskUserQuestion` | 向用户提问 | 否 |
| `Agent` | 启动子代理 | 否 |
| `Skill` | 调用技能 | 否 |

---

## 2. 权限控制

CLI 通过 `--permission-mode` 控制权限，SDK 完全对齐：

### 权限模式

```typescript
options: {
  // 模式一：默认模式 - 未在 allowedTools 中的工具需要审批
  permissionMode: "default",

  // 模式二：仅允许模式 - 不在 allowedTools 中的直接拒绝（不会提示）
  permissionMode: "dontAsk",

  // 模式三：接受编辑 - 自动批准文件操作
  permissionMode: "acceptEdits",

  // 模式四：绕过所有权限 - 全部自动批准（谨慎使用）
  permissionMode: "bypassPermissions",

  // 模式五：计划模式 - 只读，不执行任何修改
  permissionMode: "plan",
}
```

### 预批准特定工具

```typescript
options: {
  permissionMode: "default",
  allowedTools: [
    "Read", "Glob", "Grep",           // 只读工具
    "Edit", "Write",                    // 文件编辑
    "Bash(npm test:*)",                 // 仅允许匹配模式的 Bash 命令
    "mcp__github__*",                   // 某个 MCP 服务的所有工具
  ],
}
```

### 禁用特定工具

```typescript
options: {
  // disallowedTools 优先级最高，即使 bypassPermissions 也会被禁用
  disallowedTools: ["Bash", "Write"],
}
```

### 自定义权限回调

实现类似 happy/vibe-kanban 的远程审批：

```typescript
options: {
  permissionMode: "default",
  canUseTool: async (toolInput) => {
    const { tool_name, tool_input } = toolInput;

    // 只读工具自动放行
    if (["Read", "Glob", "Grep"].includes(tool_name)) {
      return true;
    }

    // 危险操作转发到 Web UI / 手机端审批
    const approved = await forwardToRemoteApproval({
      tool: tool_name,
      input: tool_input,
    });

    return approved;
  },
}
```

---

## 3. MCP 服务器集成

### 3.1 stdio 方式（本地进程）

等价于 CLI 的 `.mcp.json` 配置或 `--mcp` 参数：

```typescript
options: {
  mcpServers: {
    // 启动本地 MCP 进程
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
    },
    filesystem: {
      command: "node",
      args: ["./mcp-servers/filesystem.js"],
      env: { ROOT_DIR: "/data" },       // 传递环境变量
    },
  },
  allowedTools: [
    "mcp__playwright__*",                // 允许该 MCP 的所有工具
    "mcp__filesystem__read_file",        // 允许特定工具
  ],
}
```

### 3.2 HTTP/SSE 方式（远程服务）

```typescript
options: {
  mcpServers: {
    "remote-db": {
      type: "sse",
      url: "https://my-mcp-server.example.com/sse",
      headers: {
        Authorization: "Bearer <token>",
      },
    },
  },
}
```

### 3.3 进程内 MCP 服务器（SDK 独有）

无需启动外部进程，直接在代码中定义工具：

**TypeScript:**

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
import { z } from "zod";

const dbServer = createSdkMcpServer({
  name: "database",
  tools: [
    tool(
      "query_db",
      "执行 SQL 查询",
      { sql: z.string(), database: z.string().default("main") },
      async (args) => {
        const result = await db.execute(args.sql);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }
    ),
    tool(
      "list_tables",
      "列出所有数据表",
      {},
      async () => {
        const tables = await db.listTables();
        return {
          content: [{ type: "text", text: tables.join("\n") }],
        };
      }
    ),
  ],
});

for await (const message of query({
  prompt: "查看数据库中有哪些表，然后查询用户表的前10条记录",
  options: {
    mcpServers: { database: dbServer },
    allowedTools: ["mcp__database__*"],
  },
})) {
  // ...
}
```

**Python:**

```python
from claude_code_sdk import query, ClaudeCodeOptions, tool, create_sdk_mcp_server

@tool("query_db", "执行 SQL 查询", {"sql": str, "database": str})
async def query_db(args):
    result = await db.execute(args["sql"])
    return {"content": [{"type": "text", "text": json.dumps(result)}]}

db_server = create_sdk_mcp_server(
    name="database",
    tools=[query_db],
)

async for message in query(
    prompt="查看数据库中有哪些表",
    options=ClaudeCodeOptions(mcp_servers={"database": db_server}),
):
    pass
```

### 3.4 自动加载 .mcp.json

SDK 会自动加载项目根目录的 `.mcp.json`，格式与 CLI 完全一致：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## 4. Hooks 系统

### 4.1 支持的 Hook 类型

| Hook | 触发时机 | 典型用途 |
|------|----------|----------|
| `PreToolUse` | 工具执行前 | 拦截/修改/审批工具调用 |
| `PostToolUse` | 工具执行后 | 审计日志、结果转换 |
| `PostToolUseFailure` | 工具执行失败后 | 错误处理 |
| `Stop` | Agent 停止时 | 清理、提交提醒 |
| `UserPromptSubmit` | 用户提交 prompt 时 | 注入上下文 |
| `SubagentStart` | 子代理启动时 | 监控 |
| `SubagentStop` | 子代理结束时 | 监控 |
| `PreCompact` | 对话压缩前 | 保留关键上下文 |
| `Notification` | 通知事件 | 转发通知 |

### 4.2 PreToolUse：拦截与审批

```typescript
import { query, HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-code";

// 保护敏感文件
const protectSensitiveFiles: HookCallback = async (input, toolUseId, { signal }) => {
  const hookInput = input as PreToolUseHookInput;
  const filePath = (hookInput.tool_input as Record<string, unknown>)?.file_path as string;

  // 禁止修改 .env 文件
  if (filePath?.match(/\.env/)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "禁止修改环境变量文件",
      },
    };
  }

  // 其他情况自动放行
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
};

// 审计 Bash 命令
const auditBashCommands: HookCallback = async (input, toolUseId) => {
  const hookInput = input as PreToolUseHookInput;
  console.log(`[AUDIT] Bash: ${(hookInput.tool_input as any)?.command}`);
  return {};  // 空返回 = 不干预
};

for await (const message of query({
  prompt: "重构项目配置",
  options: {
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [protectSensitiveFiles] },
        { matcher: "Bash", hooks: [auditBashCommands] },
      ],
    },
  },
})) {
  // ...
}
```

### 4.3 PostToolUse：审计日志

```typescript
const logToolUsage: HookCallback = async (input, toolUseId) => {
  const hookInput = input as PostToolUseHookInput;
  await appendToAuditLog({
    tool: hookInput.tool_name,
    input: hookInput.tool_input,
    output: hookInput.tool_result,
    timestamp: new Date().toISOString(),
  });
  return {};
};

options: {
  hooks: {
    PostToolUse: [
      { matcher: ".*", hooks: [logToolUsage] },  // 记录所有工具调用
    ],
  },
}
```

### 4.4 Stop Hook：提交提醒

模仿 vibe-kanban 的 commit 提醒：

```typescript
const commitReminder: HookCallback = async (input, toolUseId) => {
  const { stdout } = await exec("git status --porcelain");
  if (stdout.trim()) {
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "block",
        reason: "检测到未提交的变更，请先 commit",
      },
    };
  }
  return {};
};

options: {
  hooks: {
    Stop: [{ matcher: ".*", hooks: [commitReminder] }],
  },
}
```

### 4.5 UserPromptSubmit：注入上下文

```typescript
const injectContext: HookCallback = async (input, toolUseId) => {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      systemMessage: `当前时间: ${new Date().toISOString()}\n当前分支: ${await getCurrentBranch()}`,
    },
  };
};

options: {
  hooks: {
    UserPromptSubmit: [{ matcher: ".*", hooks: [injectContext] }],
  },
}
```

---

## 5. Skills 技能系统

### 5.1 加载项目级 Skills

CLI 自动加载 `.claude/skills/` 中的技能，SDK 需要显式声明 `settingSources`：

```typescript
options: {
  settingSources: ["project"],          // 加载 .claude/skills/
  allowedTools: ["Skill", "Read", "Write", "Bash", "Glob", "Grep"],
}
```

### 5.2 技能目录结构

与 CLI 完全一致：

```
.claude/
  skills/
    code-review/
      SKILL.md          # 技能描述和指令
      templates/         # 技能模板文件（可选）
    deploy/
      SKILL.md
```

`SKILL.md` 格式：

```markdown
---
name: code-review
description: 执行代码审查，检查质量和安全问题
allowed-tools: Read, Grep, Glob
---

你是一个代码审查专家。请审查用户指定的代码，重点关注：
1. 代码质量
2. 安全漏洞
3. 性能问题
```

> **注意**：`SKILL.md` 中的 `allowed-tools` 在 SDK 中不会自动生效，需要在主 `allowedTools` 中声明。

### 5.3 同时加载用户级和项目级 Skills

```typescript
options: {
  settingSources: ["project", "user"],  // 加载 .claude/skills/ 和 ~/.claude/skills/
}
```

---

## 6. Slash Commands 自定义命令

### 6.1 定义自定义命令

与 CLI 完全一致，放在 `.claude/commands/` 目录下：

```
.claude/
  commands/
    test.md             # /test 命令
    deploy.md           # /deploy 命令
    review.md           # /review 命令
```

`test.md` 内容示例：

```markdown
运行项目的测试套件，分析失败的测试并修复问题。

步骤：
1. 运行 `npm test`
2. 如果有失败，分析错误原因
3. 修复代码
4. 重新运行验证
```

### 6.2 在 SDK 中调用命令

```typescript
// 像 CLI 一样通过 prompt 调用
for await (const message of query({
  prompt: "/test",
  options: {
    settingSources: ["project"],        // 必须，否则不会加载 commands/
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"],
  },
})) {
  // ...
}

// 带参数的命令
for await (const message of query({
  prompt: "/review src/auth/login.ts",
  options: { settingSources: ["project"] },
})) {
  // ...
}
```

### 6.3 发现可用命令

系统初始化消息中会包含可用命令列表：

```typescript
for await (const message of query({ prompt: "hello", options })) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(message.availableCommands);
    // [{ name: "test", description: "..." }, { name: "deploy", description: "..." }]
  }
}
```

---

## 7. Settings 配置加载

### 7.1 CLAUDE.md 项目指令

CLI 自动加载 `CLAUDE.md`，SDK 需要 `settingSources`：

```typescript
options: {
  settingSources: ["project"],
  // 等价于 CLI 自动读取以下文件：
  //   ./CLAUDE.md
  //   ./.claude/CLAUDE.md
  //   ./.claude/settings.json
}
```

### 7.2 系统提示词

```typescript
options: {
  // 方式一：使用 Claude Code 的完整系统提示 + 追加自定义指令
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "始终使用中文回复。所有代码注释使用英文。",
  },

  // 方式二：完全自定义系统提示
  systemPrompt: "你是一个专注于 Python 开发的 AI 助手...",
}
```

### 7.3 模型选择

```typescript
options: {
  model: "claude-opus-4-6",             // 默认
  // model: "claude-sonnet-4-6",         // 更快
  // model: "claude-haiku-4-5-20251001", // 最快最便宜
}
```

---

## 8. Subagents 子代理

### 8.1 程序化定义子代理

```typescript
options: {
  allowedTools: ["Read", "Glob", "Grep", "Agent"],  // 必须包含 Agent

  agents: {
    "security-reviewer": {
      description: "安全审查专家，检查代码中的安全漏洞",
      prompt: "你是一个安全审查专家。扫描代码中的 OWASP Top 10 漏洞...",
      tools: ["Read", "Grep", "Glob"],  // 限制为只读
      model: "claude-sonnet-4-6",       // 可以用更快的模型
    },
    "test-writer": {
      description: "测试编写专家，生成单元测试和集成测试",
      prompt: "你是一个测试工程师...",
      tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    },
  },
}
```

### 8.2 文件系统定义子代理

与 CLI 一致，放在 `.claude/agents/` 目录：

```
.claude/
  agents/
    security-reviewer.md
    test-writer.md
```

`security-reviewer.md`：

```markdown
---
name: security-reviewer
description: 安全审查专家
tools: Read, Grep, Glob
model: claude-sonnet-4-6
---

你是一个安全审查专家。扫描代码中的 OWASP Top 10 漏洞...
```

需要配合 `settingSources: ["project"]` 加载。

### 8.3 子代理生命周期 Hook

```typescript
options: {
  hooks: {
    SubagentStart: [{
      matcher: ".*",
      hooks: [async (input) => {
        console.log(`子代理启动: ${input.agent_name}`);
        return {};
      }],
    }],
    SubagentStop: [{
      matcher: ".*",
      hooks: [async (input) => {
        console.log(`子代理完成: ${input.agent_name}`);
        return {};
      }],
    }],
  },
}
```

---

## 9. Session 会话管理

### 9.1 创建新会话

每次调用 `query()` 默认创建新会话：

```typescript
let sessionId: string;

for await (const message of query({
  prompt: "分析项目结构",
  options: { allowedTools: ["Read", "Glob"] },
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
    console.log(`会话 ID: ${sessionId}`);
  }
}
```

### 9.2 恢复会话

```typescript
// 在同一个会话上下文中继续对话
for await (const message of query({
  prompt: "现在修复你发现的问题",
  options: {
    resume: sessionId,                  // 恢复之前的会话
    allowedTools: ["Read", "Edit", "Bash"],
  },
})) {
  // ...
}
```

### 9.3 从特定消息点分支

```typescript
for await (const message of query({
  prompt: "用不同的方案重新实现",
  options: {
    resume: sessionId,
    resumeSessionAt: messageUUID,       // 从某条消息开始分支
    forkSession: true,                  // 创建分支而非修改原会话
  },
})) {
  // ...
}
```

### 9.4 列出历史会话

```typescript
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-code";

// 列出最近的会话
const sessions = await listSessions({
  dir: "/path/to/project",
  limit: 10,
});

for (const session of sessions) {
  console.log(`${session.summary} (${session.sessionId})`);
}

// 读取某个会话的完整消息
const messages = await getSessionMessages(sessions[0].sessionId, {
  dir: "/path/to/project",
});
```

### 9.5 不保存会话

```typescript
options: {
  persistSession: false,                // 不写入 ~/.claude/projects/
}
```

---

## 10. 流式输出与消息处理

### 10.1 消息类型

SDK 输出的消息类型与 CLI 的 `--output-format stream-json` 完全一致：

```typescript
for await (const message of query({ prompt, options })) {
  switch (message.type) {
    case "system":
      // 系统消息：初始化信息、会话 ID、可用命令
      if (message.subtype === "init") {
        console.log("Session:", message.session_id);
        console.log("Model:", message.model);
      }
      break;

    case "assistant":
      // 助手消息：文本、工具调用、思考过程
      for (const block of message.message.content) {
        if ("text" in block) {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          console.log(`调用工具: ${block.name}`, block.input);
        } else if (block.type === "thinking") {
          console.log(`[思考] ${block.thinking}`);
        }
      }
      break;

    case "user":
      // 工具执行结果
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          console.log(`工具结果 [${block.tool_use_id}]:`, block.content);
        }
      }
      break;

    case "result":
      // 最终结果
      console.log("完成:", message.subtype);  // "success" | "error" | "interrupted"
      console.log("耗时:", message.duration_ms, "ms");
      console.log("费用: $", message.cost_usd);
      break;
  }
}
```

### 10.2 中间消息（部分更新）

获取工具执行过程中的实时更新：

```typescript
options: {
  includePartialMessages: true,         // 开启中间消息
}
```

### 10.3 中断执行

```typescript
const controller = new AbortController();

// 5 秒后中断
setTimeout(() => controller.abort(), 5000);

for await (const message of query({
  prompt: "进行全面代码审查",
  options: { signal: controller.signal },
})) {
  // ...
}
```

### 10.4 流式输入

用于需要在会话过程中动态发送消息的场景（如持续对话）：

```typescript
import { PushableAsyncIterable } from "@anthropic-ai/claude-code";

const inputStream = new PushableAsyncIterable<SDKUserMessage>();

// 在另一个异步流程中推送消息
setTimeout(() => {
  inputStream.push({ type: "user", message: { role: "user", content: "继续分析" } });
}, 10000);

setTimeout(() => {
  inputStream.done();  // 结束输入
}, 20000);

for await (const message of query({
  prompt: inputStream,
  options: { allowedTools: ["Read", "Glob"] },
})) {
  // ...
}
```

---

## 11. 结构化输出

CLI 不直接支持，SDK 独有的能力：

```typescript
for await (const message of query({
  prompt: "分析这个项目的技术栈",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          language: { type: "string", description: "主要编程语言" },
          framework: { type: "string", description: "使用的框架" },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "关键依赖",
          },
          architecture: { type: "string", description: "架构模式" },
        },
        required: ["language", "framework", "dependencies"],
      },
    },
  },
})) {
  if (message.type === "result") {
    const analysis = JSON.parse(message.result);
    // { language: "TypeScript", framework: "Next.js", ... }
  }
}
```

---

## 12. 高级功能

### 12.1 成本与 Token 控制

```typescript
options: {
  maxTurns: 20,                         // 最大对话轮次
  maxBudgetUsd: 5.0,                    // 最大费用限制（美元）
  effort: "high",                       // 思考深度: "low" | "medium" | "high" | "max"
}
```

### 12.2 文件检查点（可撤销文件变更）

```typescript
options: {
  enableFileCheckpointing: true,        // 开启文件检查点
}
// Agent 执行过程中修改的文件可以自动恢复到之前的状态
```

### 12.3 自定义进程启动（容器化 / 远程执行）

在 Docker 或远程 VM 中运行 Claude Code：

```typescript
options: {
  spawnClaudeCodeProcess: async (command, args, opts) => {
    // 在 Docker 容器中启动
    return spawn("docker", [
      "exec", "-i", "my-sandbox",
      command, ...args,
    ], opts);
  },
}
```

### 12.4 调试模式

```typescript
options: {
  debug: true,                          // 输出详细调试日志
}
```

---

## 13. CLI 与 SDK 能力对照表

| CLI 功能 | CLI 用法 | SDK 用法 | 对齐度 |
|----------|----------|----------|--------|
| 基础对话 | `claude -p "prompt"` | `query({ prompt })` | 100% |
| 工作目录 | `--cwd /path` | `cwd: "/path"` | 100% |
| 模型选择 | `-m opus` | `model: "claude-opus-4-6"` | 100% |
| 权限模式 | `--permission-mode plan` | `permissionMode: "plan"` | 100% |
| 预批准工具 | `--allow-tools Read Bash` | `allowedTools: ["Read", "Bash"]` | 100% |
| 禁用工具 | `--disallow-tools Bash` | `disallowedTools: ["Bash"]` | 100% |
| MCP 服务器 | `.mcp.json` / `--mcp` | `mcpServers: {...}` | 100% |
| Hooks | `.claude/settings.json` hooks | `hooks: {...}` | 95% |
| Skills | `.claude/skills/` 自动加载 | `settingSources: ["project"]` | 95% |
| Commands | `/command` 交互输入 | `prompt: "/command"` | 95% |
| CLAUDE.md | 自动加载 | `settingSources: ["project"]` | 90% |
| 会话恢复 | `--resume <id>` | `resume: sessionId` | 100% |
| 会话分支 | `--resume-session-at <uuid>` | `resumeSessionAt: uuid` | 100% |
| 流式输出 | `--output-format stream-json` | 内置 `async for` | 100% |
| JSON 输出 | `--output-format json` | `outputFormat: { type: "json_schema" }` | SDK 更强 |
| 子代理 | Agent 工具 | `agents: {...}` + Agent 工具 | 100% |
| 最大轮次 | `--max-turns 20` | `maxTurns: 20` | 100% |
| 费用限制 | `--max-budget 5` | `maxBudgetUsd: 5.0` | 100% |
| 思考深度 | `-e high` | `effort: "high"` | 100% |
| 调试 | `--debug` | `debug: true` | 100% |
| 不保存会话 | `--no-session` | `persistSession: false` | 100% |
| 交互式 TUI | 默认终端界面 | ❌ 不支持 | N/A |
| IDE 集成 | VS Code / JetBrains 插件 | ❌ 不支持 | N/A |

---

## 14. 完整示例：构建一个对齐 CLI 的 Agent 服务

以下是一个 Express 服务，通过 HTTP API 暴露 Claude Code 的全部能力：

```typescript
import express from "express";
import {
  query,
  listSessions,
  getSessionMessages,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-code";
import { z } from "zod";

const app = express();
app.use(express.json());

// ---------- 自定义 MCP 工具 ----------

const projectTools = createSdkMcpServer({
  name: "project",
  tools: [
    tool(
      "get_deploy_status",
      "查询部署状态",
      { env: z.enum(["staging", "production"]) },
      async (args) => {
        const status = await fetchDeployStatus(args.env);
        return { content: [{ type: "text", text: JSON.stringify(status) }] };
      }
    ),
  ],
});

// ---------- 公共配置 ----------

function buildOptions(body: any) {
  return {
    cwd: body.cwd || process.cwd(),
    model: body.model || "claude-opus-4-6",
    permissionMode: body.permissionMode || "acceptEdits",
    settingSources: ["project"] as const,
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent", "Skill",
      "mcp__project__*",
      ...(body.allowedTools || []),
    ],
    disallowedTools: body.disallowedTools || [],
    maxTurns: body.maxTurns || 50,
    maxBudgetUsd: body.maxBudgetUsd || 10.0,
    effort: body.effort || "high",
    mcpServers: { project: projectTools },

    // Hooks
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [async (input: any) => {
            const filePath = input.tool_input?.file_path || "";
            if (filePath.match(/\.(env|pem|key)$/)) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: "禁止修改敏感文件",
                },
              };
            }
            return {};
          }],
        },
      ],
    },

    // Agents
    agents: {
      "code-reviewer": {
        description: "代码审查专家",
        prompt: "你是一个代码审查专家，检查代码质量和安全问题。",
        tools: ["Read", "Grep", "Glob"],
      },
    },

    // 会话恢复
    ...(body.sessionId ? { resume: body.sessionId } : {}),
  };
}

// ---------- API 路由 ----------

// 执行 prompt（流式 SSE）
app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  try {
    for await (const message of query({
      prompt: req.body.prompt,
      options: buildOptions(req.body),
    })) {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: "error", error: String(error) })}\n\n`);
  }

  res.end();
});

// 列出历史会话
app.get("/api/sessions", async (req, res) => {
  const sessions = await listSessions({
    dir: (req.query.cwd as string) || process.cwd(),
    limit: Number(req.query.limit) || 20,
  });
  res.json(sessions);
});

// 获取会话消息
app.get("/api/sessions/:id/messages", async (req, res) => {
  const messages = await getSessionMessages(req.params.id, {
    dir: (req.query.cwd as string) || process.cwd(),
  });
  res.json(messages);
});

app.listen(3000, () => console.log("Agent 服务已启动: http://localhost:3000"));
```

使用方式：

```bash
# 新会话
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析项目结构并生成架构图", "cwd": "/my/project"}'

# 恢复会话继续对话
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "修复你发现的问题", "sessionId": "abc-123"}'

# 使用自定义命令
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "/review src/auth/", "cwd": "/my/project"}'

# 列出会话
curl http://localhost:3000/api/sessions?cwd=/my/project
```

---

## 附录：SDK 与手动 spawn CLI 的对比

如果你之前像 happy/vibe-kanban 那样手动 spawn Claude Code CLI，以下是迁移对照：

| 手动 spawn | SDK 等价 |
|-----------|----------|
| `spawn("claude", ["--output-format", "stream-json", ...])` | `query({ prompt, options })` |
| 逐行读取 stdout 解析 JSON | `for await (const msg of query(...))` |
| 手动发送 `control_response` 到 stdin | `canUseTool` 回调 / `hooks.PreToolUse` |
| 手动管理 `--resume <session-id>` | `resume: sessionId` |
| 手动解析 `system:init` 获取 session ID | `message.session_id` |
| 手动注册 hooks 通过 `Initialize` 消息 | `hooks: { PreToolUse: [...] }` |
| 手动处理进程生命周期 | SDK 自动管理 |
| 手动处理错误和重试 | SDK 内置 |

**迁移建议**：SDK 封装了所有底层协议细节，代码量通常可以减少 70-80%，且不需要跟踪 Claude Code CLI 的协议变更。
