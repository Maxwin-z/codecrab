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

// Per-session state (isolated per session within a project)
struct SessionChatState {
    var messages: [ChatMessage] = []
    var streamingText: String = ""
    var streamingThinking: String = ""
    var sdkEvents: [SdkEvent] = []
    var latestSummary: String? = nil
    var suggestions: [String] = []
    var pendingQuestion: PendingQuestion? = nil
}

// Per-project state (contains per-session state cache)
struct ProjectChatState {
    var sessionId: String = ""  // viewing session
    var sessionStates: [String: SessionChatState] = [:]
    var awaitingSessionSwitch: Bool = false
    var pendingPermission: PendingPermission? = nil
    var isAborting: Bool = false
    var cwd: String = ""
    var currentModel: String = ""
    var permissionMode: String = "bypassPermissions"
    var sdkMcpServers: [SdkMcpServer] = []
    var sdkSkills: [SdkSkill] = []
    var sdkTools: [String] = []
    var activityHeartbeat: ActivityHeartbeat? = nil
    var queryQueue: [QueueItem] = []
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

    /// Filtered streaming text that hides SUMMARY/SUGGESTIONS tags during streaming
    var displayStreamingText: String {
        getDisplayStreamingText(streamingText)
    }

    // Per-project @Published properties
    @Published var isAborting: Bool = false
    @Published var pendingPermission: PendingPermission? = nil
    @Published var sessionId: String = ""
    @Published var cwd: String = ""
    @Published var currentModel: String = ""
    @Published var permissionMode: String = "bypassPermissions"
    @Published var sdkMcpServers: [SdkMcpServer] = []
    @Published var sdkSkills: [SdkSkill] = []
    @Published var sdkTools: [String] = []
    @Published var activityHeartbeat: ActivityHeartbeat? = nil
    @Published var queryQueue: [QueueItem] = []

    var sdkLoaded: Bool { !sdkTools.isEmpty }

    private var activeProjectId: String? = nil
    private var projectStates: [String: ProjectChatState] = [:]
    private var webSocketTask: URLSessionWebSocketTask?
    private var clientId: String
    /// Projects that recently received query_end — blocks stale "processing"
    /// from project_statuses broadcasts until a clean "idle" confirms it.
    private var recentlyEndedProjectIds = Set<String>()

    init() {
        if let savedId = UserDefaults.standard.string(forKey: "codeclaws_client_id") {
            self.clientId = savedId
        } else {
            let newId = "client-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 1000...9999))"
            UserDefaults.standard.set(newId, forKey: "codeclaws_client_id")
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
            pendingQuestion: pendingQuestion
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
            guard let serverURLStr = UserDefaults.standard.string(forKey: "codeclaws_server_url"),
                  let token = KeychainHelper.shared.getToken() else { return }

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

    private func reconnect() {
        Task { @MainActor in
            guard !connected else { return }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.connect()
        }
    }

    private func receiveLoop() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case .success(let message):
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
                case .failure(_):
                    self.connected = false
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
            if let pid = projectId {
                runningProjectIds.insert(pid)
                recentlyEndedProjectIds.remove(pid)
            }
            if isCurrentProject, let pid = projectId {
                self.activityHeartbeat = nil
                // Clear summary/suggestions for the session that's starting a query
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty {
                    if targetSid == sessionId {
                        self.latestSummary = nil
                        self.suggestions = []
                    } else {
                        modifySessionState(projectId: pid, sessionId: targetSid) {
                            $0.latestSummary = nil
                            $0.suggestions = []
                        }
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
                // Defensively remove the completed query from the queue.
                // query_queue_status(completed) should handle this, but query_end
                // serves as a backup to prevent stale queue items.
                if let queryId = json["queryId"] as? String, !queryId.isEmpty {
                    self.queryQueue.removeAll { $0.queryId == queryId }
                }
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty {
                    if targetSid == sessionId {
                        // Viewing session: flush streaming to @Published messages
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
                            if !sState.streamingText.isEmpty || !sState.streamingThinking.isEmpty {
                                let cleanText = self.cleanStreamingText(sState.streamingText)
                                let msg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, thinking: sState.streamingThinking.isEmpty ? nil : sState.streamingThinking, timestamp: Date().timeIntervalSince1970 * 1000)
                                sState.messages.append(msg)
                            }
                            sState.streamingText = ""
                            sState.streamingThinking = ""
                        }
                    }
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
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if deltaType == "thinking" { $0.streamingThinking += textDelta }
                    else { $0.streamingText += textDelta }
                }
            }
        case "assistant_text":
            guard let pid = projectId, isCurrentProject, let textMsg = json["text"] as? String else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            let cleanText = self.cleanStreamingText(textMsg)
            let assistantMsg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, timestamp: Date().timeIntervalSince1970 * 1000)
            if targetSid == sessionId {
                self.messages.append(assistantMsg)
                self.streamingText = ""
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    $0.messages.append(assistantMsg)
                    $0.streamingText = ""
                }
            }
        case "thinking":
            guard let pid = projectId, isCurrentProject, let textMsg = json["text"] as? String else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                if let lastIdx = self.messages.lastIndex(where: { $0.role == "assistant" }) {
                    self.messages[lastIdx].thinking = (self.messages[lastIdx].thinking ?? "") + textMsg
                }
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if let lastIdx = $0.messages.lastIndex(where: { $0.role == "assistant" }) {
                        $0.messages[lastIdx].thinking = ($0.messages[lastIdx].thinking ?? "") + textMsg
                    }
                }
            }
        case "tool_use":
            guard let pid = projectId, isCurrentProject else { break }
            guard let toolData = try? JSONSerialization.data(withJSONObject: json["toolCalls"] ?? []),
                  let toolCalls = try? JSONDecoder().decode([ToolCall].self, from: toolData) else { break }
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                if let lastIdx = self.messages.lastIndex(where: { $0.role == "system" }), self.messages[lastIdx].toolCalls != nil {
                    self.messages[lastIdx].toolCalls?.append(contentsOf: toolCalls)
                } else {
                    let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "", toolCalls: toolCalls, timestamp: Date().timeIntervalSince1970 * 1000)
                    self.messages.append(msg)
                }
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    if let lastIdx = $0.messages.lastIndex(where: { $0.role == "system" }), $0.messages[lastIdx].toolCalls != nil {
                        $0.messages[lastIdx].toolCalls?.append(contentsOf: toolCalls)
                    } else {
                        let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "", toolCalls: toolCalls, timestamp: Date().timeIntervalSince1970 * 1000)
                        $0.messages.append(msg)
                    }
                }
            }
        case "tool_result":
            guard let pid = projectId, isCurrentProject else { break }
            guard let toolId = json["toolId"] as? String, let result = json["result"] as? String else { break }
            let isError = json["isError"] as? Bool ?? false
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                for i in 0..<self.messages.count {
                    if let tcs = self.messages[i].toolCalls, let tIdx = tcs.firstIndex(where: { $0.id == toolId }) {
                        self.messages[i].toolCalls?[tIdx].result = result
                        self.messages[i].toolCalls?[tIdx].isError = isError
                        break
                    }
                }
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) {
                    for i in 0..<$0.messages.count {
                        if let tcs = $0.messages[i].toolCalls, let tIdx = tcs.firstIndex(where: { $0.id == toolId }) {
                            $0.messages[i].toolCalls?[tIdx].result = result
                            $0.messages[i].toolCalls?[tIdx].isError = isError
                            break
                        }
                    }
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
                }
            }
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
            }
        case "message_history":
            guard let pid = projectId, isCurrentProject else { break }
            guard let messagesJson = json["messages"] as? [[String: Any]] else { break }
            let loadedMessages = parseMessageHistory(messagesJson)
            let targetSid = msgSessionId ?? sessionId
            guard !targetSid.isEmpty else { break }
            if targetSid == sessionId {
                self.messages = loadedMessages
            } else {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages = loadedMessages }
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
        case "model_changed":
            if isCurrentProject, let model = json["model"] as? String {
                self.currentModel = model
            }
        case "permission_mode_changed":
            if isCurrentProject, let mode = json["mode"] as? String {
                self.permissionMode = mode
            }
        case "cwd_changed":
            if isCurrentProject, let dir = json["cwd"] as? String {
                self.cwd = dir
            }
        case "error":
            guard let pid = projectId, isCurrentProject else { break }
            if let errMsg = json["message"] as? String ?? json["error"] as? String {
                let errorChatMsg = ChatMessage(id: UUID().uuidString, role: "system", content: "Error: \(errMsg)", timestamp: Date().timeIntervalSince1970 * 1000)
                let targetSid = msgSessionId ?? sessionId
                if !targetSid.isEmpty && targetSid == sessionId {
                    self.messages.append(errorChatMsg)
                } else if !targetSid.isEmpty {
                    modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages.append(errorChatMsg) }
                }
            }
            runningProjectIds.remove(pid)
            self.isAborting = false
        case "cleared":
            if isCurrentProject {
                clearSessionPublished()
                self.pendingPermission = nil
                if let pid = projectId { runningProjectIds.remove(pid) }
                self.isAborting = false
            }
        case "aborted":
            if isCurrentProject {
                if let pid = projectId { runningProjectIds.remove(pid) }
                self.isAborting = false
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
            } else if !targetSid.isEmpty {
                modifySessionState(projectId: pid, sessionId: targetSid) { $0.messages.append(resultMsg) }
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
        case "system":
            if isCurrentProject, let pid = projectId, let subtype = json["subtype"] as? String, subtype == "init" {
                if let model = json["model"] as? String { self.currentModel = model }
                // Only update viewing session if awaiting (switch_project, /clear, reconnect)
                if let sid = json["sessionId"] as? String, projectStates[pid]?.awaitingSessionSwitch == true {
                    self.sessionId = sid
                    projectStates[pid]!.sessionId = sid
                    projectStates[pid]!.awaitingSessionSwitch = false
                }
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
        case "activity_heartbeat":
            if isCurrentProject {
                let elapsedMs = json["elapsedMs"] as? Double ?? 0
                let lastActivityType = json["lastActivityType"] as? String ?? "working"
                let lastToolName = json["lastToolName"] as? String
                let paused = json["paused"] as? Bool ?? false
                self.activityHeartbeat = ActivityHeartbeat(
                    elapsedMs: elapsedMs,
                    lastActivityType: lastActivityType,
                    lastToolName: lastToolName,
                    paused: paused
                )
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
        default:
            break
        }
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
                    let resultPreview = tc["resultPreview"] as? String
                    let isError = tc["isError"] as? Bool
                    let input: JSONValue
                    if let inputObj = tc["input"] {
                        input = parseJSONValue(inputObj)
                    } else {
                        let inputSummary = tc["inputSummary"] as? String ?? ""
                        input = .string(inputSummary)
                    }
                    return ToolCall(name: name, id: tcId, input: input, result: resultPreview, isError: isError)
                }
            }

            let msg = ChatMessage(
                id: id,
                role: role,
                content: content,
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

    /// Strip trailing [SUMMARY: ...] / [SUGGESTIONS: ...] tags from streaming text
    private func getDisplayStreamingText(_ text: String) -> String {
        if text.isEmpty { return text }

        let hiddenPrefixes = ["\n[SUMMARY:", "\n[SUGGESTIONS:"]

        for prefix in hiddenPrefixes {
            if let range = text.range(of: prefix, options: .backwards) {
                return String(text[..<range.lowerBound])
            }
        }

        for prefix in hiddenPrefixes {
            for len in (2..<prefix.count).reversed() {
                let partial = String(prefix.prefix(len))
                if text.hasSuffix(partial) {
                    return String(text.prefix(text.count - len))
                }
            }
        }

        return text
    }

    private func cleanStreamingText(_ text: String) -> String {
        return text
            .replacingOccurrences(of: "\\n?\\[SUGGESTIONS:.*?\\]\\s*$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\n?\\[SUMMARY:.*?\\]\\s*$", with: "", options: .regularExpression)
    }

    private func sendWebSocketMessage(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        webSocketTask?.send(message) { _ in }
    }

    // MARK: - Actions

    func sendPrompt(_ text: String, images: [ImageAttachment]? = nil, enabledMcps: [String]? = nil, disabledSdkServers: [String]? = nil, disabledSkills: [String]? = nil) {
        guard let projectId = activeProjectId else { return }

        var payload: [String: Any] = [
            "type": "prompt",
            "prompt": text,
            "projectId": projectId,
            "sessionId": sessionId
        ]
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
        sendWebSocketMessage(payload)
    }

    func sendCommand(_ command: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "command",
            "command": command,
            "projectId": projectId,
            "sessionId": sessionId
        ])
    }

    func abort() {
        guard let projectId = activeProjectId else { return }
        isAborting = true
        sendWebSocketMessage([
            "type": "abort",
            "projectId": projectId,
            "sessionId": sessionId
        ])
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
        // Load cached state for new session (if any), otherwise clear
        if let cached = projectStates[projectId]?.sessionStates[newSessionId] {
            loadSessionState(cached)
        } else {
            clearSessionPublished()
        }
        // Clear cached state — server will send fresh message_history
        projectStates[projectId]!.sessionStates[newSessionId] = SessionChatState()
        clearSessionPublished()
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

    func setModel(_ model: String) {
        guard let projectId = activeProjectId else { return }
        sendWebSocketMessage([
            "type": "set_model",
            "model": model,
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

    func switchProject(projectId: String, cwd: String?) {
        if let current = activeProjectId {
            // Save per-session data to current session state
            saveCurrentSessionToState()
            // Save project-level state
            ensureProjectState(current)
            projectStates[current]!.sessionId = sessionId
            projectStates[current]!.pendingPermission = pendingPermission
            projectStates[current]!.isAborting = isAborting
            projectStates[current]!.cwd = self.cwd
            projectStates[current]!.currentModel = currentModel
            projectStates[current]!.permissionMode = permissionMode
            projectStates[current]!.sdkMcpServers = sdkMcpServers
            projectStates[current]!.sdkSkills = sdkSkills
            projectStates[current]!.sdkTools = sdkTools
            projectStates[current]!.activityHeartbeat = activityHeartbeat
            projectStates[current]!.queryQueue = queryQueue
        }

        activeProjectId = projectId
        ensureProjectState(projectId)
        projectStates[projectId]!.awaitingSessionSwitch = true

        let state = projectStates[projectId]!
        // Restore project-level state
        pendingPermission = state.pendingPermission
        isAborting = state.isAborting
        self.cwd = state.cwd.isEmpty ? (cwd ?? "") : state.cwd
        currentModel = state.currentModel
        permissionMode = state.permissionMode
        sdkMcpServers = state.sdkMcpServers
        sdkSkills = state.sdkSkills
        sdkTools = state.sdkTools
        activityHeartbeat = state.activityHeartbeat
        queryQueue = state.queryQueue
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
        if let pid = activeProjectId {
            // Save current session before clearing
            saveCurrentSessionToState()
            ensureProjectState(pid)
            projectStates[pid]!.awaitingSessionSwitch = true
        }
        sendCommand("/clear")
    }
}
