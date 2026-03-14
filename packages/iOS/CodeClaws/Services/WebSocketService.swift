import Foundation
import Combine
import SwiftUI

struct PendingQuestion: Equatable {
    let toolId: String
    let questions: [Question]
}

struct ProjectChatState {
    var messages: [ChatMessage] = []
    var streamingText: String = ""
    var streamingThinking: String = ""
    var pendingQuestion: PendingQuestion? = nil
    var pendingPermission: PendingPermission? = nil
    var isAborting: Bool = false
    var sessionId: String = ""
    var cwd: String = ""
    var latestSummary: String? = nil
    var suggestions: [String] = []
    var currentModel: String = ""
    var permissionMode: String = "bypassPermissions"
    // SDK-reported MCP servers, skills, and tools (from init message)
    var sdkMcpServers: [SdkMcpServer] = []
    var sdkSkills: [SdkSkill] = []
    var sdkTools: [String] = []
    // Activity heartbeat
    var activityHeartbeat: ActivityHeartbeat? = nil
    // SDK execution events
    var sdkEvents: [SdkEvent] = []
}

struct ActivityHeartbeat: Equatable {
    var elapsedMs: Double
    var lastActivityType: String
    var lastToolName: String?
    var paused: Bool
}

@MainActor
class WebSocketService: ObservableObject {
    @Published var connected: Bool = false
    @Published var availableModels: [ModelInfo] = []
    @Published var projectStatuses: [ProjectStatus] = []

    /// Single source of truth for which projects are currently processing.
    /// Driven by query_start (insert) and query_end (remove).
    @Published var runningProjectIds = Set<String>()

    /// Convenience for the active project — derived from runningProjectIds.
    var isRunning: Bool {
        guard let pid = activeProjectId else { return false }
        return runningProjectIds.contains(pid)
    }

    @Published var messages: [ChatMessage] = []
    @Published var streamingText: String = ""
    @Published var streamingThinking: String = ""

    /// Filtered streaming text that hides SUMMARY/SUGGESTIONS tags during streaming
    var displayStreamingText: String {
        getDisplayStreamingText(streamingText)
    }

    @Published var isAborting: Bool = false
    @Published var pendingQuestion: PendingQuestion? = nil
    @Published var pendingPermission: PendingPermission? = nil
    @Published var sessionId: String = ""
    @Published var cwd: String = ""
    @Published var latestSummary: String? = nil
    @Published var suggestions: [String] = []
    @Published var currentModel: String = ""
    @Published var permissionMode: String = "bypassPermissions"
    @Published var sdkMcpServers: [SdkMcpServer] = []
    @Published var sdkSkills: [SdkSkill] = []
    @Published var sdkTools: [String] = []
    @Published var activityHeartbeat: ActivityHeartbeat? = nil
    @Published var sdkEvents: [SdkEvent] = []

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
    
    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }
        
        let projectId = json["projectId"] as? String
        let isCurrentProject = projectId == activeProjectId
        
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
                // Sync runningProjectIds from broadcast, respecting query_end precedence.
                for status in statuses {
                    if status.status == "processing" {
                        // Ignore stale "processing" for projects that just finished.
                        if !recentlyEndedProjectIds.contains(status.projectId) {
                            runningProjectIds.insert(status.projectId)
                        }
                    } else {
                        runningProjectIds.remove(status.projectId)
                        recentlyEndedProjectIds.remove(status.projectId)
                    }
                }
            }
        case "query_start":
            if let pid = projectId {
                runningProjectIds.insert(pid)
                recentlyEndedProjectIds.remove(pid)
            }
            if isCurrentProject {
                self.latestSummary = nil
                self.suggestions = []
                self.activityHeartbeat = nil
                // Note: do NOT clear sdkEvents here — previous turns' events must persist
                // so the chat timeline keeps showing earlier assistant responses.
                // sdkEvents is fully replaced only by sdk_event_history (on session/project switch).
            }
        case "query_end":
            if let pid = projectId {
                runningProjectIds.remove(pid)
                recentlyEndedProjectIds.insert(pid)
            }
            if isCurrentProject {
                self.isAborting = false
                self.activityHeartbeat = nil
                // Save message if there's text or thinking content
                if !self.streamingText.isEmpty || !self.streamingThinking.isEmpty {
                    let cleanText = self.cleanStreamingText(self.streamingText)
                    let msg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, thinking: self.streamingThinking.isEmpty ? nil : self.streamingThinking, timestamp: Date().timeIntervalSince1970 * 1000)
                    self.messages.append(msg)
                }
                self.streamingText = ""
                self.streamingThinking = ""
            }
        case "stream_delta":
            if isCurrentProject {
                if let deltaType = json["deltaType"] as? String, let textDelta = json["text"] as? String {
                    if deltaType == "thinking" {
                        self.streamingThinking += textDelta
                    } else {
                        self.streamingText += textDelta
                    }
                }
            }
        case "assistant_text":
            if isCurrentProject, let textMsg = json["text"] as? String {
                let cleanText = self.cleanStreamingText(textMsg)
                let msg = ChatMessage(id: UUID().uuidString, role: "assistant", content: cleanText, timestamp: Date().timeIntervalSince1970 * 1000)
                self.messages.append(msg)
                self.streamingText = ""
            }
        case "thinking":
            if isCurrentProject, let textMsg = json["text"] as? String {
                if let lastIdx = self.messages.lastIndex(where: { $0.role == "assistant" }) {
                    self.messages[lastIdx].thinking = (self.messages[lastIdx].thinking ?? "") + textMsg
                }
            }
        case "tool_use":
            if isCurrentProject {
                if let toolData = try? JSONSerialization.data(withJSONObject: json["toolCalls"] ?? []),
                   let toolCalls = try? JSONDecoder().decode([ToolCall].self, from: toolData) {
                    if let lastIdx = self.messages.lastIndex(where: { $0.role == "system" }), self.messages[lastIdx].toolCalls != nil {
                        self.messages[lastIdx].toolCalls?.append(contentsOf: toolCalls)
                    } else {
                        let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "", toolCalls: toolCalls, timestamp: Date().timeIntervalSince1970 * 1000)
                        self.messages.append(msg)
                    }
                }
            }
        case "tool_result":
            if isCurrentProject, let toolId = json["toolId"] as? String, let result = json["result"] as? String {
                let isError = json["isError"] as? Bool ?? false
                for i in 0..<self.messages.count {
                    if let tcs = self.messages[i].toolCalls, let tIdx = tcs.firstIndex(where: { $0.id == toolId }) {
                        self.messages[i].toolCalls?[tIdx].result = result
                        self.messages[i].toolCalls?[tIdx].isError = isError
                        break
                    }
                }
            }
        case "ask_user_question":
            if isCurrentProject, let toolId = json["toolId"] as? String {
                if let questionsData = try? JSONSerialization.data(withJSONObject: json["questions"] ?? []),
                   let questions = try? JSONDecoder().decode([Question].self, from: questionsData) {
                    self.pendingQuestion = PendingQuestion(toolId: toolId, questions: questions)
                }
            }
        case "permission_request":
            if isCurrentProject, let reqData = try? JSONSerialization.data(withJSONObject: json) {
                if let req = try? JSONDecoder().decode(PendingPermission.self, from: reqData) {
                    self.pendingPermission = req
                }
            }
        case "session_resumed":
            if isCurrentProject, let sid = json["sessionId"] as? String {
                self.sessionId = sid
            }
        case "message_history":
            if isCurrentProject {
                guard let messagesJson = json["messages"] as? [[String: Any]] else { return }

                var loadedMessages: [ChatMessage] = []
                for msgDict in messagesJson {
                    guard let id = msgDict["id"] as? String,
                          let role = msgDict["role"] as? String,
                          let content = msgDict["content"] as? String,
                          let timestamp = msgDict["timestamp"] as? Double else { continue }

                    let costUsd = msgDict["costUsd"] as? Double
                    let durationMs = msgDict["durationMs"] as? Double

                    // Reconstruct tool calls from summary data
                    var toolCalls: [ToolCall]? = nil
                    if let tcArray = msgDict["toolCalls"] as? [[String: Any]] {
                        toolCalls = tcArray.compactMap { tc in
                            guard let name = tc["name"] as? String,
                                  let tcId = tc["id"] as? String else { return nil }
                            let resultPreview = tc["resultPreview"] as? String
                            let isError = tc["isError"] as? Bool

                            // Parse input - prefer structured input object, fallback to inputSummary string
                            let input: JSONValue
                            if let inputObj = tc["input"] {
                                input = parseJSONValue(inputObj)
                            } else {
                                let inputSummary = tc["inputSummary"] as? String ?? ""
                                input = .string(inputSummary)
                            }

                            return ToolCall(
                                name: name,
                                id: tcId,
                                input: input,
                                result: resultPreview,
                                isError: isError
                            )
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
                // Preserve locally-added user messages not yet in server history.
                // Fixes race: sendPrompt adds user message locally, then a stale
                // message_history (from switch_project) arrives and would wipe it.
                let localOnlyUserMessages = self.messages.filter { local in
                    local.role == "user" && !loadedMessages.contains { server in
                        server.role == "user" &&
                        server.content == local.content &&
                        abs(server.timestamp - local.timestamp) < 5000
                    }
                }
                self.messages = loadedMessages + localOnlyUserMessages
            }
        case "user_message":
            if isCurrentProject {
                if let msgData = try? JSONSerialization.data(withJSONObject: json["message"] ?? []),
                   let msg = try? JSONDecoder().decode(ChatMessage.self, from: msgData) {
                    if !isDuplicate(msg) {
                        self.messages.append(msg)
                    }
                }
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
            if isCurrentProject, let errMsg = json["error"] as? String {
                let msg = ChatMessage(id: UUID().uuidString, role: "system", content: "Error: \(errMsg)", timestamp: Date().timeIntervalSince1970 * 1000)
                self.messages.append(msg)
                if let pid = projectId { runningProjectIds.remove(pid) }
                self.isAborting = false
            }
        case "cleared":
            if isCurrentProject {
                self.messages = []
                self.sdkEvents = []
                self.streamingText = ""
                self.streamingThinking = ""
                self.pendingQuestion = nil
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
            if isCurrentProject {
                let content = json["result"] as? String ?? ""
                let cost = json["costUsd"] as? Double
                let duration = json["durationMs"] as? Double
                let msg = ChatMessage(id: UUID().uuidString, role: "system", content: content, costUsd: cost, durationMs: duration, timestamp: Date().timeIntervalSince1970 * 1000)
                self.messages.append(msg)
            }
        case "query_summary":
            if isCurrentProject, let summary = json["summary"] as? String {
                self.latestSummary = summary
            }
        case "query_suggestions":
            if isCurrentProject, let items = json["suggestions"] as? [String] {
                self.suggestions = items
            }
        case "system":
            if isCurrentProject, let subtype = json["subtype"] as? String, subtype == "init" {
                if let model = json["model"] as? String { self.currentModel = model }
                if let sid = json["sessionId"] as? String { self.sessionId = sid }
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
        case "sdk_event":
            if isCurrentProject, let eventDict = json["event"] as? [String: Any] {
                if let event = parseSdkEvent(eventDict) {
                    self.sdkEvents.append(event)
                }
            }
        case "sdk_event_history":
            if isCurrentProject, let eventsArray = json["events"] as? [[String: Any]] {
                self.sdkEvents = eventsArray.compactMap { parseSdkEvent($0) }
            }
        default:
            break
        }
    }
    
    private func isDuplicate(_ message: ChatMessage) -> Bool {
        guard message.role == "user" else { return false }
        return messages.contains { existing in
            existing.role == "user" &&
            existing.content == message.content &&
            abs(existing.timestamp - message.timestamp) < 5000
        }
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
    /// so they never flash on screen during streaming (matches web behavior).
    private func getDisplayStreamingText(_ text: String) -> String {
        if text.isEmpty { return text }

        let hiddenPrefixes = ["\n[SUMMARY:", "\n[SUGGESTIONS:"]

        // Complete tag start found — hide from there onwards
        for prefix in hiddenPrefixes {
            if let range = text.range(of: prefix, options: .backwards) {
                return String(text[..<range.lowerBound])
            }
        }

        // Partial prefix at the very end (e.g. "\n[S" arriving char-by-char) — buffer it
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
    
    // Actions
    func sendPrompt(_ text: String, images: [ImageAttachment]? = nil, enabledMcps: [String]? = nil, disabledSdkServers: [String]? = nil, disabledSkills: [String]? = nil) {
        guard let projectId = activeProjectId else { return }

        // Add user message locally first (like web version does)
        let userMsg = ChatMessage(
            id: UUID().uuidString,
            role: "user",
            content: text,
            images: images,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        self.messages.append(userMsg)

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
    
    func resumeSession(_ sessionId: String) {
        guard let projectId = activeProjectId else { return }
        self.messages.removeAll()
        self.latestSummary = nil
        self.suggestions = []
        runningProjectIds.remove(projectId)
        sendWebSocketMessage([
            "type": "resume_session",
            "sessionId": sessionId,
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

        // Add user message locally first (like sendPrompt does)
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

    func switchProject(projectId: String, cwd: String?) {
        if let current = activeProjectId {
            var state = ProjectChatState()
            state.messages = messages
            state.streamingText = streamingText
            state.streamingThinking = streamingThinking
            state.pendingQuestion = pendingQuestion
            state.pendingPermission = pendingPermission
            state.isAborting = isAborting
            state.sessionId = sessionId
            state.cwd = self.cwd
            state.latestSummary = latestSummary
            state.suggestions = suggestions
            state.currentModel = currentModel
            state.permissionMode = permissionMode
            state.sdkMcpServers = sdkMcpServers
            state.sdkSkills = sdkSkills
            state.sdkTools = sdkTools
            state.activityHeartbeat = activityHeartbeat
            state.sdkEvents = sdkEvents
            projectStates[current] = state
        }

        activeProjectId = projectId

        if let state = projectStates[projectId] {
            messages = state.messages
            streamingText = state.streamingText
            streamingThinking = state.streamingThinking
            pendingQuestion = state.pendingQuestion
            pendingPermission = state.pendingPermission
            isAborting = state.isAborting
            sessionId = state.sessionId
            self.cwd = state.cwd
            currentModel = state.currentModel
            permissionMode = state.permissionMode
            sdkMcpServers = state.sdkMcpServers
            sdkSkills = state.sdkSkills
            sdkTools = state.sdkTools
            activityHeartbeat = state.activityHeartbeat
            sdkEvents = state.sdkEvents
        } else {
            messages = []
            streamingText = ""
            streamingThinking = ""
            pendingQuestion = nil
            pendingPermission = nil
            isAborting = false
            sessionId = ""
            self.cwd = cwd ?? ""
            currentModel = ""
            permissionMode = "bypassPermissions"
            sdkMcpServers = []
            sdkSkills = []
            sdkTools = []
            activityHeartbeat = nil
            sdkEvents = []
        }

        // Always clear summary/suggestions on project switch
        latestSummary = nil
        suggestions = []

        // runningProjectIds is global — no need to reset per project.
        // If a query IS active, runningProjectIds already has this project.
        // If not, the server's switch_project may send query_start to add it.

        sendWebSocketMessage([
            "type": "switch_project",
            "projectId": projectId,
            "projectCwd": cwd as Any
        ])
    }
    
    func newChat() {
        sendCommand("/clear")
    }
}
