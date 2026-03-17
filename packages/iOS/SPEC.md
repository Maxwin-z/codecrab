# CodeCrab iOS App — 实现规格文档

本文档为 iOS 原生客户端的完整实现规格，功能对标 `packages/app` React Web 端。
目标：使用 **SwiftUI** 构建，连接现有 CodeCrab Server (`packages/server`) 的 REST API 和 WebSocket。

> **当前状态：** Xcode 模板项目（SwiftData 示例代码），需要完全重写。
> **保留：** `CodeCrabApp.swift` 作为入口（需重写内容），删除 `Item.swift` 和模板 `ContentView.swift`。

---

## 目录

1. [项目结构](#1-项目结构)
2. [数据模型（Swift Structs）](#2-数据模型)
3. [网络层](#3-网络层)
4. [认证模块](#4-认证模块)
5. [WebSocket 管理](#5-websocket-管理)
6. [页面与导航](#6-页面与导航)
7. [登录页](#7-登录页)
8. [首页（项目列表）](#8-首页项目列表)
9. [创建项目页](#9-创建项目页)
10. [聊天页](#10-聊天页)
11. [消息列表](#11-消息列表)
12. [输入栏](#12-输入栏)
13. [会话侧边栏](#13-会话侧边栏)
14. [用户问答表单](#14-用户问答表单)
15. [权限请求对话框](#15-权限请求对话框)
16. [设置页（模型配置）](#16-设置页模型配置)
17. [错误处理](#17-错误处理)
18. [iOS 特有注意事项](#18-ios-特有注意事项)

---

## 1. 项目结构

```
CodeCrab/
├── CodeCrabApp.swift              # App 入口，注入环境对象
├── Models/                         # 数据模型
│   ├── Project.swift
│   ├── Session.swift
│   ├── ChatMessage.swift
│   ├── ModelConfig.swift
│   └── WebSocketMessages.swift     # 所有 WS 消息类型
├── Services/                       # 网络 & 业务逻辑
│   ├── AuthService.swift           # Token 存储、验证、请求封装
│   ├── APIClient.swift             # REST API 封装
│   └── WebSocketService.swift      # WS 连接、消息处理、状态管理
├── Views/                          # SwiftUI 视图
│   ├── LoginView.swift
│   ├── HomeView.swift
│   ├── ProjectListView.swift
│   ├── CreateProjectView.swift
│   ├── ChatView.swift
│   ├── MessageListView.swift
│   ├── MessageBubbleView.swift
│   ├── InputBarView.swift
│   ├── SessionSidebarView.swift
│   ├── UserQuestionFormView.swift
│   ├── PermissionRequestView.swift
│   ├── SettingsView.swift
│   └── FileBrowserView.swift
├── ViewModels/                     # 视图模型（如需要）
│   ├── ChatViewModel.swift
│   └── ProjectViewModel.swift
└── Utilities/
    ├── ImageCompressor.swift       # 图片压缩
    ├── TimeAgo.swift               # 相对时间格式化
    └── KeychainHelper.swift        # Keychain 封装
```

---

## 2. 数据模型

所有模型使用 `Codable` struct，与服务端 JSON 直接映射。

### Project

```swift
struct Project: Codable, Identifiable {
    let id: String              // "proj-{timestamp}-{random}"
    let name: String
    let path: String            // 服务器上的绝对路径
    let icon: String            // Emoji，如 "🚀"
    let createdAt: Double       // Unix timestamp (ms)
    let updatedAt: Double       // Unix timestamp (ms)
}
```

### SessionInfo

```swift
struct SessionInfo: Codable, Identifiable {
    var id: String { sessionId }
    let sessionId: String
    let summary: String
    let lastModified: Double    // Unix timestamp (ms)
    let firstPrompt: String?
    let cwd: String?
    let status: String?         // "idle" | "processing" | "error"
    let isActive: Bool?
}
```

### ChatMessage

```swift
struct ChatMessage: Codable, Identifiable {
    let id: String
    let role: String            // "user" | "assistant" | "system"
    let content: String
    var images: [ImageAttachment]?
    var thinking: String?
    var toolCalls: [ToolCall]?
    var costUsd: Double?
    var durationMs: Double?
    let timestamp: Double       // Unix timestamp (ms)
}

struct ToolCall: Codable, Identifiable {
    let name: String
    let id: String
    let input: JSONValue        // 用 AnyCodable 或自定义 JSONValue 类型
    var result: String?
    var isError: Bool?
}

struct ImageAttachment: Codable {
    let data: String            // Base64
    let mediaType: String       // "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    let name: String?
}
```

### ModelConfig

```swift
struct ModelConfig: Codable, Identifiable {
    let id: String              // UUID
    let name: String
    let provider: String        // "anthropic" | "openai" | "google" | "custom"
    let configDir: String?      // ~/.claude (CLI 托管)
    let apiKey: String?         // 手动 API key（GET 时已脱敏）
    let baseUrl: String?
}

struct ModelInfo: Codable {
    let value: String           // Model ID
    let displayName: String
    let description: String
    let supportsEffort: Bool?
    let supportedEffortLevels: [String]?
    let supportsAdaptiveThinking: Bool?
    let supportsFastMode: Bool?
}
```

### ProjectStatus

```swift
struct ProjectStatus: Codable {
    let projectId: String
    let status: String          // "idle" | "processing"
    let sessionId: String?
    let firstPrompt: String?
    let lastModified: Double?
}
```

### Question（用户问答）

```swift
struct Question: Codable {
    let question: String
    let header: String?
    let multiSelect: Bool?
    let options: [QuestionOption]
}

struct QuestionOption: Codable {
    let label: String
    let description: String?
}
```

### PendingPermission

```swift
struct PendingPermission: Codable {
    let requestId: String
    let toolName: String
    let input: JSONValue
    let reason: String
}
```

### JSONValue 辅助类型

需要实现一个通用的 `JSONValue` 类型来处理 `unknown/any` 类型的 JSON 字段：

```swift
enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null
}
```

---

## 3. 网络层

### APIClient

封装所有 REST API 调用。

**基础配置：**
- Base URL: 从用户配置读取（如 `http://192.168.1.x:4200`），首次启动需用户输入服务器地址
- 超时时间: 10 秒
- 所有请求（除公开端点）带 `Authorization: Bearer <token>` header
- Content-Type: `application/json`

**公开端点（无需 Token）：**

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/auth/status` | 检查服务器是否配置了认证 |
| POST | `/api/auth/verify` | 验证 token，body: `{ "token": "xxx" }` |
| GET | `/api/setup/detect` | 检查 Claude Code 是否安装 |
| GET | `/api/setup/detect/probe` | 完整 CLI 探测 |
| GET | `/api/health` | 健康检查 |

**受保护端点：**

| 方法 | 路径 | 用途 | 请求体/参数 | 响应 |
|------|------|------|-------------|------|
| GET | `/api/projects` | 项目列表 | — | `Project[]` |
| POST | `/api/projects` | 创建项目 | `{ name, path, icon }` | `Project` (201) |
| GET | `/api/projects/:id` | 项目详情 | — | `Project` |
| DELETE | `/api/projects/:id` | 删除项目 | — | 204 |
| GET | `/api/sessions?projectId=xx` | 会话列表 | query: projectId | `SessionInfo[]` |
| DELETE | `/api/sessions/:id` | 删除会话 | — | 204 |
| GET | `/api/setup/status` | 模型设置状态 | — | `{ initialized, modelCount }` |
| GET | `/api/setup/models` | 模型列表 | — | `{ models: ModelConfig[], defaultModelId? }` |
| POST | `/api/setup/models` | 添加模型 | `{ name, provider, apiKey?, configDir?, baseUrl? }` | `{ id }` (201) |
| PUT | `/api/setup/models/:id` | 更新模型 | Partial ModelConfig | `{ ok: true }` |
| DELETE | `/api/setup/models/:id` | 删除模型 | — | `{ ok: true }` |
| PUT | `/api/setup/default-model` | 设置默认模型 | `{ modelId }` | `{ ok: true }` |
| POST | `/api/setup/use-claude` | 注册 CLI 模型 | `{ subscriptionType? }` | `{ id }` |
| POST | `/api/setup/models/:id/test` | 测试 API Key | — | `{ ok, error?, skipped? }` |
| GET | `/api/files?path=xx` | 文件浏览 | query: path | `{ current, parent, items: FileEntry[] }` |
| POST | `/api/files/mkdir` | 创建目录 | `{ path, name }` | `{ success, path }` |

**401 处理：** 收到 401 响应时清除 Token，跳转登录页。

---

## 4. 认证模块

### AuthService

```swift
class AuthService: ObservableObject {
    @Published var isAuthenticated: Bool = false
    @Published var isLoading: Bool = true  // 启动时检查状态

    // Token 存储在 Keychain
    func getToken() -> String?
    func setToken(_ token: String)
    func clearToken()

    // 服务器地址存储在 UserDefaults
    func getServerURL() -> String?
    func setServerURL(_ url: String)

    // 验证流程
    func verifyToken(_ token: String) async throws -> Bool
    // POST /api/auth/verify，body: { "token": token }
    // 成功: 存储 token，设置 isAuthenticated = true
    // 失败: 抛出错误

    // 启动时检查
    func checkAuth() async
    // 1. 检查 Keychain 中是否有 token
    // 2. 如果有，GET /api/auth/status 验证是否仍然有效
    // 3. 更新 isAuthenticated

    func logout()
    // 清除 token，isAuthenticated = false
}
```

### Keychain 存储

使用 Security framework 存储 token：
- Service: `"com.codecrab.token"`
- Account: `"access_token"`
- 另存服务器地址到 UserDefaults key: `"codecrab_server_url"`

---

## 5. WebSocket 管理

### WebSocketService

这是整个 App 最核心的模块，管理所有实时通信和聊天状态。

```swift
@MainActor
class WebSocketService: ObservableObject {
    // --- 全局状态 ---
    @Published var connected: Bool = false
    @Published var availableModels: [ModelInfo] = []
    @Published var projectStatuses: [ProjectStatus] = []

    // --- 当前项目状态（活跃项目的投影） ---
    @Published var messages: [ChatMessage] = []
    @Published var streamingText: String = ""
    @Published var streamingThinking: String = ""
    @Published var isRunning: Bool = false
    @Published var isAborting: Bool = false
    @Published var pendingQuestion: PendingQuestion? = nil
    @Published var pendingPermission: PendingPermission? = nil
    @Published var sessionId: String = ""
    @Published var cwd: String = ""
    @Published var latestSummary: String? = nil
    @Published var currentModel: String = ""
    @Published var permissionMode: String = "default"  // "default" | "bypassPermissions"

    // --- 内部 ---
    private var activeProjectId: String? = nil
    private var projectStates: [String: ProjectChatState] = [:]  // 每项目状态缓存
    private var webSocketTask: URLSessionWebSocketTask?
    private var clientId: String  // 持久化到 UserDefaults
}
```

### ProjectChatState（内部结构）

```swift
struct ProjectChatState {
    var messages: [ChatMessage] = []
    var streamingText: String = ""
    var streamingThinking: String = ""
    var pendingQuestion: PendingQuestion? = nil
    var pendingPermission: PendingPermission? = nil
    var isRunning: Bool = false
    var isAborting: Bool = false
    var sessionId: String = ""
    var cwd: String = ""
    var latestSummary: String? = nil
    var currentModel: String = ""
    var permissionMode: String = "default"
}

struct PendingQuestion {
    let toolId: String
    let questions: [Question]
}
```

### 连接管理

```
connect():
  1. 构建 URL: ws://{serverHost}/ws?clientId={clientId}&token={token}
  2. 创建 URLSessionWebSocketTask
  3. task.resume()
  4. 进入接收循环 receiveLoop()
  5. connected = true

disconnect():
  1. task.cancel(with: .goingAway)
  2. connected = false

reconnect():
  1. 等待 2 秒
  2. 如果非主动关闭，调用 connect()
  3. 重连后如果有 activeProjectId，重新发送 switch_project
```

### 发送方法

所有项目级消息自动附带 `projectId` 和 `sessionId`：

```swift
func sendPrompt(_ text: String, images: [ImageAttachment]? = nil)
// { type: "prompt", prompt: text, images: [...], projectId, sessionId }

func sendCommand(_ command: String)
// { type: "command", command: command, projectId, sessionId }

func abort()
// { type: "abort", projectId, sessionId }
// 设置 isAborting = true

func resumeSession(_ sessionId: String)
// { type: "resume_session", sessionId: sessionId, projectId }
// 清空当前 messages

func setWorkingDir(_ dir: String)
// { type: "set_cwd", cwd: dir, projectId, sessionId }

func setModel(_ model: String)
// { type: "set_model", model: model, projectId, sessionId }

func setPermissionMode(_ mode: String)
// { type: "set_permission_mode", mode: mode, projectId, sessionId }

func respondToPermission(requestId: String, allow: Bool)
// { type: "respond_permission", requestId, allow, projectId, sessionId }
// 发送后清除 pendingPermission

func submitQuestionResponse(toolId: String, answers: [String: Any])
// { type: "respond_question", toolId, answers, projectId, sessionId }
// 发送后清除 pendingQuestion

func dismissQuestion()
// 仅清除本地 pendingQuestion，不发消息

func switchProject(projectId: String, cwd: String?)
// { type: "switch_project", projectId, projectCwd: cwd }
// 更新 activeProjectId，从缓存恢复状态

func newChat()
// 发送 sendCommand("/clear")
```

### 接收消息处理

```
receiveLoop():
  while connected:
    let message = await task.receive()
    解析 JSON → 根据 type 字段分发处理
```

**消息处理表：**

| type | 处理逻辑 |
|------|----------|
| `available_models` | 更新 `availableModels` |
| `project_statuses` | 更新 `projectStatuses` |
| `query_start` | 对应项目 `isRunning = true` |
| `query_end` | `isRunning = false`, `isAborting = false`；如果 `streamingText` 非空，合并为 assistant message 追加到 messages；清空 `streamingText` 和 `streamingThinking` |
| `stream_delta` | `deltaType == "text"` → 追加到 `streamingText`；`deltaType == "thinking"` → 追加到 `streamingThinking` |
| `assistant_text` | 创建 assistant ChatMessage 追加到 messages，清空 streamingText |
| `thinking` | 追加到最后一条 assistant message 的 `thinking` 字段 |
| `tool_use` | 创建 system ChatMessage，toolCalls 包含 `{ name, id, input }`。如果最后一条 system message 已有 toolCalls，追加到同一条 |
| `tool_result` | 在 messages 中找到包含该 `toolId` 的 toolCall，设置 `result` 和 `isError` |
| `ask_user_question` | 设置 `pendingQuestion = { toolId, questions }` |
| `permission_request` | 设置 `pendingPermission = { requestId, toolName, input, reason }` |
| `session_resumed` | 更新 `sessionId` |
| `message_history` | 替换整个 `messages` 数组 |
| `user_message` | 追加到 messages（去重：5 秒内相同内容不重复追加） |
| `model_changed` | 更新 `currentModel` |
| `permission_mode_changed` | 更新 `permissionMode` |
| `cwd_changed` | 更新 `cwd` |
| `error` | 追加 system error ChatMessage |
| `cleared` | 清空 messages、streamingText、streamingThinking |
| `aborted` | `isRunning = false`, `isAborting = false` |
| `result` | 追加 system ChatMessage，包含 `costUsd`、`durationMs`、`content = result` |
| `query_summary` | 更新 `latestSummary` |

### 项目状态缓存

- 切换项目时，保存当前项目状态到 `projectStates[oldProjectId]`
- 加载新项目状态从 `projectStates[newProjectId]`（如果有缓存）
- 将缓存状态投影到 `@Published` 属性，触发 UI 更新

### 消息去重

```swift
// 用户消息去重：5秒内相同 role + content 不重复
func isDuplicate(_ message: ChatMessage) -> Bool {
    guard message.role == "user" else { return false }
    let now = Date().timeIntervalSince1970 * 1000
    return messages.contains { existing in
        existing.role == "user" &&
        existing.content == message.content &&
        abs(existing.timestamp - message.timestamp) < 5000
    }
}
```

### Streaming 文本清理

在 `query_end` 合并 streamingText 时，去除末尾的 `[SUMMARY: ...]`：

```swift
func cleanStreamingText(_ text: String) -> String {
    // 正则移除 \[SUMMARY:.*?\]$
}
```

---

## 6. 页面与导航

### 导航结构

```swift
@main
struct CodeCrabApp: App {
    @StateObject var authService = AuthService()
    @StateObject var webSocketService = WebSocketService()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authService)
                .environmentObject(webSocketService)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var auth: AuthService

    var body: some View {
        if auth.isLoading {
            // 启动加载画面
        } else if !auth.isAuthenticated {
            LoginView()
        } else {
            NavigationStack {
                HomeView()
            }
        }
    }
}
```

### 导航路径

```
LoginView
  ↓ (登录成功)
HomeView (项目列表)
  ├── → CreateProjectView (创建项目)
  ├── → SettingsView (设置/模型配置)
  └── → ChatView(projectId) (聊天)
        └── SessionSidebarView (sheet/侧边栏)
```

---

## 7. 登录页

### LoginView

**UI 布局：**
- 垂直居中的卡片
- 标题: "Welcome to CodeCrab"
- 副标题: "Enter your access token to continue"
- 服务器地址输入框（首次需要，如 `http://192.168.1.x:4200`）
- Token 输入框（SecureField）
- 错误消息（红色背景）
- 登录按钮（带 loading 状态）

**状态：**
```swift
@State private var serverURL: String = ""  // 首次需要输入
@State private var token: String = ""
@State private var isLoading: Bool = false
@State private var error: String? = nil
```

**流程：**
1. 用户输入服务器地址（仅首次，之后从 UserDefaults 读取）
2. 用户输入 token
3. 点击登录：
   - 验证输入非空
   - 保存服务器地址
   - 调用 `POST {serverURL}/api/auth/verify`，body: `{ "token": token }`
   - 成功 → 存储 token 到 Keychain，`authService.isAuthenticated = true`
   - 失败 → 显示 "Invalid token. Please check and try again."

---

## 8. 首页（项目列表）

### HomeView

**UI 布局：**
- NavigationStack 标题: "CodeCrab"
- toolbar:
  - 右上: "+" 按钮（创建项目）+ 齿轮按钮（设置）
- 内容: ProjectListView

### ProjectListView

**UI 布局：**
- LazyVGrid（2 列，iPad 可 3 列）
- 每个项目卡片:
  - 圆角矩形背景
  - 左上: emoji icon (大号)
  - 标题: 项目名称
  - 副标题: path（截断显示）
  - 右上角: 状态指示器
    - 绿色圆点 = active（10 分钟内有活动）
    - 橙色脉冲圆点 = processing
  - 底部: 最后更新时间
- 空状态: 文件夹图标 + "No projects yet" + 创建按钮
- 加载状态: ProgressView
- 支持下拉刷新

**交互：**
- 点击项目 → NavigationLink 到 `ChatView(project: project)`
- 左滑删除 → 确认 Alert → `DELETE /api/projects/{id}`

**数据：**
- `onAppear`: `GET /api/projects`
- 实时状态: 从 `webSocketService.projectStatuses` 匹配

**状态指示器逻辑：**
```swift
func projectIndicator(for project: Project) -> some View {
    let status = webSocketService.projectStatuses.first { $0.projectId == project.id }
    if status?.status == "processing" {
        // 橙色脉冲动画圆点
    } else if let lastModified = status?.lastModified,
              Date().timeIntervalSince1970 * 1000 - lastModified < 600_000 {
        // 绿色实心圆点
    } else {
        // 无指示器
    }
}
```

---

## 9. 创建项目页

### CreateProjectView

**UI 布局（从上到下）：**
1. **导航栏**: 返回按钮 + "New Project" 标题
2. **路径显示**: 当前目录路径 + "New Folder" 按钮
3. **文件列表**（ScrollView / List）:
   - 首行: "↑ Go Up"（如果不在根目录）
   - 只显示目录（不显示文件）
   - 每行: 📁 图标 + 目录名
4. **底部配置面板**（固定在底部）:
   - 图标选择: 点击 emoji 弹出选择器 Sheet
   - 项目名称: TextField
   - 路径预览: 只读文本（当前目录）
   - "Cancel" + "Create" 按钮

**Emoji 选择器：**
```swift
let projectIcons = ["🚀","💻","⭐","🎯","🎨","📱","🌐","⚡","🔧","🎮",
    "📊","🔬","🎵","📚","🏗️","🤖","💡","🔒","🎬","🌈",
    "🦀","🐍","🦊","🐳","🐧","🦅","🐝","🦋","🍎","🍊",
    "💎","🔮","🎪","🏰","🎲","🧩","🔭","🧪","⚙️","🛠️",
    "📡","🗂️","📦","🏷️","✏️","📝","🗃️","💼","🎓","🌍",
    "🌙","☀️","⛅","🌊","🔥","💧","🌿","🍀","🌸","🌺",
    "🎸","🎹","🥁","🎤","🎧","📷","🎥","📺","💻","⌨️"]
```
LazyVGrid 8 列展示。

**文件浏览器逻辑：**
```
onAppear:
  GET /api/files  → 加载默认目录（home）

navigateTo(path):
  history.append(currentPath)
  GET /api/files?path={path}
  自动将 projectName 设为目录名

goUp():
  navigateTo(listing.parent)

createFolder(name):
  POST /api/files/mkdir  body: { path: currentPath, name }
  成功后重新加载当前目录
```

**创建项目：**
```
validate: name 非空
POST /api/projects  body: { name, path: listing.current, icon }
成功 → dismiss，回到首页
```

---

## 10. 聊天页

### ChatView

**参数：** `project: Project`

**UI 布局（从上到下）：**
1. **Header**（固定顶部）:
   - 返回按钮
   - `project.icon` + `project.name`
   - `project.path`（小字，截断）
   - 右侧: 会话列表按钮（hamburger/list icon）
2. **连接状态栏**:
   - 圆点（绿=连接 / 红=断开）
   - "Connected" / "Disconnected"
   - Session ID 后 6 位（等宽字体）
3. **消息区域**（ScrollViewReader，占满剩余空间）:
   - MessageListView
   - 自动滚到底部
4. **Summary 栏**（可选，`latestSummary` 非空时显示）:
   - 绿色背景横条
5. **User Question Form**（可选，`pendingQuestion` 非空时显示）
6. **Permission Request**（可选，`pendingPermission` 非空时显示）
7. **InputBarView**（固定底部）

**生命周期：**
```
onAppear:
  webSocketService.switchProject(projectId: project.id, cwd: project.path)

onDisappear:
  // 保留状态在缓存中，不断连
```

**发送消息：**
```swift
func handleSend(text: String, images: [ImageAttachment]?) {
    if text.hasPrefix("/") {
        webSocketService.sendCommand(text)
    } else {
        webSocketService.sendPrompt(text, images: images)
    }
}
```

**自动滚动：**
- 监听 `messages.count`、`streamingText`、`streamingThinking` 变化
- 变化时滚到底部（使用 ScrollViewReader + proxy.scrollTo）

---

## 11. 消息列表

### MessageListView

**空状态：** 居中显示 "CodeCrab" 大标题 + "Send a message to start" 副标题

**消息渲染（按 role 区分）：**

#### 用户消息
- 右对齐（HStack + Spacer 在左）
- 蓝色/主色调背景
- 最大宽度 85%
- 圆角（左侧全圆角，右下方角）
- 如有图片：消息上方展示缩略图网格（每张 max 128pt 高, 192pt 宽）
- 白色文本

#### 助手消息
- 左对齐
- 灰色/次要背景
- 最大宽度 95%
- 如有 `thinking`：折叠区域
  - 标题: "Thinking..." (橙色文字)
  - 展开后显示 thinking 内容
- content: 等宽或普通文本，保留换行

#### 系统消息（有 toolCalls）
- 全宽卡片，每个 toolCall 为一个折叠块
- 头部:
  - 状态圆点：橙色脉冲（无结果）/ 红色（isError）/ 绿色（有结果且非 error）
  - 工具名称（等宽字体，青色/蓝绿色）
  - Input 摘要文本
- 展开后:
  - Input: JSON 格式化显示
  - Result: 文本显示（如有）

**Input 摘要逻辑：**
```swift
func toolInputSummary(name: String, input: JSONValue) -> String {
    switch name {
    case "Read", "Edit": return input["file_path"] as? String ?? ""
    case "Bash": return String((input["command"] as? String ?? "").prefix(120))
    case "Glob", "Grep": return input["pattern"] as? String ?? ""
    default: return ""
    }
}
```

#### 系统消息（无 toolCalls）
- 居中，小号灰色文字
- 如有 `costUsd`: 显示 `($X.XXXX | Ys)` 花费和耗时

#### Streaming 状态（非持久消息，实时显示）
- **streamingThinking 非空**: 灰色卡片，"Thinking:" 标签（橙色）+ 文本
- **streamingText 非空**: 灰色卡片 + 文本
- **isRunning 但无流式文本**: 脉冲橙色圆点 + "Processing..."

---

## 12. 输入栏

### InputBarView

**UI 布局：**
- 圆角容器，带边框
- 拖拽时高亮边框颜色
- **图片预览区**（如有图片）:
  - 水平滚动
  - 每张 64×64pt 缩略图
  - 右上角 × 删除按钮
- **TextEditor**:
  - 自动增长高度（max 150pt）
  - placeholder: "Message..."
  - 禁用时（isRunning）: "Running..."
- **底部工具栏**:
  - 左: 📎 图片选择按钮（PhotosPicker）
  - 右: 模式切换按钮 + 模型名称 + 发送/中止按钮

**回调：**
```swift
var onSend: (String, [ImageAttachment]?) -> Void
var onAbort: () -> Void
var onPermissionModeChange: (String) -> Void
var isRunning: Bool
var isAborting: Bool
var currentModel: String
var permissionMode: String
```

**图片处理：**
- 使用 PhotosPicker（iOS 16+）选择图片
- 支持: JPEG, PNG, GIF, WebP
- 压缩逻辑:
  1. 读取原图
  2. 如果最长边 > 1568px，等比缩放
  3. JPEG 压缩 quality = 0.85
  4. 如果 > 5MB，降低 quality 再试（每次 -0.1）
  5. 输出 base64 字符串

```swift
func compressImage(_ image: UIImage) -> ImageAttachment? {
    let maxDimension: CGFloat = 1568
    let resized = // 等比缩放
    var quality: CGFloat = 0.85
    while quality > 0.1 {
        if let data = resized.jpegData(compressionQuality: quality),
           data.count <= 5_000_000 {
            return ImageAttachment(
                data: data.base64EncodedString(),
                mediaType: "image/jpeg",
                name: nil
            )
        }
        quality -= 0.1
    }
    return nil
}
```

**发送逻辑：**
- Command+Return 或点击发送按钮
- 验证: text 非空 且 !isRunning
- 调用 `onSend(text.trimmingCharacters(in: .whitespacesAndNewlines), images)`
- 清空 text 和 images

**模式切换：**
- 点击切换按钮
- "Safe" (绿色) ↔ "YOLO" (橙色)
- 调用 `onPermissionModeChange("default")` 或 `onPermissionModeChange("bypassPermissions")`

**中止按钮：**
- `isRunning == true` 时替代发送按钮
- 红色背景 + 停止图标
- `isAborting == true` 时显示 ProgressView
- 点击调用 `onAbort()`

---

## 13. 会话侧边栏

### SessionSidebarView

**呈现方式：** `.sheet` 或自定义侧边栏（从右侧滑入）

**UI 布局：**
- 标题: "Sessions" + 关闭按钮
- "New Chat" 按钮（蓝色，全宽）
- 会话列表（ScrollView / List）:
  - 每行:
    - 主标题: `summary` 或 `firstPrompt` 或 "Untitled session"
    - 副标题: 相对时间 + session ID 后 6 位
    - 右侧: 状态 badge
      - "idle" → 灰色
      - "processing" → 橙色脉冲
      - "error" → 红色
  - 当前会话高亮
- 空状态: "No previous sessions"

**状态：**
```swift
@State private var sessions: [SessionInfo] = []
@State private var loading: Bool = false
@State private var now: Date = Date()  // 用于相对时间
```

**数据流：**
```
onAppear:
  GET /api/sessions?projectId={projectId}
  设置 Timer 每 60s 更新 now（刷新相对时间）
  设置 Timer 每 3s 静默刷新会话列表
```

**交互：**
- 点击会话 → `webSocketService.resumeSession(session.sessionId)` → dismiss
- 点击 "New Chat" → `webSocketService.newChat()` → dismiss

**相对时间函数：**
```swift
func timeAgo(from timestamp: Double, now: Date) -> String {
    let diff = now.timeIntervalSince1970 * 1000 - timestamp
    let minutes = diff / 60_000
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(Int(minutes))m ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(Int(hours))h ago" }
    let days = hours / 24
    return "\(Int(days))d ago"
}
```

---

## 14. 用户问答表单

### UserQuestionFormView

**参数：**
```swift
let toolId: String
let questions: [Question]
let onSubmit: ([String: Any]) -> Void  // answers dict
let onCancel: () -> Void
```

**UI 布局：**
- 圆角深色容器
- 蓝色图标 header
- **Tab 栏**（多个问题时）:
  - 水平滚动
  - "Q1", "Q2" ... 标签（截断 20 字符）
  - 已回答 tab: 绿色 ✓ 标记
  - 当前 tab: 蓝色高亮
- **问题内容区**:
  - header badge（如有 `question.header`）
  - 问题文本（粗体）
  - 选项列表:
    - 单选: Radio button 样式
    - 多选: Checkbox 样式
    - 每个选项: label + 可选 description
  - 自定义输入 TextField:
    - 单选已选时禁用
    - placeholder: 单选 "或输入自定义内容" / 多选 "输入自定义内容（追加到已选项）"
- **底部**:
  - 提交按钮（全部回答后启用）
  - 取消按钮
  - 未回答数量 badge

**状态：**
```swift
@State private var activeTab: Int = 0
@State private var answers: [String: [String]] = [:]  // key: "1","2"... (1-based)
@State private var customTexts: [String: String] = [:] // key: "1","2"...
```

**Key 映射：** index (0-based) → key (1-based): `String(index + 1)`

**回答验证：**
```swift
func isAnswered(at index: Int) -> Bool {
    let key = String(index + 1)
    let q = questions[index]
    let custom = (customTexts[key] ?? "").trimmingCharacters(in: .whitespaces)
    if q.multiSelect == true {
        return !(answers[key] ?? []).isEmpty || !custom.isEmpty
    } else {
        return !(answers[key] ?? []).isEmpty || !custom.isEmpty
    }
}

var allAnswered: Bool {
    !questions.indices.contains { !isAnswered(at: $0) }
}
```

**提交：**
```swift
func buildFinalAnswers() -> [String: Any] {
    var result: [String: Any] = [:]
    for (i, q) in questions.enumerated() {
        let key = String(i + 1)
        let custom = (customTexts[key] ?? "").trimmingCharacters(in: .whitespaces)
        if q.multiSelect == true {
            var arr = answers[key] ?? []
            if !custom.isEmpty { arr.append(custom) }
            result[key] = arr
        } else {
            result[key] = (answers[key] ?? []).first ?? custom
        }
    }
    return result
}
```

---

## 15. 权限请求对话框

### PermissionRequestView

**参数：**
```swift
let permission: PendingPermission
let onAllow: () -> Void
let onDeny: () -> Void
```

**UI 布局：**
- 黄色/琥珀色背景的横条或弹窗
- 标题: "Permission Request"
- 工具名称（等宽字体）
- 原因说明文本
- Input 预览（折叠显示 JSON）
- 两个按钮:
  - "Allow" (绿色/蓝色)
  - "Deny" (红色/灰色)

**交互：**
- Allow → `webSocketService.respondToPermission(requestId: permission.requestId, allow: true)`
- Deny → `webSocketService.respondToPermission(requestId: permission.requestId, allow: false)`

---

## 16. 设置页（模型配置）

### SettingsView

**呈现方式：** NavigationLink 或 `.sheet`

**UI 布局：**

#### Section 1: 服务器信息
- 服务器地址（只读显示，可编辑）
- 连接状态
- Claude Code CLI 状态（调用 `/api/setup/detect/probe`）:
  - 已安装版本
  - 认证状态

#### Section 2: 模型列表
- 列表展示所有模型（`GET /api/setup/models`）
- 每个模型行:
  - 名称
  - Provider badge（Anthropic / OpenAI / Google / Custom）
  - 默认模型标记 ⭐
  - 点击进入编辑
- "Add Model" 按钮
- "Use Claude Code" 按钮（快捷注册 CLI 模型）

#### Section 3: 默认模型
- Picker 选择默认模型
- 变更时调用 `PUT /api/setup/default-model`

### ModelEditView（添加/编辑模型）

**UI 布局：**
- Form:
  - Name: TextField
  - Provider: Picker（anthropic / openai / google / custom）
  - API Key: SecureField（仅 provider != "custom" with configDir 时显示）
  - Base URL: TextField（仅 custom provider 时显示）
  - Config Dir: TextField（仅 custom provider 时显示）
- "Test API Key" 按钮 → `POST /api/setup/models/:id/test`
  - 显示结果: ✅ 成功 / ❌ 失败 + 错误信息 / ⏭️ 跳过（CLI 托管模型）
- 保存 / 删除按钮

**流程：**
```
添加: POST /api/setup/models  body: { name, provider, apiKey?, baseUrl?, configDir? }
编辑: PUT /api/setup/models/:id  body: { ...partial fields }
删除: DELETE /api/setup/models/:id  (需确认)
测试: POST /api/setup/models/:id/test
```

---

## 17. 错误处理

| 场景 | 处理方式 |
|------|----------|
| 网络断开 | WebSocket 自动重连（2s 延迟）；REST 请求显示错误 + 重试按钮 |
| 401 Unauthorized | 清除 Token，跳转登录页 |
| API 请求失败 | 显示 Alert 或 inline 错误消息 |
| 请求超时 | 10s 超时，显示超时错误 |
| WebSocket 消息解析失败 | 静默忽略，打印日志 |
| 图片压缩失败 | 显示 Toast 提示 |
| 项目不存在 (404) | 导航回首页 |
| 工具执行错误 | `isError = true`，红色状态指示器 |

---

## 18. iOS 特有注意事项

### 存储
- **Token**: Keychain（`Security` framework）
- **服务器地址**: `UserDefaults`
- **Client ID**: `UserDefaults`，格式 `"client-{timestamp}-{random}"`，首次启动生成

### 最低版本
- iOS 16+（PhotosPicker、NavigationStack）
- 推荐 iOS 17+（更好的 ScrollView 支持）

### 键盘处理
- 聊天页输入栏需跟随键盘上移
- 使用 `.scrollDismissesKeyboard(.interactively)`

### 适配
- iPhone: 单列布局，会话列表用 Sheet
- iPad: 可考虑 NavigationSplitView（侧边栏 + 详情）

### 网络
- 使用 `URLSession` 进行 REST 请求
- 使用 `URLSessionWebSocketTask` 进行 WebSocket
- 需要在 Info.plist 配置 App Transport Security（如果连接 HTTP 非 HTTPS 服务器）:
  ```xml
  <key>NSAppTransportSecurity</key>
  <dict>
      <key>NSAllowsLocalNetworking</key>
      <true/>
  </dict>
  ```

### 后台
- WebSocket 在 App 进入后台时可能断开
- 回到前台时检查连接状态，必要时重连

### 深色模式
- 支持 Light / Dark 自动切换
- 使用系统语义颜色（`.primary`, `.secondary`, `.background`）

---

## 附录：服务器地址配置

Web 端通过 Vite proxy 自动转发到 server，iOS 端需要用户手动配置服务器地址。

**首次启动流程：**
1. 显示服务器配置界面
2. 用户输入地址（如 `http://192.168.1.100:4200`）
3. 调用 `GET {address}/api/health` 验证连通性
4. 成功 → 保存地址，进入登录流程
5. 失败 → 显示错误，让用户重试

**地址格式：** 需包含协议和端口，如 `http://192.168.1.100:4200`
