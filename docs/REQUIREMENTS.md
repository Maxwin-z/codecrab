# CodeCrab — 产品需求文档 (PRD)

> 版本：1.0 | 日期：2026-03-10

---

## 一、产品概述

CodeCrab 是一个将 AI 编程引擎封装为一体化服务的产品。当前基于 Claude Code SDK 构建，未来可扩展支持 OpenCore 等其他底层驱动引擎。用户通过 NPM 安装后即可在本地或远程使用全部能力，包括代码编辑、浏览器自动化、定时任务、消息推送等。

产品由三大模块组成：

| 模块 | 说明 |
|------|------|
| **前端站点** | 产品介绍、安装指引、API 文档、配置向导 |
| **消息转发服务** | 部署于公网，为局域网用户提供外网访问转发能力 |
| **插件市场** | 可扩展的插件生态，包括浏览器能力、MCP 扩展等 |

---

## 二、配置阶段

### 第一阶段：基础安装与网络配置

#### 2.1 安装

项目以 NPM 包形式发布，用户直接安装：

```bash
npm install -g codecrab
```

安装完成后，通过命令启动配置：

```bash
codecrab setup
```

#### 2.2 启动本地服务

系统启动本地 Express + WebSocket 服务，同时生成一个访问 Token：

- Token 采用密码学安全的随机生成机制（`crypto.randomBytes`）
- 支持用户输入自定义字符串作为盐值（salt）进行混合生成
- Token 持久化存储在本地配置目录（`~/.codecrab/config.json`）

#### 2.3 选择访问方式

| 方式 | 说明 |
|------|------|
| **(a) 仅局域网访问** | 系统显示局域网地址 + Token，用户在内网直接访问 |
| **(b) 公网转发访问** | 本地服务通过 Token 校验与公网转发服务建立 WebSocket 隧道，系统分配并告知用户公网访问地址 |

#### 2.4 建立连接

- 局域网模式：直接通过局域网 IP + 端口 + Token 访问
- 公网模式：本地服务作为客户端，通过 Token 认证与公网转发服务器建立持久 WebSocket 连接，转发所有请求/响应

#### 2.5 安全机制

- Token 生成：`crypto.randomBytes(32).toString('hex')` + 可选用户盐值
- 所有 WebSocket 连接需携带 Token 进行认证
- 支持 Token 轮换与失效机制
- 公网转发通道端到端加密

### 第二阶段：环境与 API 配置

#### 2.6 账号登录

- 自动扫描用户本地已有的 Claude Code 登录信息和环境配置
- 用户可直接选择已有账号或手动配置新账号

#### 2.7 API 集成

支持多种 API 提供商接入：

| 提供商 | 配置项 |
|--------|--------|
| Anthropic (Claude) | API Key |
| Kimi (月之暗面) | API Key + Base URL |
| 智谱 (GLM) | API Key + Base URL |
| 其他兼容提供商 | API Key + Base URL |

用户只需在配置页面填入对应的 API Key 即可完成基础设置。

---

## 三、核心架构

### 3.1 已实现的能力

#### 核心引擎

通过引擎适配层（`server/engine/`）接入 AI 编程引擎。定义统一的 `EngineAdapter` 接口，当前实现 Claude Code SDK 适配器，未来可扩展 opencode 等引擎，上层业务代码无需修改：

- **模型配置**：支持多模型管理，用户可配置不同 API 提供商的模型（Anthropic、Kimi、智谱等），每个模型独立配置 API Key、Base URL 和配置目录
  - 用户可设置**全局默认模型**，所有新对话自动使用该模型
  - 用户可为**单个项目指定专属模型**，覆盖全局默认
  - 模型配置持久化存储在后端服务中
- **会话管理**：基于项目的持久化会话，支持恢复和切换
- **权限控制**：`bypassPermissions` 模式和 `default`（用户确认）模式
- **流式输出**：实时 token 流传输，包含思考过程和文本内容
- **成本追踪**：每次查询记录 token 用量和费用

#### 通讯层

通过 WebSocket 实现前后端全双工通讯：

- **协议定义**：类型安全的消息协议（`WsMessage` 类型联合）
- **消息类型**：`prompt`、`stream_delta`、`assistant_text`、`thinking`、`tool_use`、`tool_result`、`result` 等
- **会话控制**：`set_cwd`、`abort`、`/clear`、`resume_session`
- **多客户端支持**：同一项目支持多标签页/设备同时连接，消息广播

#### 服务端能力

| 能力 | 实现 | 说明 |
|------|------|------|
| **Express HTTP 服务** | `server/index.ts` | 端口 4200，提供 REST API 和 WebSocket 升级 |
| **引擎适配层** | `server/engine/` | 可插拔的 AI 引擎抽象层，当前适配 Claude Code SDK，未来可扩展 opencode 等引擎 |
| **MCP 扩展层** | `server/mcp/` | 统一 MCP 目录，包含定时任务、消息推送、浏览器管理等子模块 |
| **文件系统** | `server/files.ts` | 目录浏览、文件搜索、文件夹创建 |
| **项目管理** | `server/projects.ts` | 项目 CRUD，路径去重 |
| **会话持久化** | `server/sessions.ts` | SDK 会话存储与恢复 |

#### 前端应用

| 组件 | 说明 |
|------|------|
| **ChatPage** | 主聊天界面，项目切换，消息流展示 |
| **MessageList** | 消息渲染（文本、思考、工具调用、工具结果） |
| **InputBar** | 用户输入，命令前缀支持 |
| **ProjectList** | 项目浏览与选择 |
| **ModelSelector** | 模型选择与切换 |
| **FileBrowser** | 文件系统导航，@ 引用文件 |
| **SessionSidebar** | 会话列表与恢复 |
| **PushNotificationTest** | 推送通知测试 |
| **UserQuestionForm** | 工具权限确认表单 |

#### PWA 能力

- Service Worker 注册与推送事件处理
- 离线通知展示（`sw.js`）
- PWA 清单（`manifest.json`）：独立显示模式，自适应图标
- iOS Safari 16.4+ 支持（Web App 模式）

### 3.2 现有文件结构

```
codecrab/
├── server/
│   ├── index.ts              # Express 入口，路由注册，WebSocket 升级
│   ├── engine/               # AI 引擎适配层（可插拔）
│   │   ├── types.ts          # 引擎统一接口定义（EngineAdapter）
│   │   ├── claude.ts         # Claude Code SDK 适配实现
│   │   └── index.ts          # 引擎注册与切换入口
│   ├── files.ts              # 文件系统 API
│   ├── projects.ts           # 项目 CRUD
│   ├── sessions.ts           # 会话持久化
│   ├── models.ts             # 模型配置管理（全局默认 + 项目级）
│   └── mcp/                  # MCP 扩展统一目录
│       ├── cron/             # 定时任务 MCP
│       │   ├── index.ts      # CronSystem 入口
│       │   ├── types.ts      # 任务/调度类型定义
│       │   ├── scheduler.ts  # node-cron 调度引擎
│       │   ├── executor.ts   # WebSocket 执行器
│       │   ├── store.ts      # JSON 文件持久化
│       │   ├── routes.ts     # 定时任务 API 路由
│       │   └── mcp-server.ts # MCP 工具暴露
│       ├── push/             # 消息推送 MCP
│       │   ├── push.ts       # Web Push API 路由
│       │   └── mcp-server.ts # MCP 工具暴露
│       └── chrome/           # 浏览器管理 MCP
│           └── chrome.ts     # Chrome 懒启动，DevTools Protocol
├── src/
│   ├── main.tsx              # React 入口
│   ├── hooks/
│   │   ├── useWebSocket.ts   # WebSocket 状态与方法
│   │   ├── WebSocketContext.tsx
│   │   └── usePushNotification.ts
│   ├── components/
│   │   ├── ChatPage.tsx      # 主聊天页
│   │   ├── MessageList.tsx   # 消息列表
│   │   ├── InputBar.tsx      # 输入栏
│   │   ├── ProjectList.tsx   # 项目列表
│   │   ├── ModelSelector.tsx
│   │   ├── FileBrowser.tsx
│   │   ├── SessionSidebar.tsx
│   │   └── ...
│   └── routes/
│       └── routeTree.ts      # TanStack Router
├── public/
│   ├── sw.js                 # Service Worker
│   └── manifest.json         # PWA 清单
├── mcp-config.json           # MCP 服务器定义
├── package.json
├── vite.config.ts
└── .sessions/                # 运行时数据（项目、会话）
```

### 3.3 现有 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/ws` | WebSocket | Claude 通讯主通道 |
| `/api/files` | GET | 目录内容列表 |
| `/api/files/search` | GET | 递归文件搜索 |
| `/api/files/mkdir` | POST | 创建文件夹 |
| `/api/sessions` | GET | 列出所有会话及状态 |
| `/api/projects` | GET/POST | 项目列表 / 创建项目 |
| `/api/projects/:id` | GET/DELETE | 项目详情 / 删除 |
| `/api/push/subscribe` | POST | 注册推送订阅 |
| `/api/push/unsubscribe` | POST | 取消推送订阅 |
| `/api/push/send` | POST | 发送推送通知 |
| `/api/push/subscriptions/count` | GET | 订阅者计数 |
| `/api/chrome/status` | GET | Chrome 运行状态 |
| `/api/chrome/start` | POST | 启动 Chrome |
| `/api/chrome/stop` | POST | 停止 Chrome |
| `/api/cron/execute` | POST | 执行定时任务 |
| `/api/cron/result/:runId` | POST | 报告任务执行结果 |
| `/api/cron/schedule/:jobId` | POST | 调度任务 |
| `/api/cron/health` | GET | 定时任务健康检查 |

### 3.4 现有 MCP 集成

| MCP 服务 | 工具 | 说明 |
|----------|------|------|
| **Cron Tasks** | `cron_create`, `cron_list`, `cron_get`, `cron_delete` | 定时任务管理，自然语言调度 |
| **Push Notifications** | `push_send` | 异步消息推送 |
| **Chrome DevTools** | Claude SDK 内置 | 浏览器自动化，DevTools Protocol |

---

## 四、新增需求

### 4.1 前端站点（产品官网）

#### 4.1.1 产品介绍页

- 产品功能概览与核心卖点
- 安装流程图文教程
- 对外 API 文档（REST + WebSocket 协议说明）
- 技术架构介绍

#### 4.1.2 配置向导页

引导用户完成从安装到使用的全流程：

1. **网络配置引导**：选择局域网/公网模式，生成 Token
2. **模型配置引导**：扫描本地环境，选择或配置 API 模型
3. **浏览器能力引导**：引导安装 Chrome + Chrome DevTools MCP
4. **插件安装引导**：推荐基础插件集

#### 4.1.3 初始化状态检测

- 浏览器 Session Storage 存储初始化进度
- 首次访问自动进入配置向导
- 支持本地服务直接授权和远端服务通过消息转发完成注册

### 4.2 消息转发服务（公网中继）

#### 4.2.1 架构设计

```
[用户浏览器] ←→ [公网转发服务器] ←→ [用户局域网本地服务]
                     ↑
              Token 认证 + WebSocket 隧道
```

#### 4.2.2 功能要求

| 功能 | 说明 |
|------|------|
| **WebSocket 隧道** | 本地服务通过 Token 认证与公网服务器建立持久连接 |
| **请求转发** | 公网服务器将用户请求透明转发至本地服务 |
| **响应回传** | 本地服务的响应通过隧道回传至用户浏览器 |
| **Token 认证** | 所有连接必须携带有效 Token |
| **连接管理** | 自动重连、心跳检测、连接超时处理 |
| **地址分配** | 为每个本地服务分配唯一的公网访问地址（子域名或路径） |

#### 4.2.3 安全要求

- 传输层加密（WSS/TLS）
- Token 有效期管理与轮换
- 限流与防滥用机制
- 数据不落地（转发服务不持久化用户数据）

### 4.3 插件市场

#### 4.3.1 插件类型

| 类型 | 示例 |
|------|------|
| **MCP 扩展** | 浏览器管理、数据库操作、第三方 API 集成 |
| **工具插件** | 代码格式化、图片处理、文档生成 |
| **主题插件** | UI 主题、快捷键方案 |

#### 4.3.2 浏览器能力集成

浏览器能力作为插件市场的核心插件：

1. **前置条件检测**：检查本地 Chrome 安装状态
2. **引导安装**：提供 Chrome 下载链接和安装指引
3. **MCP 注册**：安装 Chrome DevTools MCP 并在本地注册
4. **能力激活**：注册完成后即可使用浏览器自动化能力

#### 4.3.3 插件生命周期

```
发现 → 安装 → 配置 → 激活 → 使用 → 更新/卸载
```

### 4.4 默认工程

- 在用户根目录（`~/codecrab-workspace`）创建默认项目
- 作为用户的初始工作空间
- 包含示例文件和快速入门指引
- 用户可在此空间内执行各种操作

### 4.5 项目检查

- 提供项目健康检查能力
- 验证配置完整性（API Key、网络连通性、MCP 可用性）
- 检查依赖状态
- 确认所有服务正常运行后进入使用流程

---

## 五、技术栈

| 层级 | 技术 |
|------|------|
| **前端框架** | React 19 + TypeScript |
| **路由** | TanStack Router |
| **样式** | Tailwind CSS v4 |
| **构建工具** | Vite |
| **后端框架** | Express 5 |
| **WebSocket** | ws 库 |
| **AI 引擎** | 当前：Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`），可扩展其他引擎 |
| **MCP 协议** | `@modelcontextprotocol/sdk` |
| **定时任务** | node-cron + chrono-node |
| **推送通知** | web-push + VAPID |
| **包管理** | pnpm |
| **PWA** | Service Worker + Web App Manifest |

---

## 六、环境变量

```env
# 必需
ANTHROPIC_API_KEY=sk-...

# 服务端口
PORT=4200

# 推送通知
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_EMAIL=mailto:admin@example.com

# 模型配置（可选，也可通过 UI 配置）
# 模型以 JSON 形式存储在后端：~/.codecrab/models.json
# 支持通过环境变量预设模型
MODEL_DEFAULT=claude        # 全局默认模型标识
# 各模型的 API Key 和 Base URL 通过 UI 或配置文件管理

# 推送 MCP
PUSH_API_URL=http://...
PUSH_AUTH_TOKEN=...
```

---

## 七、里程碑规划

### Phase 1 — 基础安装与网络（新增）

- [ ] NPM 全局安装包封装（`codecrab` CLI）
- [ ] `codecrab setup` 配置向导命令
- [ ] Token 生成与持久化（crypto.randomBytes + 用户盐值）
- [ ] 局域网访问模式
- [ ] 连接认证中间件（Token 校验）

### Phase 2 — 公网转发服务（新增）

- [ ] 转发服务器独立部署包
- [ ] WebSocket 隧道建立与维护
- [ ] 公网地址分配（子域名/路径映射）
- [ ] 心跳检测与自动重连
- [ ] TLS/WSS 加密传输
- [ ] 限流与防滥用

### Phase 3 — 配置向导与前端站点（新增）

- [ ] 产品介绍页面
- [ ] 安装流程交互式向导
- [ ] 本地环境自动检测（已有 Claude 登录、API Key）
- [ ] 初始化状态检测与恢复
- [ ] API 文档页面

### Phase 4 — 插件市场（新增）

- [ ] 插件注册与发现机制
- [ ] 浏览器能力插件（Chrome + DevTools MCP 引导安装）
- [ ] 插件安装/卸载/更新生命周期
- [ ] 插件配置 UI

### Phase 5 — 默认工程与健康检查（新增）

- [ ] 默认工作空间创建（`~/codecrab-workspace`）
- [ ] 项目健康检查（配置、网络、依赖、服务状态）
- [ ] 快速入门示例

### 已完成 ✅

- [x] Express + WebSocket 服务
- [x] Claude Code SDK 集成与流式通讯
- [x] 模型配置管理（多模型切换，当前为 hardcode 实现，待重构为动态配置）
- [x] 项目与会话管理（CRUD、持久化、恢复）
- [x] 定时任务 MCP（创建、调度、执行、自然语言解析）
- [x] 消息推送 MCP（Web Push + VAPID）
- [x] Chrome DevTools 懒启动与浏览器自动化
- [x] 文件系统浏览与搜索
- [x] React 前端（聊天、项目、会话、模型切换）
- [x] PWA 支持（Service Worker、离线通知、iOS/Android）
- [x] 权限控制（bypassPermissions / 用户确认模式）
- [x] 成本与时长追踪
- [x] 多客户端同步（同项目多标签页广播）
