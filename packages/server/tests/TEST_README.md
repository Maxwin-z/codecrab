# CodeCrab 测试用例

本目录包含针对 CodeCrab 服务器的各种测试用例。

## 测试项目

测试使用以下项目路径：
- **Project A**: `/Users/maxwin/workspace/test-projects/project-a`
- **Project B**: `/Users/maxwin/workspace/test-projects/project-b`

## 运行测试

### 运行单个测试

```bash
node test-api-projects.mjs
node test-websocket-basic.mjs
node test-multi-project-chat.mjs
```

### 运行所有测试

```bash
node test-runner.mjs
```

### 按名称过滤测试

```bash
# 只运行 API 测试
node test-runner.mjs api

# 只运行 WebSocket 测试
node test-runner.mjs websocket

# 只运行并行测试
node test-runner.mjs parallel
```

## 测试文件说明

### API 测试

| 文件 | 描述 |
|------|------|
| `test-api-projects.mjs` | 项目 CRUD 操作：创建、获取、删除项目 |
| `test-api-sessions.mjs` | 会话管理：列出、过滤、删除会话 |
| `test-auth-api.mjs` | 认证授权：token 验证、受保护端点 |
| `test-models-api.mjs` | 模型 API：列出模型、获取当前模型 |

### WebSocket 测试

| 文件 | 描述 |
|------|------|
| `test-websocket-basic.mjs` | 基本 WebSocket 功能：连接、提示、流式传输、中止 |
| `test-multi-project-chat.mjs` | 多项目聊天：并行查询、项目隔离、快速查询 |
| `test-session-resume.mjs` | 会话恢复：断开重连、消息历史 |
| `test-parallel.mjs` | 并行项目：两个项目同时查询（已存在） |
| `test-parallel-resume.mjs` | 预热后并行查询（已存在） |
| `test-two-tabs.mjs` | 两个浏览器标签（已存在） |

### 集成测试

| 文件 | 描述 |
|------|------|
| `test-integration-full.mjs` | 完整工作流：创建项目、聊天、切换项目、会话管理、清理 |

## 环境要求

1. 服务器必须在 `localhost:4200` 上运行
2. Token 必须有效（已在测试文件中配置）
3. 需要安装 `ws` 包：`pnpm add ws`

## 测试输出示例

```
$ node test-runner.mjs

╔════════════════════════════════════════════════════════════╗
║              CodeCrab Test Runner                         ║
╚════════════════════════════════════════════════════════════╝

Running 10 test(s)...

Project API          CRUD operations for projects       ✓ PASS  2.1s
Session API          Session listing and deletion       ✓ PASS  35.2s
Auth API             Authentication and authorization   ✓ PASS  1.5s
Models API           Model listing and configuration    ✓ PASS  3.8s
WebSocket Basic      Connection, prompts, streaming     ✓ PASS  42.1s
Multi-Project Chat   Parallel and sequential queries    ✓ PASS  125.4s
Session Resume       Session persistence and resume     ✓ PASS  38.9s
Parallel Projects    Two projects simultaneous queries  ✓ PASS  28.7s
Two Browser Tabs     Separate WS connections per tab    ✓ PASS  45.3s
Full Integration     Complete workflow test             ✓ PASS  78.6s

════════════════════════════════════════════════════════════
Results: 10 passed, 0 failed, 10 total
════════════════════════════════════════════════════════════
```

## 添加新测试

1. 创建新的 `.mjs` 文件
2. 使用 `test(name, fn)` 辅助函数定义测试
3. 在 `test-runner.mjs` 的 `TESTS` 数组中添加测试信息
4. 确保测试最后调用 `process.exit(passed === total ? 0 : 1)`

## 注意事项

- WebSocket 测试可能需要较长时间（30-120秒）
- 某些测试依赖于 AI 响应，可能会有轻微的不稳定性
- 测试会创建临时项目和会话，但不会删除现有数据
- 并行测试可能会因为 API 限制而超时
