import Foundation
import Combine
import SwiftUI

struct PendingQuestion: Equatable {
    let toolId: String
    let questions: [Question]
}

struct QueueItem: Identifiable, Equatable {
    let queryId: String
    var status: String  // "queued" | "running"
    var position: Int
    var prompt: String
    var queryType: String  // "user" | "cron"
    var sessionId: String?
    var cronJobName: String?

    var id: String { queryId }
}

struct BackgroundTask: Equatable {
    let taskId: String
    var status: String  // "started" | "progress" | "completed" | "failed" | "stopped"
    var description: String?
    var summary: String?
    var usage: BackgroundTaskUsage?
}

struct BackgroundTaskUsage: Equatable {
    var totalTokens: Int?
    var toolUses: Int?
    var durationMs: Double?
}

// Per-session state (isolated per session within a project)
struct SessionChatState {
    var messages: [ChatMessage] = []
    var streamingText: String = ""
    var streamingThinking: String = ""
    var sdkEvents: [SdkEvent] = []
    var latestSummary: String? = nil
    var suggestions: [String] = []
    var pendingQuestion: PendingQuestion? = nil
    var status: String = "idle"  // "idle" | "processing" | "error"
    var providerId: String? = nil
    var permissionMode: String = "bypassPermissions"
    var isStreaming: Bool = false
    var pendingPermission: PendingPermission? = nil
    var activityHeartbeat: ActivityHeartbeat? = nil
    var usage: SessionUsage? = nil
    var backgroundTasks: [String: BackgroundTask] = [:]
}

// Per-project state (contains per-session state cache)
struct ProjectChatState {
    var sessionId: String = ""  // viewing session
    var sessionStates: [String: SessionChatState] = [:]
    var awaitingSessionSwitch: Bool = false
    var pendingPermission: PendingPermission? = nil
    var isAborting: Bool = false
    var cwd: String = ""
    var currentProviderId: String = ""
    var permissionMode: String = "bypassPermissions"
    var sdkMcpServers: [SdkMcpServer] = []
    var sdkSkills: [SdkSkill] = []
    var sdkTools: [String] = []
    var activityHeartbeat: ActivityHeartbeat? = nil
    var queryQueue: [QueueItem] = []
    var sessionUsage: SessionUsage? = nil
}

struct ActivityHeartbeat: Equatable {
    var elapsedMs: Double
    var lastActivityType: String
    var lastToolName: String?
    var paused: Bool
}

struct ProjectActivity: Equatable {
    var activityType: String  // "thinking" | "text" | "tool_use" | "idle"
    var toolName: String?
    var textSnippet: String?
}

struct SessionUsage: Equatable {
    var totalInputTokens: Int
    var totalOutputTokens: Int
    var totalCacheReadTokens: Int
    var totalCacheCreateTokens: Int
    var totalCostUsd: Double
    var totalDurationMs: Double
    var queryCount: Int
    var contextWindowUsed: Int
    var contextWindowMax: Int
}

@MainActor
class WebSocketService: ObservableObject {
    @Published var connected: Bool = false
    @Published var availableModels: [ModelInfo] = []
    @Published var projectStatuses: [ProjectStatus] = []
    @Published var projectActivities: [String: ProjectActivity] = [:]

    /// Single source of truth for which projects are currently processing.
    /// Driven by query_start (insert) and query_end (remove).
    @Published var runningProjectIds = Set<String>()

    /// Convenience for the active project — derived from runningProjectIds.
    var isRunning: Bool {
        guard let pid = activeProjectId else { return false }
        return runningProjectIds.contains(pid)
    }

    // Per-session @Published properties (display layer for viewing session)
    @Published var messages: [ChatMessage] = []
    @Published var streamingText: String = ""
    @Published var streamingThinking: String = ""
    @Published var sdkEvents: [SdkEvent] = []
    @Published var latestSummary: String? = nil
    @Published var suggestions: [String] = []
    @Published var pendingQuestion: PendingQuestion? = nil

    /// Cached tool detail for Live Activity — persists across heartbeat updates until activity changes
    private var currentToolDetail: String? = nil

    /// Filtered streaming text that hides SUMMARY/SUGGESTIONS tags during streaming
    var displayStreamingText: String {
        getDisplayStreamingText(streamingText)
    }

    // Per-project @Published properties
    @Published var isAborting: Bool = false
    @Published var pendingPermission: PendingPermission? = nil
    @Published var sessionId: String = ""
    @Published var cwd: String = ""
    @Published var currentProviderId: String = ""
    @Published var permissionMode: String = "bypassPermissions"
    @Published var sdkMcpServers: [SdkMcpServer] = []
    @Published var sdkSkills: [SdkSkill] = []
    @Published var sdkTools: [String] = []
    @Published var activityHeartbeat: ActivityHeartbeat? = nil
    @Published var queryQueue: [QueueItem] = []
    @Published var sessionUsage: SessionUsage? = nil
    @Published var toastMessage: String? = nil

    // Thread state (global, not per-project)
    @Published var threads: [String: ThreadInfo] = [:]
    @Published var autoResumeBanners: [AutoResumeBanner] = []

    var sdkLoaded: Bool { !sdkTools.isEmpty }

    /// Temp session ID for correlating new session creation on server-v2
    private var pendingTempSessionId: String? = nil

    /// Timer for detecting unconfirmed prompts
    private var promptConfirmationTimer: DispatchWorkItem? = nil
    /// Tracks the prompt text pending confirmation so it can be cached on timeout
    private var pendingPromptText: String? = nil
    /// Tracks the attachments pending confirmation
    private var pendingPromptImages: [ImageAttachment]? = nil

    private var activeProjectId: String? = nil
    private var activeProjectName: String = ""
    private var activeProjectIcon: String = "🦀"
    private var projectStates: [String: ProjectChatState] = [:]
    private var webSocketTask: URLSessionWebSocketTask?
    private var clientId: String
    /// Projects that recently received query_end — blocks stale "processing"
    /// from project_statuses broadcasts until a clean "idle" confirms it.
    private var recentlyEndedProjectIds = Set<String>()

    init() {
        if let savedId = UserDefaults.standard.string(forKey: "codecrab_client_id") {
            self.clientId = savedId
        } else {
            let newId = "client-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 1000...9999))"
            UserDefaults.standard.set(newId, forKey: "codecrab_client_id")
            self.clientId = newId
        }
    }

    // MARK: - Session State Helpers

    /// Save current @Published per-session data into the active project's session state cache
    private func saveCurrentSessionToState() {
        guard let pid = activeProjectId, !sessionId.isEmpty else { return }
        ensureProjectState(pid)
        projectStates[pid]!.sessionStates[sessionId] = SessionChatState(
            messages: messages,
            streamingText: streamingText,
            streamingThinking: streamingThinking,
            sdkEvents: sdkEvents,
            latestSummary: latestSummary,
            suggestions: suggestions,
            pendingQuestion: pendingQuestion,
            status: projectStates[pid]?.sessionStates[sessionId]?.status ?? "idle",
            providerId: projectStates[pid]?.sessionStates[sessionId]?.providerId,
            permissionMode: permissionMode,
            isStreaming: projectStates[pid]?.sessionStates[sessionId]?.isStreaming ?? false,
            pendingPermission: pendingPermission,
            activityHeartbeat: activityHeartbeat,
            usage: sessionUsage,
            backgroundTasks: projectStates[pid]?.sessionStates[sessionId]?.backgroundTasks ?? [:]
        )
    }

    /// Load per-session data from a session state cache into @Published properties
    private func loadSessionState(_ state: SessionChatState) {
        messages = state.messages
        streamingText = state.streamingText
        streamingThinking = state.streamingThinking
        sdkEvents = state.sdkEvents
        latestSummary = state.latestSummary
        suggestions = state.suggestions
        pendingQuestion = state.pendingQuestion
        pendingPermission = state.pendingPermission
        activityHeartbeat = state.activityHeartbeat
        sessionUsage = state.usage
    }

    /// Clear per-session @Published properties
    private func clearSessionPublished() {
        messages = []
        streamingText = ""
        streamingThinking = ""
        sdkEvents = []
        latestSummary = nil
        suggestions = []
        pendingQuestion = nil
        pendingPermission = nil
        activityHeartbeat = nil
        sessionUsage = nil
    }

    private func ensureProjectState(_ projectId: String) {
        if projectStates[projectId] == nil {
            projectStates[projectId] = ProjectChatState()
        }
    }

    /// Mutate a specific session's state within a project. Creates if needed.
    private func modifySessionState(projectId: String, sessionId: String, _ block: (inout SessionChatState) -> Void) {
        ensureProjectState(projectId)
        if projectStates[projectId]!.sessionStates[sessionId] == nil {
            projectStates[projectId]!.sessionStates[sessionId] = SessionChatState()
        }
        block(&projectStates[projectId]!.sessionStates[sessionId]!)
    }

    // MARK: - Connection

    func connect() {
        Task { @MainActor in
            guard !self.connected else { return }
            guard let serverURLStr = UserDefaults.standard.string(forKey: "codecrab_server_url"),
                  let token = KeychainHelper.shared.getToken() else { return }
            self.reconnectAttempts = 0

            let wsURLStr = serverURLStr.replacingOccurrences(of: "http://", with: "ws://")
                                       .replacingOccurrences(of: "https://", with: "wss://")
            guard let url = URL(string: "\(wsURLStr)/ws?clientId=\(self.clientId)&token=\(token)") else { return }

            var request = URLRequest(url: url)
            request.timeoutInterval = 5

            self.webSocketTask = URLSession.shared.webSocketTask(with: request)
            self.webSocketTask?.resume()
            self.connected = true

            self.receiveLoop()

            if let projectId = self.activeProjectId {
                self.ensureProjectState(projectId)
                self.projectStates[projectId]!.awaitingSessionSwitch = true
                let cwd = self.cwd.isEmpty ? nil : self.cwd
                self.sendWebSocketMessage(["type": "switch_project", "projectId": projectId, "projectCwd": cwd as Any])
            }
        }
    }

    func disconnect() {
        Task { @MainActor in
            webSocketTask?.cancel(with: .goingAway, reason: nil)
            connected = false
            webSocketTask = nil
        }
    }

    private var reconnectAttempts = 0

    private func reconnect() {
        // Don't reconnect if token was cleared (logged out)
        guard KeychainHelper.shared.getToken() != nil else { return }

        let delay = min(2.0 * pow(2.0, Double(reconnectAttempts)), 30.0)
        reconnectAttempts += 1

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.connected else { return }
            self.connect()
        }
    }

    private func receiveLoop() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case .success(let message):
                    // Connection is healthy — reset backoff
                    self.reconnectAttempts = 0
                    switch message {
                    case .string(let text):
                        self.handleMessage(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleMessage(text)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveLoop()
                case .failure(let error):
                    self.connected = false
                    self.webSocketTask = nil

                    // -1011 = NSURLErrorBadServerResponse (401 during WS handshake)
                    let nsError = error as NSError
                    if nsError.code == -1011 {
                        print("[WebSocket] Auth rejected — stopping reconnect")
                        NotificationCenter.default.post(name: .apiUnauthorized, object: nil)
                        return
                    }

                    self.reconnect()
                }
            }
        }
    }

    // MARK: - Message Handler

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        let projectId = json["projectId"] as? String
        let isCurrentProject = projectId == activeProjectId
        let msgSessionId = json["sessionId"] as? String

        switch type {
        case "available_models":
            if let modelsData = try? JSONSerialization.data(withJSONObject: json["models"] ?? []),
               let models = try? JSONDecoder().decode([ModelInfo].self, from: modelsData) {
                self.availableModels = models
            }
        case "project_statuses":
            if let statusesData = try? JSONSerialization.data(withJSONObject: json["statuses"] ?? []),
               let statuses = try? JSONDecoder().decode([ProjectStatus].self, from: statusesData) {
                self.projectStatuses = statuses
                for status in statuses {
                    if status.status == "processing" {
                        if !recentlyEndedProjectIds.contains(status.projectId) {
                            runningProjectIds.insert(status.projectId)
                        }
                    } else {
                        runningProjectIds.remove(status.projectId)
                        recentlyEndedProjectIds.remove(status.projectId)
                    }
                }
                // End Live Activity if the active project is no longer running
                // (handles the case where query_end was missed during WS disconnection)
                if let pid = activeProjectId, !runningProjectIds.contains(pid) {
                    LiveActivityService.shared.endActivity()
                }
            }
        case "project_activity":
            if let pid = json["projectId"] as? String,
               let actType = json["activityType"] as? String {
                if actType == "idle" {
                    projectActivities.removeValue(forKey: pid)
                } else {
                    projectActivities[pid] = ProjectActivity(
                        activityType: actType,
                        toolName: json["toolName"] as? String,
                        textSnippet: json["textSnippet"] as? String
                    )
                }
            }
        case "query_start":
            cancelPromptConfirmationTimer()
            clearDraftCache()
            if let pid = projectId {
                runningProjectIds.insert(pid)
                recentlyEndedProjectIds.remove(pid)
            }
            if isCurrentProject, let pid = projectId {
                self.activityHeartbeat = nil
                LiveActivityService.shared.startActivity(
                    projectName: activeProjectName,
                    projectIcon: activeProjectIcon
                )
                // Set session status and clear streaming buffers
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: targetSid) {
                        $0.status = "processing"
                        $0.isStreaming = true
                        $0.streamingText = ""
                        $0.streamingThinking = ""
                        $0.pendingPermission = nil
                        $0.pendingQuestion = nil
                        $0.latestSummary = nil
                        $0.suggestions = []
                    }
                    if targetSid == sessionId {
                        self.latestSummary = nil
                        self.suggestions = []
                        self.pendingPermission = nil
                        self.pendingQuestion = nil
                    }
                }
            }
        case "query_end":
            if let pid = projectId {
                runningProjectIds.remove(pid)
                recentlyEndedProjectIds.insert(pid)
            }
            if isCurrentProject, let pid = projectId {
                self.isAborting = false
                self.activityHeartbeat = nil
                LiveActivityService.shared.endActivity()
                // Defensively remove the completed query from the queue.
                // query_queue_status(completed) should handle this, but query_end
                // serves as a backup to prevent stale queue items.
                if let queryId = json["queryId"] as? String, !queryId.isEmpty {
                    self.queryQueue.removeAll { $0.queryId == queryId }
                }
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty {
                    if targetSid == sessionId {
                        // Viewing session: flush remaining streaming to @Published messages + SdkEvents
                        if !self.streamingThinking.isEmpty {
                            let thinkEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "thinking", detail: nil, data: ["content": .string(self.streamingThinking)])
                            self.sdkEvents.append(thinkEvent)
                        }
                        if !self.streamingText.isEmpty {
                            let cleanText = self.cleanStreamingText(self.streamingText)
                            if !cleanText.isEmpty {
                                let textEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000 + 0.001, type: "text", detail: nil, data: ["content": .string(cleanText)])
                                self.sdkEvents.append(textEvent)
                            }
                        }
                        if !self.streamingText.isEmpty || !self.streamingThinking.isEmpty {
                            let cleanText = self.cleanStreamingText(self.streamingText)
                            let msg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, thinking: self.streamingThinking.isEmpty ? nil : self.streamingThinking, timestamp: Date().timeIntervalSince1970 * 1000)
                            self.messages.append(msg)
                        }
                        self.streamingText = ""
                        self.streamingThinking = ""
                    } else {
                        // Non-viewing session: flush in session state
                        modifySessionState(projectId: pid, sessionId: targetSid) { sState in
                            if !sState.streamingThinking.isEmpty {
                                let thinkEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "thinking", detail: nil, data: ["content": .string(sState.streamingThinking)])
                                sState.sdkEvents.append(thinkEvent)
                            }
                            if !sState.streamingText.isEmpty {
                                let cleanText = self.cleanStreamingText(sState.streamingText)
                                if !cleanText.isEmpty {
                                    let textEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000 + 0.001, type: "text", detail: nil, data: ["content": .string(cleanText)])
                                    sState.sdkEvents.append(textEvent)
                                }
                            }
                            if !sState.streamingText.isEmpty || !sState.streamingThinking.isEmpty {
                                let cleanText = self.cleanStreamingText(sState.streamingText)
                                let msg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, thinking: sState.streamingThinking.isEmpty ? nil : sState.streamingThinking, timestamp: Date().timeIntervalSince1970 * 1000)
                                sState.messages.append(msg)
                            }
                            sState.streamingText = ""
                            sState.streamingThinking = ""
                        }
                    }
                    // Register background tasks if any
                    if let hasBackground = json["hasBackgroundTasks"] as? Bool, hasBackground,
                       let taskIds = json["backgroundTaskIds"] as? [String] {
                        modifySessionState(projectId: pid, sessionId: targetSid) { sState in
                            for taskId in taskIds {
                                if sState.backgroundTasks[taskId] == nil {
                                    sState.backgroundTasks[taskId] = BackgroundTask(taskId: taskId, status: "started")
                                }
                            }
                        }
                    }
                    // Clear heartbeat in session state
                    modifySessionState(projectId: pid, sessionId: targetSid) { $0.activityHeartbeat = nil }
                }
            }
        case "stream_delta":
            guard let pid = projectId, isCurrentProject else { break }
            guard let deltaType = json["deltaType"] as? String, let textDelta = json["text"] as? String else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                if deltaType == "thinking" { self.streamingThinking += textDelta }
                else { self.streamingText += textDelta }
                // Clear tool detail when streaming resumes
                self.currentToolDetail = nil
                // Update Live Activity with streaming state
                let actType = deltaType == "thinking" ? "thinking" : "streaming"
                LiveActivityService.shared.updateActivity(state: CodeCrabActivityAttributes.ContentState(
                    activityType: actType,
                    toolName: nil,
                    contentSnippet: getLastLineSnippet(),
                    elapsedSeconds: Int((activityHeartbeat?.elapsedMs ?? 0) / 1000)
                ))
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if deltaType == "thinking" { $0.streamingThinking += textDelta }
                    else { $0.streamingText += textDelta }
                }
            }
        case "assistant_text":
            guard let pid = projectId, isCurrentProject, let textMsg = json["text"] as? String else { break }
            // Skip sub-agent text (has parentToolUseId)
            if let parent = json["parentToolUseId"], !(parent is NSNull) { break }
            let cleanText = self.cleanStreamingText(textMsg)
            guard !cleanText.isEmpty else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            let assistantMsg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, timestamp: Date().timeIntervalSince1970 * 1000)
            let textEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "text", detail: nil, data: ["content": .string(cleanText)])
            if targetSid == sessionId {
                self.messages.append(assistantMsg)
                self.streamingText = ""
                self.sdkEvents.append(textEvent)
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    $0.messages.append(assistantMsg)
                    $0.streamingText = ""
                    $0.sdkEvents.append(textEvent)
                }
            }
        case "thinking":
            // server-v2 sends "thinking", legacy sends "text"
            guard let pid = projectId, isCurrentProject,
                  let textMsg = (json["thinking"] as? String) ?? (json["text"] as? String) else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            let thinkEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "thinking", detail: nil, data: ["content": .string(textMsg)])
            if targetSid == sessionId {
                if let lastIdx = self.messages.lastIndex(where: { $0.role == "assistant" }) {
                    self.messages[lastIdx].thinking = (self.messages[lastIdx].thinking ?? "") + textMsg
                }
                self.streamingThinking = ""
                self.sdkEvents.append(thinkEvent)
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if let lastIdx = $0.messages.lastIndex(where: { $0.role == "assistant" }) {
                        $0.messages[lastIdx].thinking = ($0.messages[lastIdx].thinking ?? "") + textMsg
                    }
                    $0.streamingThinking = ""
                    $0.sdkEvents.append(thinkEvent)
                }
            }
        case "tool_use":
            guard let pid = projectId, isCurrentProject else { break }
            guard let toolName = json["toolName"] as? String,
                  let toolId = json["toolId"] as? String else { break }
            // Decode input as JSONValue
            var inputValue: JSONValue = .null
            if let inputObj = json["input"] {
                if let inputData = try? JSONSerialization.data(withJSONObject: inputObj) {
                    inputValue = (try? JSONDecoder().decode(JSONValue.self, from: inputData)) ?? .null
                }
            }
            let toolCall = ToolCall(name: toolName, id: toolId, input: inputValue)
            let toolCalls = [toolCall]
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            // Serialize input to JSON string for SdkEvent (MessageModeToolUseView expects a string)
            var inputStr = ""
            if let inputData = try? JSONEncoder().encode(inputValue),
               let str = String(data: inputData, encoding: .utf8) {
                inputStr = str
            }
            let toolEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "tool_use", detail: toolName, data: [
                "toolName": .string(toolName),
                "toolId": .string(toolId),
                "input": .string(inputStr),
            ])
            if targetSid == sessionId {
                if let lastIdx = self.messages.lastIndex(where: { $0.role == "system" }), self.messages[lastIdx].toolCalls != nil {
                    self.messages[lastIdx].toolCalls?.append(contentsOf: toolCalls)
                } else {
                    let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "", toolCalls: toolCalls, timestamp: Date().timeIntervalSince1970 * 1000)
                    self.messages.append(msg)
                }
                self.sdkEvents.append(toolEvent)
                // Update Live Activity with tool name and detail
                let toolDetail = Self.extractToolDetail(toolName: toolName, input: json["input"])
                self.currentToolDetail = toolDetail
                LiveActivityService.shared.updateActivity(state: CodeCrabActivityAttributes.ContentState(
                    activityType: "tool_use",
                    toolName: toolName,
                    contentSnippet: toolDetail,
                    elapsedSeconds: Int((activityHeartbeat?.elapsedMs ?? 0) / 1000)
                ))
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if let lastIdx = $0.messages.lastIndex(where: { $0.role == "system" }), $0.messages[lastIdx].toolCalls != nil {
                        $0.messages[lastIdx].toolCalls?.append(contentsOf: toolCalls)
                    } else {
                        let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "", toolCalls: toolCalls, timestamp: Date().timeIntervalSince1970 * 1000)
                        $0.messages.append(msg)
                    }
                    $0.sdkEvents.append(toolEvent)
                }
            }
        case "tool_result":
            guard let pid = projectId, isCurrentProject else { break }
            // server-v2 sends "content", legacy server sends "result"
            guard let toolId = json["toolId"] as? String,
                  let result = (json["content"] as? String) ?? (json["result"] as? String) else { break }
            let isError = json["isError"] as? Bool ?? false
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            let resultEvent = SdkEvent(ts: Date().timeIntervalSince1970 * 1000, type: "tool_result", detail: nil, data: [
                "content": .string(result),
                "isError": .bool(isError),
            ])
            if targetSid == sessionId {
                for i in 0..<self.messages.count {
                    if let tcs = self.messages[i].toolCalls, let tIdx = tcs.firstIndex(where: { $0.id == toolId }) {
                        self.messages[i].toolCalls?[tIdx].result = result
                        self.messages[i].toolCalls?[tIdx].isError = isError
                        break
                    }
                }
                self.sdkEvents.append(resultEvent)
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    for i in 0..<$0.messages.count {
                        if let tcs = $0.messages[i].toolCalls, let tIdx = tcs.firstIndex(where: { $0.id == toolId }) {
                            $0.messages[i].toolCalls?[tIdx].result = result
                            $0.messages[i].toolCalls?[tIdx].isError = isError
                            break
                        }
                    }
                    $0.sdkEvents.append(resultEvent)
                }
            }
        case "ask_user_question":
            guard let pid = projectId, isCurrentProject, let toolId = json["toolId"] as? String else { break }
            guard let questionsData = try? JSONSerialization.data(withJSONObject: json["questions"] ?? []),
                  let questions = try? JSONDecoder().decode([Question].self, from: questionsData) else { break }
            let pq = PendingQuestion(toolId: toolId, questions: questions)
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.pendingQuestion = pq
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.pendingQuestion = pq }
            }
        case "permission_request":
            if isCurrentProject, let reqData = try? JSONSerialization.data(withJSONObject: json) {
                if let req = try? JSONDecoder().decode(PendingPermission.self, from: reqData) {
                    self.pendingPermission = req
                    // Also track at session level
                    if let pid = projectId, let sid = msgSessionId, !sid.isEmpty {
                        modifySessionState(projectId: pid, sessionId: sid) { $0.pendingPermission = req }
                    }
                }
            }
        case "permission_resolved":
            if isCurrentProject {
                self.pendingPermission = nil
                // Also track at session level
                if let pid = projectId, let sid = msgSessionId, !sid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: sid) { $0.pendingPermission = nil }
                }
            }
        case "question_resolved":
            if isCurrentProject {
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty && targetSid == sessionId {
                    self.pendingQuestion = nil
                } else if let pid = projectId, !targetSid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: targetSid) { $0.pendingQuestion = nil }
                }
            }
        case "session_id_resolved":
            // Map tempSessionId → real sessionId from server-v2
            if isCurrentProject, let pid = projectId,
               let realSid = json["sessionId"] as? String,
               let tempSid = json["tempSessionId"] as? String {
                // If we're viewing the temp session, switch to the real ID
                if self.sessionId == tempSid {
                    self.sessionId = realSid
                    ensureProjectState(pid)
                    projectStates[pid]!.sessionId = realSid
                    // Move cached session state from temp ID to real ID
                    if let cached = projectStates[pid]?.sessionStates[tempSid] {
                        projectStates[pid]!.sessionStates[realSid] = cached
                        projectStates[pid]!.sessionStates.removeValue(forKey: tempSid)
                    }
                }
                pendingTempSessionId = nil
            }
        case "session_created":
            // Auto-update viewing session if current is temp/pending
            if isCurrentProject, let pid = projectId, let sid = json["sessionId"] as? String {
                let currentVid = self.sessionId
                if currentVid.isEmpty || currentVid.hasPrefix("temp-") || currentVid.hasPrefix("pending-") {
                    self.sessionId = sid
                    ensureProjectState(pid)
                    projectStates[pid]!.sessionId = sid
                    // Move cached session state from temp ID to real ID
                    if !currentVid.isEmpty, let cached = projectStates[pid]?.sessionStates[currentVid] {
                        projectStates[pid]!.sessionStates[sid] = cached
                        projectStates[pid]!.sessionStates.removeValue(forKey: currentVid)
                    }
                }
            }
        case "prompt_received":
            // Sync ack from server-v2 — prompt was accepted
            cancelPromptConfirmationTimer()
            clearDraftCache()
        case "session_resumed":
            // Only update viewing session if we're expecting it (user-initiated resume/switch).
            // The server also broadcasts session_resumed during background query execution,
            // which we must ignore to avoid hijacking the user's view.
            if isCurrentProject, let pid = projectId, let sid = json["sessionId"] as? String {
                if projectStates[pid]?.awaitingSessionSwitch == true {
                    self.sessionId = sid
                    projectStates[pid]!.sessionId = sid
                    projectStates[pid]!.awaitingSessionSwitch = false
                }
                // Update providerId from resumed session
                if let providerId = json["providerId"] as? String, !providerId.isEmpty {
                    self.currentProviderId = providerId
                    modifySessionState(projectId: pid, sessionId: sid) { $0.providerId = providerId }
                }
                // Fetch session history via HTTP (server no longer sends it over WS)
                fetchSessionHistory(sessionId: sid)
            }
        case "message_history":
            guard let pid = projectId, isCurrentProject else { break }
            guard let messagesJson = json["messages"] as? [[String: Any]] else { break }
            let loadedMessages = parseMessageHistory(messagesJson)
            let synthesizedEvents = chatMessagesToSdkEvents(loadedMessages)
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.messages = loadedMessages
                self.sdkEvents = synthesizedEvents
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    $0.messages = loadedMessages
                    $0.sdkEvents = synthesizedEvents
                }
            }
        case "user_message":
            guard let pid = projectId, isCurrentProject else { break }
            guard let msgData = try? JSONSerialization.data(withJSONObject: json["message"] ?? []),
                  let msg = try? JSONDecoder().decode(ChatMessage.self, from: msgData) else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.messages.append(msg)
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages.append(msg) }
            }
        case "provider_changed":
            if isCurrentProject, let providerId = json["providerId"] as? String {
                self.currentProviderId = providerId
                // Provider change creates a new session on server-v2
                if let sid = json["sessionId"] as? String, !sid.isEmpty {
                    saveCurrentSessionToState()
                    self.sessionId = sid
                    if let pid = projectId {
                        ensureProjectState(pid)
                        projectStates[pid]!.sessionId = sid
                        // Track providerId at session level
                        modifySessionState(projectId: pid, sessionId: sid) { $0.providerId = providerId }
                    }
                    clearSessionPublished()
                }
            }
        // Legacy compat: still handle model_changed from older servers
        case "model_changed":
            if isCurrentProject, let _ = json["model"] as? String {
                // No-op on v2; provider_changed handles this
            }
        case "permission_mode_changed":
            if isCurrentProject, let mode = json["mode"] as? String {
                self.permissionMode = mode
                // Also track at session level
                if let pid = projectId, let sid = msgSessionId, !sid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: sid) {
                        $0.permissionMode = mode
                    }
                }
            }
        case "cwd_changed":
            if isCurrentProject, let dir = json["cwd"] as? String {
                self.cwd = dir
            }
        case "error":
            cancelPromptConfirmationTimer()
            guard let pid = projectId, isCurrentProject else { break }
            if let errMsg = json["message"] as? String ?? json["error"] as? String {
                let errorChatMsg = ChatMessage(id: UUID().uuidString, role: "system", content: "Error: \(errMsg)", timestamp: Date().timeIntervalSince1970 * 1000)
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty && targetSid == sessionId {
                    self.messages.append(errorChatMsg)
                } else if !targetSid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages.append(errorChatMsg) }
                }
                // Update session status
                if !targetSid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: targetSid) {
                        $0.isStreaming = false
                        $0.status = "idle"
                    }
                }
            }
            runningProjectIds.remove(pid)
            self.isAborting = false
            LiveActivityService.shared.endActivity()
        case "cleared":
            if isCurrentProject {
                clearSessionPublished()
                self.sessionId = ""
                self.pendingPermission = nil
                self.sessionUsage = nil
                if let pid = projectId {
                    runningProjectIds.remove(pid)
                    // After /clear, server sends a new system init with the new session ID.
                    // Re-enable awaitingSessionSwitch so we pick it up.
                    ensureProjectState(pid)
                    projectStates[pid]!.sessionId = ""
                    projectStates[pid]!.awaitingSessionSwitch = true
                    projectStates[pid]!.sessionUsage = nil
                }
                self.isAborting = false
            }
        case "aborted":
            if isCurrentProject {
                if let pid = projectId { runningProjectIds.remove(pid) }
                self.isAborting = false
                LiveActivityService.shared.endActivity()
            }
        case "result":
            guard let pid = projectId, isCurrentProject else { break }
            let content = json["result"] as? String ?? ""
            let cost = json["costUsd"] as? Double
            let duration = json["durationMs"] as? Double
            let resultMsg = ChatMessage(id: UUID().uuidString, role: "system", content: content, costUsd: cost, durationMs: duration, timestamp: Date().timeIntervalSince1970 * 1000)
            let targetSid = msgSessionId ?? sessionId
            if !targetSid.isEmpty && targetSid == sessionId {
                self.messages.append(resultMsg)
                self.streamingText = ""
                self.streamingThinking = ""
            } else if !targetSid.isEmpty {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages.append(resultMsg) }
            }
            // Update session streaming state
            if !targetSid.isEmpty {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    $0.isStreaming = false
                    $0.streamingText = ""
                    $0.streamingThinking = ""
                }
            }
        case "query_summary":
            guard let pid = projectId, isCurrentProject, let summary = json["summary"] as? String else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.latestSummary = summary
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.latestSummary = summary }
            }
        case "query_suggestions":
            guard let pid = projectId, isCurrentProject, let items = json["suggestions"] as? [String] else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.suggestions = items
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.suggestions = items }
            }
        case "sdk_probe_result":
            if isCurrentProject {
                if let tools = json["tools"] as? [String] { self.sdkTools = tools }
                if let skillsJson = json["sdkSkills"] as? [[String: Any]] {
                    self.sdkSkills = skillsJson.compactMap { s in
                        guard let name = s["name"] as? String else { return nil }
                        let description = s["description"] as? String ?? ""
                        return SdkSkill(name: name, description: description)
                    }
                }
                if let serversJson = json["sdkMcpServers"] as? [[String: Any]] {
                    self.sdkMcpServers = serversJson.compactMap { s in
                        guard let name = s["name"] as? String,
                              let status = s["status"] as? String else { return nil }
                        return SdkMcpServer(name: name, status: status)
                    }
                }
            }
        // Legacy compat: still handle system init from older servers
        case "system":
            if isCurrentProject, let pid = projectId, let subtype = json["subtype"] as? String, subtype == "init" {
                if let sid = json["sessionId"] as? String, projectStates[pid]?.awaitingSessionSwitch == true {
                    self.sessionId = sid
                    projectStates[pid]!.sessionId = sid
                    projectStates[pid]!.awaitingSessionSwitch = false
                    fetchSessionHistory(sessionId: sid)
                }
                if let tools = json["tools"] as? [String] { self.sdkTools = tools }
            }
        case "activity_heartbeat":
            if isCurrentProject {
                let elapsedMs = json["elapsedMs"] as? Double ?? 0
                let lastActivityType = json["lastActivityType"] as? String ?? "working"
                let lastToolName = json["lastToolName"] as? String
                let paused = json["paused"] as? Bool ?? false
                let serverSnippet = json["textSnippet"] as? String
                let heartbeat = ActivityHeartbeat(
                    elapsedMs: elapsedMs,
                    lastActivityType: lastActivityType,
                    lastToolName: lastToolName,
                    paused: paused
                )
                self.activityHeartbeat = heartbeat
                // Also track at session level
                if let pid = projectId, let sid = msgSessionId, !sid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: sid) { $0.activityHeartbeat = heartbeat }
                }
                // Update Live Activity from heartbeat
                let actType: String
                if paused {
                    actType = "paused"
                } else {
                    switch lastActivityType {
                    case "thinking_delta": actType = "thinking"
                    case "text_delta": actType = "streaming"
                    case "tool_use": actType = "tool_use"
                    default: actType = "working"
                    }
                }
                // For tool_use: preserve the cached tool detail; for streaming: use local snippet
                let snippet: String?
                if actType == "tool_use" {
                    snippet = currentToolDetail
                } else {
                    currentToolDetail = nil
                    snippet = getLastLineSnippet() ?? serverSnippet.flatMap { s in
                        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
                        return trimmed.isEmpty ? nil : (trimmed.count > 60 ? String(trimmed.suffix(57)) + "..." : trimmed)
                    }
                }
                LiveActivityService.shared.updateActivity(state: CodeCrabActivityAttributes.ContentState(
                    activityType: actType,
                    toolName: lastToolName,
                    contentSnippet: snippet,
                    elapsedSeconds: Int(elapsedMs / 1000)
                ))
            }
        case "session_usage":
            if isCurrentProject, let pid = projectId {
                let usage = SessionUsage(
                    totalInputTokens: json["totalInputTokens"] as? Int ?? 0,
                    totalOutputTokens: json["totalOutputTokens"] as? Int ?? 0,
                    totalCacheReadTokens: json["totalCacheReadTokens"] as? Int ?? 0,
                    totalCacheCreateTokens: json["totalCacheCreateTokens"] as? Int ?? 0,
                    totalCostUsd: json["totalCostUsd"] as? Double ?? 0,
                    totalDurationMs: json["totalDurationMs"] as? Double ?? 0,
                    queryCount: json["queryCount"] as? Int ?? 0,
                    contextWindowUsed: json["contextWindowUsed"] as? Int ?? 0,
                    contextWindowMax: json["contextWindowMax"] as? Int ?? 0
                )
                self.sessionUsage = usage
                ensureProjectState(pid)
                projectStates[pid]!.sessionUsage = usage
                // Also track at session level
                if let sid = msgSessionId, !sid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: sid) { $0.usage = usage }
                }
            }
        case "cron_task_completed":
            guard isCurrentProject else { break }
            let cronJobId = json["cronJobId"] as? String ?? "unknown"
            let cronJobName = json["cronJobName"] as? String
            let execSid = json["execSessionId"] as? String ?? ""
            let success = json["success"] as? Bool ?? false
            let label = cronJobName ?? cronJobId
            let event = SdkEvent(
                ts: Date().timeIntervalSince1970 * 1000,
                type: "cron_task_completed",
                detail: "\(success ? "Completed" : "Failed"): \(label)",
                data: [
                    "cronJobId": .string(cronJobId),
                    "cronJobName": .string(cronJobName ?? ""),
                    "execSessionId": .string(execSid),
                    "success": .bool(success),
                ]
            )
            // Add to viewing session's events (cron completion is a project-level notification)
            self.sdkEvents.append(event)
        case "sdk_event":
            guard let pid = projectId, isCurrentProject, let eventDict = json["event"] as? [String: Any] else { break }
            guard let event = parseSdkEvent(eventDict) else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.sdkEvents.append(event)
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.sdkEvents.append(event) }
            }
        case "sdk_event_history":
            guard let pid = projectId, isCurrentProject, let eventsArray = json["events"] as? [[String: Any]] else { break }
            let events = eventsArray.compactMap { parseSdkEvent($0) }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.sdkEvents = events
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.sdkEvents = events }
            }
        case "query_queue_status":
            if isCurrentProject {
                let queryId = json["queryId"] as? String ?? ""
                let status = json["status"] as? String ?? ""
                let terminalStatuses = ["completed", "failed", "timeout", "cancelled"]
                if terminalStatuses.contains(status) {
                    self.queryQueue.removeAll { $0.queryId == queryId }
                } else {
                    if let idx = self.queryQueue.firstIndex(where: { $0.queryId == queryId }) {
                        self.queryQueue[idx].status = status
                        if let pos = json["position"] as? Int { self.queryQueue[idx].position = pos }
                        if let prompt = json["prompt"] as? String { self.queryQueue[idx].prompt = prompt }
                    } else if let prompt = json["prompt"] as? String {
                        let item = QueueItem(
                            queryId: queryId,
                            status: status,
                            position: (json["position"] as? Int) ?? 0,
                            prompt: prompt,
                            queryType: (json["queryType"] as? String) ?? "user",
                            sessionId: json["sessionId"] as? String,
                            cronJobName: json["cronJobName"] as? String
                        )
                        self.queryQueue.append(item)
                    }
                    self.queryQueue.sort { $0.position < $1.position }
                }
            }
        case "query_queue_snapshot":
            if isCurrentProject, let items = json["items"] as? [[String: Any]] {
                self.queryQueue = items.map { item in
                    QueueItem(
                        queryId: item["queryId"] as? String ?? "",
                        status: item["status"] as? String ?? "queued",
                        position: item["position"] as? Int ?? 0,
                        prompt: item["prompt"] as? String ?? "",
                        queryType: (item["queryType"] as? String) ?? "user",
                        sessionId: item["sessionId"] as? String,
                        cronJobName: item["cronJobName"] as? String
                    )
                }
            }
        case "session_status_changed":
            guard let pid = projectId, let sid = msgSessionId else { break }
            let newStatus = json["status"] as? String ?? "idle"
            modifySessionState(projectId: pid, sessionId: sid) { $0.status = newStatus }
            if isCurrentProject && sid == sessionId {
                // No direct @Published for session status — tracked in session state
            }
        case "background_task_update":
            guard let pid = projectId, let sid = msgSessionId else { break }
            guard let taskId = json["taskId"] as? String else { break }
            let taskStatus = json["status"] as? String ?? "started"
            var taskUsage: BackgroundTaskUsage? = nil
            if let usageDict = json["usage"] as? [String: Any] {
                taskUsage = BackgroundTaskUsage(
                    totalTokens: usageDict["totalTokens"] as? Int,
                    toolUses: usageDict["toolUses"] as? Int,
                    durationMs: usageDict["durationMs"] as? Double
                )
            }
            modifySessionState(projectId: pid, sessionId: sid) {
                $0.backgroundTasks[taskId] = BackgroundTask(
                    taskId: taskId,
                    status: taskStatus,
                    description: json["description"] as? String,
                    summary: json["summary"] as? String,
                    usage: taskUsage
                )
            }

        // MARK: - Thread Messages (Inter-Agent Communication)

        case "thread_created":
            guard let dataDict = json["data"] as? [String: Any],
                  let threadId = dataDict["id"] as? String,
                  let title = dataDict["title"] as? String,
                  let status = dataDict["status"] as? String,
                  let createdAt = dataDict["createdAt"] as? Double else { break }
            let parentThreadId = dataDict["parentThreadId"] as? String
            let participants = parseParticipants(dataDict["participants"])
            let thread = ThreadInfo(
                id: threadId, title: title, status: status,
                parentThreadId: parentThreadId, participants: participants,
                createdAt: createdAt, updatedAt: createdAt
            )
            self.threads[threadId] = thread

        case "thread_updated":
            guard let dataDict = json["data"] as? [String: Any],
                  let threadId = dataDict["id"] as? String else { break }
            if var existing = self.threads[threadId] {
                if let title = dataDict["title"] as? String { existing.title = title }
                if let status = dataDict["status"] as? String { existing.status = status }
                if let updatedAt = dataDict["updatedAt"] as? Double { existing.updatedAt = updatedAt }
                existing.participants = parseParticipants(dataDict["participants"])
                self.threads[threadId] = existing
            } else {
                // Thread not yet in local state — create a stub
                let title = dataDict["title"] as? String ?? "Thread"
                let status = dataDict["status"] as? String ?? "active"
                let updatedAt = dataDict["updatedAt"] as? Double ?? Date().timeIntervalSince1970 * 1000
                let participants = parseParticipants(dataDict["participants"])
                self.threads[threadId] = ThreadInfo(
                    id: threadId, title: title, status: status,
                    parentThreadId: nil, participants: participants,
                    createdAt: updatedAt, updatedAt: updatedAt
                )
            }

        case "thread_completed":
            guard let dataDict = json["data"] as? [String: Any],
                  let threadId = dataDict["id"] as? String else { break }
            self.threads[threadId]?.status = "completed"

        case "thread_stalled":
            guard let dataDict = json["data"] as? [String: Any],
                  let threadId = dataDict["id"] as? String else { break }
            self.threads[threadId]?.status = "stalled"
            self.threads[threadId]?.stalledReason = dataDict["reason"] as? String

        case "agent_message":
            guard let dataDict = json["data"] as? [String: Any],
                  let threadId = dataDict["threadId"] as? String,
                  let msgDict = dataDict["message"] as? [String: Any],
                  let msgId = msgDict["id"] as? String,
                  let from = msgDict["from"] as? String,
                  let to = msgDict["to"] as? String,
                  let content = msgDict["content"] as? String,
                  let timestamp = msgDict["timestamp"] as? Double else { break }
            var artifacts: [ThreadArtifactRef] = []
            if let artsArray = msgDict["artifacts"] as? [[String: Any]] {
                for artDict in artsArray {
                    if let aId = artDict["id"] as? String,
                       let aName = artDict["name"] as? String,
                       let aPath = artDict["path"] as? String {
                        artifacts.append(ThreadArtifactRef(id: aId, name: aName, path: aPath))
                    }
                }
            }
            let threadMsg = ThreadMessageInfo(id: msgId, from: from, to: to, content: content, artifacts: artifacts, timestamp: timestamp)
            if self.threads[threadId] != nil {
                self.threads[threadId]!.messages.append(threadMsg)
                self.threads[threadId]!.updatedAt = timestamp
            }

        case "agent_auto_resume":
            guard let dataDict = json["data"] as? [String: Any],
                  let agentId = dataDict["agentId"] as? String,
                  let agentName = dataDict["agentName"] as? String,
                  let threadId = dataDict["threadId"] as? String,
                  let threadTitle = dataDict["threadTitle"] as? String,
                  let triggeredByDict = dataDict["triggeredBy"] as? [String: Any],
                  let trigAgentId = triggeredByDict["agentId"] as? String,
                  let trigAgentName = triggeredByDict["agentName"] as? String else { break }
            let banner = AutoResumeBanner(
                id: UUID().uuidString,
                agentId: agentId, agentName: agentName,
                threadId: threadId, threadTitle: threadTitle,
                triggeredBy: ThreadParticipant(agentId: trigAgentId, agentName: trigAgentName),
                timestamp: Date().timeIntervalSince1970 * 1000
            )
            self.autoResumeBanners.append(banner)
            // Auto-dismiss after 8 seconds
            let bannerId = banner.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                self?.autoResumeBanners.removeAll { $0.id == bannerId }
            }

        default:
            break
        }
    }

    // MARK: - Thread Helpers

    private func parseParticipants(_ raw: Any?) -> [ThreadParticipant] {
        guard let array = raw as? [[String: Any]] else { return [] }
        return array.compactMap { dict in
            guard let agentId = dict["agentId"] as? String,
                  let agentName = dict["agentName"] as? String else { return nil }
            return ThreadParticipant(agentId: agentId, agentName: agentName)
        }
    }

    func dismissAutoResumeBanner(_ id: String) {
        autoResumeBanners.removeAll { $0.id == id }
    }

    func upsertThread(_ thread: ThreadInfo) {
        threads[thread.id] = thread
    }

    /// Sorted threads for display (most recently updated first)
    var sortedThreads: [ThreadInfo] {
        Array(threads.values).sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Message Parsing Helpers

    private func parseMessageHistory(_ messagesJson: [[String: Any]]) -> [ChatMessage] {
        var loadedMessages: [ChatMessage] = []
        for msgDict in messagesJson {
            guard let id = msgDict["id"] as? String,
                  let role = msgDict["role"] as? String,
                  let content = msgDict["content"] as? String,
                  let timestamp = msgDict["timestamp"] as? Double else { continue }

            let costUsd = msgDict["costUsd"] as? Double
            let durationMs = msgDict["durationMs"] as? Double

            var toolCalls: [ToolCall]? = nil
            if let tcArray = msgDict["toolCalls"] as? [[String: Any]] {
                toolCalls = tcArray.compactMap { tc in
                    guard let name = tc["name"] as? String,
                          let tcId = tc["id"] as? String else { return nil }
                    let result = (tc["result"] as? String) ?? (tc["resultPreview"] as? String)
                    let isError = tc["isError"] as? Bool
                    let input: JSONValue
                    if let inputObj = tc["input"] {
                        input = parseJSONValue(inputObj)
                    } else {
                        let inputSummary = tc["inputSummary"] as? String ?? ""
                        input = .string(inputSummary)
                    }
                    return ToolCall(name: name, id: tcId, input: input, result: result, isError: isError)
                }
            }

            // Strip inline metadata tags from assistant messages (defensive cleanup)
            let cleanContent = (role == "assistant") ? cleanStreamingText(content) : content

            // Parse image refs from summary (URL-based, no base64)
            var images: [ImageAttachment]? = nil
            if let imagesArray = msgDict["images"] as? [[String: Any]], !imagesArray.isEmpty {
                images = imagesArray.compactMap { imgDict in
                    guard let mediaType = imgDict["mediaType"] as? String else { return nil }
                    let url = imgDict["url"] as? String
                    let name = imgDict["name"] as? String
                    return ImageAttachment(data: "", mediaType: mediaType, name: name, url: url)
                }
                if images?.isEmpty == true { images = nil }
            }

            let msg = ChatMessage(
                id: id,
                role: role,
                content: cleanContent,
                images: images,
                toolCalls: toolCalls,
                costUsd: costUsd,
                durationMs: durationMs,
                timestamp: timestamp
            )
            loadedMessages.append(msg)
        }
        return loadedMessages
    }

    /// Parse Any JSON value to JSONValue enum
    private func parseJSONValue(_ value: Any) -> JSONValue {
        if let str = value as? String {
            return .string(str)
        } else if let num = value as? Double {
            return .number(num)
        } else if let num = value as? Int {
            return .number(Double(num))
        } else if let bool = value as? Bool {
            return .bool(bool)
        } else if let dict = value as? [String: Any] {
            var result: [String: JSONValue] = [:]
            for (k, v) in dict {
                result[k] = parseJSONValue(v)
            }
            return .object(result)
        } else if let arr = value as? [Any] {
            return .array(arr.map { parseJSONValue($0) })
        } else if value is NSNull {
            return .null
        }
        return .null
    }

    /// Fetch session history via HTTP.
    /// Server-v2 returns {sessionId, messages: ChatMessage[]}
    private func fetchSessionHistory(sessionId sid: String) {
        Task { @MainActor in
            do {
                guard let serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url") else { return }

                let urlStr = "\(serverURL)/api/sessions/\(sid)/history"
                guard let url = URL(string: urlStr) else { return }

                var request = URLRequest(url: url)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                if let token = KeychainHelper.shared.getToken() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResp = response as? HTTPURLResponse, (200...299).contains(httpResp.statusCode) else { return }
                guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

                if let messagesJson = json["messages"] as? [[String: Any]], !messagesJson.isEmpty {
                    let newMessages = parseMessageHistory(messagesJson)
                    let synthesizedEvents = self.chatMessagesToSdkEvents(newMessages)
                    if sid == self.sessionId {
                        self.messages = newMessages
                        self.sdkEvents = synthesizedEvents
                    } else if let pid = self.activeProjectId {
                        modifySessionState(projectId: pid, sessionId: sid) {
                            $0.messages = newMessages
                            $0.sdkEvents = synthesizedEvents
                        }
                    }
                }
            } catch {
                print("[ws] Failed to fetch session history: \(error)")
            }
        }
    }

    /// Convert ChatMessage history into SdkEvent array for rendering.
    /// The MessageListView renders agent responses via SdkEvents, so we synthesize
    /// them from assistant/system ChatMessages when loading session history.
    func chatMessagesToSdkEvents(_ messages: [ChatMessage]) -> [SdkEvent] {
        var events: [SdkEvent] = []
        var offset = 0.001  // sub-ms offset to preserve ordering within a message

        for msg in messages {
            guard msg.role == "assistant" || msg.role == "system" else { continue }
            let baseTs = msg.timestamp

            // Thinking block
            if let thinking = msg.thinking, !thinking.isEmpty {
                events.append(SdkEvent(
                    ts: baseTs,
                    type: "thinking",
                    detail: nil,
                    data: ["content": .string(thinking)]
                ))
            }

            // Text content
            if !msg.content.isEmpty {
                events.append(SdkEvent(
                    ts: baseTs + offset,
                    type: "text",
                    detail: nil,
                    data: ["content": .string(msg.content)]
                ))
                offset += 0.001
            }

            // Tool calls
            if let toolCalls = msg.toolCalls {
                for tc in toolCalls {
                    // Serialize tool input to JSON string (MessageModeToolUseView expects a string)
                    var inputStr = ""
                    if let data = try? JSONEncoder().encode(tc.input),
                       let str = String(data: data, encoding: .utf8) {
                        inputStr = str
                    }

                    events.append(SdkEvent(
                        ts: baseTs + offset,
                        type: "tool_use",
                        detail: tc.name,
                        data: [
                            "toolName": .string(tc.name),
                            "toolId": .string(tc.id),
                            "input": .string(inputStr),
                        ]
                    ))
                    offset += 0.001

                    // Tool result (if available)
                    if let result = tc.result {
                        events.append(SdkEvent(
                            ts: baseTs + offset,
                            type: "tool_result",
                            detail: nil,
                            data: [
                                "content": .string(result),
                                "isError": .bool(tc.isError ?? false),
                            ]
                        ))
                        offset += 0.001
                    }
                }
            }
        }

        return events
    }

    /// Parse a single SDK event dictionary into an SdkEvent
    private func parseSdkEvent(_ eventDict: [String: Any]) -> SdkEvent? {
        let ts = eventDict["ts"] as? Double ?? 0
        let eventType = eventDict["type"] as? String ?? "unknown"
        let detail = eventDict["detail"] as? String
        var eventData: [String: JSONValue]? = nil
        if let dataDict = eventDict["data"] as? [String: Any] {
            var parsed: [String: JSONValue] = [:]
            for (k, v) in dataDict {
                parsed[k] = parseJSONValue(v)
            }
            eventData = parsed
        }
        return SdkEvent(ts: ts, type: eventType, detail: detail, data: eventData)
    }

    /// Strip [SUMMARY: ...] / [SUGGESTIONS: ...] tags from streaming text.
    /// Handles complete tags anywhere in the text, and partial (still-streaming) tags at the end.
    private func getDisplayStreamingText(_ text: String) -> String {
        if text.isEmpty { return text }

        // First strip any complete tags anywhere in the text
        let result = text
            .replacingOccurrences(of: "\\n?\\[SUMMARY:[\\s\\S]*?\\]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\n?\\[SUGGESTIONS:[\\s\\S]*?\\]", with: "", options: .regularExpression)

        // Then handle incomplete (still-streaming) tags at the end
        let hiddenPrefixes = ["\n[SUMMARY:", "\n[SUGGESTIONS:"]

        for prefix in hiddenPrefixes {
            if let range = result.range(of: prefix, options: .backwards) {
                return String(result[..<range.lowerBound])
            }
        }

        // Handle partial prefix at the very end (e.g. "\n[SUM")
        for prefix in hiddenPrefixes {
            for len in (2..<prefix.count).reversed() {
                let partial = String(prefix.prefix(len))
                if result.hasSuffix(partial) {
                    return String(result.prefix(result.count - len))
                }
            }
        }

        return result
    }

    private func cleanStreamingText(_ text: String) -> String {
        return text
            .replacingOccurrences(of: "\\n?\\[SUGGESTIONS:[\\s\\S]*?\\]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\n?\\[SUMMARY:[\\s\\S]*?\\]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Extract a human-readable detail from a tool's input for Live Activity display.
    static func extractToolDetail(toolName: String, input: Any?) -> String? {
        guard let inputDict = input as? [String: Any] else { return nil }
        switch toolName {
        case "Read", "Edit", "Write":
            if let filePath = inputDict["file_path"] as? String {
                // Show last 2 path components
                let components = filePath.components(separatedBy: "/").filter { !$0.isEmpty }
                let tail = components.suffix(2).joined(separator: "/")
                return tail.count > 60 ? String(tail.suffix(57)) + "..." : tail
            }
        case "Bash":
            if let desc = inputDict["description"] as? String, !desc.isEmpty {
                return desc.count > 60 ? String(desc.prefix(57)) + "..." : desc
            }
            if let cmd = inputDict["command"] as? String, !cmd.isEmpty {
                let firstLine = cmd.components(separatedBy: .newlines).first ?? cmd
                return firstLine.count > 60 ? String(firstLine.prefix(57)) + "..." : firstLine
            }
        case "Glob":
            if let pattern = inputDict["pattern"] as? String {
                return pattern.count > 60 ? String(pattern.prefix(57)) + "..." : pattern
            }
        case "Grep":
            if let pattern = inputDict["pattern"] as? String {
                return pattern.count > 60 ? String(pattern.prefix(57)) + "..." : pattern
            }
        case "Agent":
            if let desc = inputDict["description"] as? String, !desc.isEmpty {
                return desc.count > 60 ? String(desc.prefix(57)) + "..." : desc
            }
        default:
            break
        }
        return nil
    }

    private func getLastLineSnippet() -> String? {
        let text = streamingText.isEmpty ? streamingThinking : streamingText
        guard !text.isEmpty else { return nil }
        let lastLine = text.components(separatedBy: .newlines)
            .last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? ""
        let trimmed = lastLine.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        return trimmed.count > 60 ? String(trimmed.prefix(57)) + "..." : trimmed
    }

    @discardableResult
    private func sendWebSocketMessage(_ dict: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let jsonString = String(data: data, encoding: .utf8) else { return false }
        guard let task = webSocketTask else { return false }
        task.send(.string(jsonString)) { _ in }
        return true
    }

    // MARK: - Actions

    @discardableResult
    func sendPrompt(_ text: String, images: [ImageAttachment]? = nil, enabledMcps: [String]? = nil, disabledSdkServers: [String]? = nil, disabledSkills: [String]? = nil, providerId: String? = nil) -> Bool {
        guard let projectId = activeProjectId else { return false }

        var payload: [String: Any] = [
            "type": "prompt",
            "prompt": text,
            "projectId": projectId
        ]

        // If no sessionId yet, generate a tempSessionId for new session creation (server-v2)
        if sessionId.isEmpty {
            let tempId = "temp-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 1000...9999))"
            payload["tempSessionId"] = tempId
            pendingTempSessionId = tempId
            // Set the temp ID as our viewing session immediately
            self.sessionId = tempId
            ensureProjectState(projectId)
            projectStates[projectId]!.sessionId = tempId
            // Include providerId for new session creation
            if let providerId = providerId, !providerId.isEmpty {
                payload["providerId"] = providerId
            }
        } else {
            payload["sessionId"] = sessionId
        }
        if let images = images, !images.isEmpty, let imgData = try? JSONEncoder().encode(images), let imgJson = try? JSONSerialization.jsonObject(with: imgData) {
            payload["images"] = imgJson
        }
        if let mcps = enabledMcps {
            payload["enabledMcps"] = mcps
        }
        if let disabled = disabledSdkServers, !disabled.isEmpty {
            payload["disabledSdkServers"] = disabled
        }
        if let disabled = disabledSkills, !disabled.isEmpty {
            payload["disabledSkills"] = disabled
        }
        if !SoulSettings.shared.isEnabled {
            payload["soulEnabled"] = false
        }
        let sent = sendWebSocketMessage(payload)
        if sent {
            startPromptConfirmationTimer(text: text, images: images)
        }
        return sent
    }

    @discardableResult
    func sendCommand(_ command: String) -> Bool {
        guard let projectId = activeProjectId else { return false }
        return sendWebSocketMessage([
            "type": "command",
            "command": command,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func abort(queryId: String? = nil) {
        guard let projectId = activeProjectId else { return }
        isAborting = true

        var payload: [String: Any] = [
            "type": "abort",
            "projectId": projectId,
            "sessionId": sessionId
        ]
        if let qid = queryId {
            payload["queryId"] = qid
        }

        if !connected {
            // WS is disconnected — reconnect first, then send abort after connection establishes
            connect()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self, self.connected else {
                    self?.isAborting = false
                    return
                }
                self.sendWebSocketMessage(payload)
            }
            return
        }
        sendWebSocketMessage(payload)
    }

    // MARK: - Prompt Confirmation Timeout

    private func startPromptConfirmationTimer(text: String, images: [ImageAttachment]?) {
        // Cancel any previous timer
        promptConfirmationTimer?.cancel()
        pendingPromptText = text
        pendingPromptImages = images

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingPromptText = nil
            self.pendingPromptImages = nil
            self.promptConfirmationTimer = nil
            // Server did not confirm — show toast and cache draft
            self.toastMessage = "后端服务可能存在异常，请稍候重试"
            self.saveDraftToCache(text: text, images: images)
            // Auto-dismiss toast after 4 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                if self?.toastMessage == "后端服务可能存在异常，请稍候重试" {
                    self?.toastMessage = nil
                }
            }
        }
        promptConfirmationTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0, execute: work)
    }

    private func cancelPromptConfirmationTimer() {
        promptConfirmationTimer?.cancel()
        promptConfirmationTimer = nil
        pendingPromptText = nil
        pendingPromptImages = nil
    }

    // MARK: - Draft Cache

    private static let draftKey = "codecrab_pending_draft"

    private func saveDraftToCache(text: String, images: [ImageAttachment]?) {
        var draft: [String: Any] = [
            "text": text,
            "projectId": activeProjectId ?? "",
            "sessionId": sessionId,
            "timestamp": Date().timeIntervalSince1970
        ]
        // Cache current session messages for offline viewing
        if !messages.isEmpty,
           let msgData = try? JSONEncoder().encode(messages),
           let msgJson = try? JSONSerialization.jsonObject(with: msgData) {
            draft["messages"] = msgJson
        }
        if let images = images, !images.isEmpty,
           let imgData = try? JSONEncoder().encode(images),
           let imgJson = try? JSONSerialization.jsonObject(with: imgData) {
            draft["images"] = imgJson
        }
        if let data = try? JSONSerialization.data(withJSONObject: draft) {
            UserDefaults.standard.set(data, forKey: Self.draftKey)
        }
    }

    struct CachedDraft {
        let text: String
        let images: [ImageAttachment]
        let projectId: String
        let sessionId: String
        let messages: [ChatMessage]
    }

    func loadDraftFromCache(forProjectId projectId: String) -> CachedDraft? {
        guard let data = UserDefaults.standard.data(forKey: Self.draftKey),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["text"] as? String,
              let draftProjectId = json["projectId"] as? String,
              draftProjectId == projectId else { return nil }

        let sid = json["sessionId"] as? String ?? ""

        var images: [ImageAttachment] = []
        if let imgJson = json["images"],
           let imgData = try? JSONSerialization.data(withJSONObject: imgJson),
           let decoded = try? JSONDecoder().decode([ImageAttachment].self, from: imgData) {
            images = decoded
        }

        var msgs: [ChatMessage] = []
        if let msgsJson = json["messages"],
           let msgsData = try? JSONSerialization.data(withJSONObject: msgsJson),
           let decoded = try? JSONDecoder().decode([ChatMessage].self, from: msgsData) {
            msgs = decoded
        }

        return CachedDraft(text: text, images: images, projectId: draftProjectId, sessionId: sid, messages: msgs)
    }

    func clearDraftCache() {
        UserDefaults.standard.removeObject(forKey: Self.draftKey)
    }

    func resumeSession(_ newSessionId: String) {
        guard let projectId = activeProjectId else { return }
        // Save current viewing session's data
        saveCurrentSessionToState()
        // Cancel any pending switch_project session assignment
        ensureProjectState(projectId)
        projectStates[projectId]!.awaitingSessionSwitch = false
        // Switch viewing session
        self.sessionId = newSessionId
        projectStates[projectId]!.sessionId = newSessionId
        // Load cached state for instant rendering; HTTP fetch will merge incremental data
        if let cached = projectStates[projectId]?.sessionStates[newSessionId] {
            loadSessionState(cached)
        } else {
            clearSessionPublished()
            projectStates[projectId]!.sessionStates[newSessionId] = SessionChatState()
        }
        runningProjectIds.remove(projectId)
        sendWebSocketMessage([
            "type": "resume_session",
            "sessionId": newSessionId,
            "projectId": projectId
        ])
    }

    func setWorkingDir(_ dir: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "set_cwd",
            "cwd": dir,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func setProvider(_ providerId: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "set_provider",
            "providerId": providerId,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func setPermissionMode(_ mode: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "set_permission_mode",
            "mode": mode,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func respondToPermission(requestId: String, allow: Bool) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "respond_permission",
            "requestId": requestId,
            "allow": allow,
            "projectId": projectId,
            "sessionId": sessionId
        ])
        self.pendingPermission = nil
    }

    func submitQuestionResponse(toolId: String, answers: [String: Any]) {
        guard let projectId = activeProjectId else { return }

        let answerText = answers.sorted(by: { $0.key < $1.key }).map { (_, value) in
            if let arr = value as? [String] {
                return arr.joined(separator: ", ")
            }
            return "\(value)"
        }.joined(separator: "\n")
        let userMsg = ChatMessage(
            id: UUID().uuidString,
            role: "user",
            content: answerText,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        self.messages.append(userMsg)

        sendWebSocketMessage([
            "type": "respond_question",
            "toolId": toolId,
            "answers": answers,
            "projectId": projectId,
            "sessionId": sessionId
        ])
        self.pendingQuestion = nil
    }

    func dismissQuestion() {
        guard let pq = self.pendingQuestion, let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "dismiss_question",
            "toolId": pq.toolId,
            "projectId": projectId,
            "sessionId": sessionId
        ])
        self.pendingQuestion = nil
    }

    func probeSdk() {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "probe_sdk",
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func dequeueQuery(_ queryId: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "dequeue",
            "queryId": queryId,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func executeNow(_ queryId: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "execute_now",
            "queryId": queryId,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    /// Request a fresh queue snapshot from the server.
    /// Called when the app returns to foreground to sync stale queue state.
    func requestQueueSnapshot() {
        guard let projectId = activeProjectId, connected else { return }
        sendWebSocketMessage([
            "type": "request_queue_snapshot",
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    /// Called when the app returns to foreground.
    /// Ensures WS is connected, fetches incremental session history, and syncs queue state.
    func onForegroundReturn() {
        if !connected {
            // Force immediate reconnection instead of waiting for the 2s timer
            connect()
            return // connect() will send switch_project which triggers history fetch
        }
        // WS is still connected — request queue snapshot and fetch session history
        requestQueueSnapshot()
        // Fetch incremental history for the current viewing session
        // (messages may have been generated while the app was in background)
        if !sessionId.isEmpty {
            fetchSessionHistory(sessionId: sessionId)
        }
    }

    func switchProject(projectId: String, cwd: String?, name: String = "", icon: String = "🦀") {
        if let current = activeProjectId {
            // Save per-session data to current session state
            saveCurrentSessionToState()
            // Save project-level state
            ensureProjectState(current)
            projectStates[current]!.sessionId = sessionId
            projectStates[current]!.pendingPermission = pendingPermission
            projectStates[current]!.isAborting = isAborting
            projectStates[current]!.cwd = self.cwd
            projectStates[current]!.currentProviderId = currentProviderId
            projectStates[current]!.permissionMode = permissionMode
            projectStates[current]!.sdkMcpServers = sdkMcpServers
            projectStates[current]!.sdkSkills = sdkSkills
            projectStates[current]!.sdkTools = sdkTools
            projectStates[current]!.activityHeartbeat = activityHeartbeat
            projectStates[current]!.queryQueue = queryQueue
            projectStates[current]!.sessionUsage = sessionUsage
        }

        activeProjectId = projectId
        activeProjectName = name
        activeProjectIcon = icon
        ensureProjectState(projectId)
        projectStates[projectId]!.awaitingSessionSwitch = true

        let state = projectStates[projectId]!
        // Restore project-level state
        pendingPermission = state.pendingPermission
        isAborting = state.isAborting
        self.cwd = state.cwd.isEmpty ? (cwd ?? "") : state.cwd
        currentProviderId = state.currentProviderId
        permissionMode = state.permissionMode
        sdkMcpServers = state.sdkMcpServers
        sdkSkills = state.sdkSkills
        sdkTools = state.sdkTools
        activityHeartbeat = state.activityHeartbeat
        queryQueue = state.queryQueue
        sessionUsage = state.sessionUsage
        sessionId = state.sessionId

        // Restore viewing session's per-session state
        if !state.sessionId.isEmpty, let sState = state.sessionStates[state.sessionId] {
            loadSessionState(sState)
        } else {
            clearSessionPublished()
        }

        sendWebSocketMessage([
            "type": "switch_project",
            "projectId": projectId,
            "projectCwd": cwd as Any
        ])
    }

    func newChat() {
        guard let pid = activeProjectId else { return }
        // Save current session before starting new one
        saveCurrentSessionToState()
        ensureProjectState(pid)
        // Cancel any pending session switch (e.g. auto-resume from switch_project)
        // so the session_resumed response doesn't hijack the new empty session
        projectStates[pid]!.awaitingSessionSwitch = false
        // Clear local state for new session
        self.sessionId = ""
        projectStates[pid]!.sessionId = ""
        clearSessionPublished()
        self.pendingPermission = nil
        self.sessionUsage = nil
        projectStates[pid]!.sessionUsage = nil
        // Tell server to clear session binding (next prompt will create new session via tempSessionId)
        sendWebSocketMessage([
            "type": "new_session",
            "projectId": pid
        ])
    }
}
