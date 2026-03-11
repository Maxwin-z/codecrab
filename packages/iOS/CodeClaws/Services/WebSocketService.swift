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
    var isRunning: Bool = false
    var isAborting: Bool = false
    var sessionId: String = ""
    var cwd: String = ""
    var latestSummary: String? = nil
    var currentModel: String = ""
    var permissionMode: String = "bypassPermissions"
}

@MainActor
class WebSocketService: ObservableObject {
    @Published var connected: Bool = false
    @Published var availableModels: [ModelInfo] = []
    @Published var projectStatuses: [ProjectStatus] = []
    
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
    @Published var permissionMode: String = "bypassPermissions"
    
    private var activeProjectId: String? = nil
    private var projectStates: [String: ProjectChatState] = [:]
    private var webSocketTask: URLSessionWebSocketTask?
    private var clientId: String
    
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
            Task { @MainActor in
                guard let self = self else { return }
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
            }
        case "query_start":
            if isCurrentProject { self.isRunning = true }
        case "query_end":
            if isCurrentProject {
                self.isRunning = false
                self.isAborting = false
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
                            let inputSummary = tc["inputSummary"] as? String ?? ""
                            let resultPreview = tc["resultPreview"] as? String
                            let isError = tc["isError"] as? Bool
                            return ToolCall(
                                name: name,
                                id: tcId,
                                input: .string(inputSummary),
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
                self.messages = loadedMessages
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
                self.isRunning = false
                self.isAborting = false
            }
        case "cleared":
            if isCurrentProject {
                self.messages = []
                self.streamingText = ""
                self.streamingThinking = ""
                self.pendingQuestion = nil
                self.pendingPermission = nil
                self.isRunning = false
                self.isAborting = false
            }
        case "aborted":
            if isCurrentProject {
                self.isRunning = false
                self.isAborting = false
            }
        case "result":
            if isCurrentProject {
                var content = json["result"] as? String ?? ""
                let cost = json["costUsd"] as? Double
                let duration = json["durationMs"] as? Double
                let msg = ChatMessage(id: UUID().uuidString, role: "system", content: content, costUsd: cost, durationMs: duration, timestamp: Date().timeIntervalSince1970 * 1000)
                self.messages.append(msg)
            }
        case "query_summary":
            if isCurrentProject, let summary = json["summary"] as? String {
                self.latestSummary = summary
            }
        default:
            break
        }
    }
    
    private func isDuplicate(_ message: ChatMessage) -> Bool {
        guard message.role == "user" else { return false }
        let now = Date().timeIntervalSince1970 * 1000
        return messages.contains { existing in
            existing.role == "user" &&
            existing.content == message.content &&
            abs(existing.timestamp - message.timestamp) < 5000
        }
    }
    
    private func cleanStreamingText(_ text: String) -> String {
        return text.replacingOccurrences(of: "\\[SUMMARY:.*?\\]$", with: "", options: .regularExpression)
    }
    
    private func sendWebSocketMessage(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        webSocketTask?.send(message) { _ in }
    }
    
    // Actions
    func sendPrompt(_ text: String, images: [ImageAttachment]? = nil, enabledMcps: [String]? = nil) {
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
    
    func switchProject(projectId: String, cwd: String?) {
        if let current = activeProjectId {
            projectStates[current] = ProjectChatState(
                messages: messages,
                streamingText: streamingText,
                streamingThinking: streamingThinking,
                pendingQuestion: pendingQuestion,
                pendingPermission: pendingPermission,
                isRunning: isRunning,
                isAborting: isAborting,
                sessionId: sessionId,
                cwd: self.cwd,
                latestSummary: latestSummary,
                currentModel: currentModel,
                permissionMode: permissionMode
            )
        }
        
        activeProjectId = projectId
        
        if let state = projectStates[projectId] {
            messages = state.messages
            streamingText = state.streamingText
            streamingThinking = state.streamingThinking
            pendingQuestion = state.pendingQuestion
            pendingPermission = state.pendingPermission
            isRunning = state.isRunning
            isAborting = state.isAborting
            sessionId = state.sessionId
            self.cwd = state.cwd
            latestSummary = state.latestSummary
            currentModel = state.currentModel
            permissionMode = state.permissionMode
        } else {
            messages = []
            streamingText = ""
            streamingThinking = ""
            pendingQuestion = nil
            pendingPermission = nil
            isRunning = false
            isAborting = false
            sessionId = ""
            self.cwd = cwd ?? ""
            latestSummary = nil
            currentModel = ""
            permissionMode = "default"
        }
        
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
