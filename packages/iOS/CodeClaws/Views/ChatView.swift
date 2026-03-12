import SwiftUI

struct ChatView: View {
    let project: Project
    @EnvironmentObject var wsService: WebSocketService
    @State private var showSidebar = false
    @State private var customMcps: [McpInfo] = []
    @State private var enabledIds: Set<String> = []
    @State private var isInputFocused: Bool = false
    @State private var initializedMcps = false

    // Build SDK MCP entries from init message (mirrors web sdkMcpEntries)
    private var sdkMcpEntries: [McpInfo] {
        guard !wsService.sdkMcpServers.isEmpty else { return [] }
        let customIds = Set(customMcps.map { $0.id })
        return wsService.sdkMcpServers
            .filter { $0.status == "connected" && !customIds.contains($0.name) }
            .map { server in
                let prefix = "mcp__\(server.name)__"
                let serverTools = wsService.sdkTools.filter { $0.hasPrefix(prefix) }
                return McpInfo(
                    id: "sdk:\(server.name)",
                    name: server.name,
                    description: "SDK MCP server (\(serverTools.count) tools)",
                    icon: "🔌",
                    toolCount: serverTools.count,
                    source: "sdk",
                    tools: serverTools
                )
            }
    }

    // Build skill entries from init message (mirrors web skillEntries)
    private var skillEntries: [McpInfo] {
        guard !wsService.sdkSkills.isEmpty else { return [] }
        return wsService.sdkSkills.map { name in
            McpInfo(
                id: "skill:\(name)",
                name: name,
                description: "Skill",
                icon: "⚡",
                toolCount: 0,
                source: "skill"
            )
        }
    }

    // Unified list for the toggle UI
    private var allMcps: [McpInfo] {
        customMcps + sdkMcpEntries + skillEntries
    }

    private var enabledMcpsList: [String] {
        Array(enabledIds)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Connection Status
            HStack {
                Circle()
                    .fill(wsService.connected ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text(wsService.connected ? "Connected" : "Disconnected")
                    .font(.caption)
                if !wsService.sessionId.isEmpty {
                    Text("• " + String(wsService.sessionId.suffix(6)))
                        .font(.caption)
                        .fontDesign(.monospaced)
                }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 4)
            .background(Color(UIColor.secondarySystemBackground))

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    MessageListView(
                        messages: wsService.messages,
                        streamingText: wsService.streamingText,
                        streamingThinking: wsService.streamingThinking,
                        isRunning: wsService.isRunning
                    )
                    .padding()
                    .id("Bottom")
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: wsService.messages.count) { _ in scrollToBottom(proxy) }
                .onChange(of: wsService.streamingText) { _ in scrollToBottom(proxy) }
                .onChange(of: wsService.streamingThinking) { _ in scrollToBottom(proxy) }
                .onChange(of: isInputFocused) { _ in scrollToBottom(proxy) }
            }

            // Summary Banner
            if let summary = wsService.latestSummary {
                Text(summary)
                    .font(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.2))
                    .cornerRadius(4)
                    .padding(.horizontal)
            }

            // Question Form
            if let pq = wsService.pendingQuestion {
                UserQuestionFormView(toolId: pq.toolId, questions: pq.questions) { answers in
                    wsService.submitQuestionResponse(toolId: pq.toolId, answers: answers)
                } onCancel: {
                    wsService.dismissQuestion()
                }
                .padding(.horizontal)
                .padding(.vertical, 4)
            }

            // Permission Request
            if let pp = wsService.pendingPermission {
                PermissionRequestView(permission: pp) {
                    wsService.respondToPermission(requestId: pp.requestId, allow: true)
                } onDeny: {
                    wsService.respondToPermission(requestId: pp.requestId, allow: false)
                }
                .padding(.horizontal)
                .padding(.vertical, 4)
            }

            // Input Bar
            InputBarView(
                onSend: handleSend,
                onAbort: { wsService.abort() },
                onPermissionModeChange: { mode in wsService.setPermissionMode(mode) },
                isRunning: wsService.isRunning,
                isAborting: wsService.isAborting,
                currentModel: wsService.currentModel.isEmpty ? "Model" : wsService.currentModel,
                permissionMode: wsService.permissionMode,
                availableMcps: allMcps,
                enabledMcps: enabledMcpsList,
                onToggleMcp: { mcpId in
                    if enabledIds.contains(mcpId) {
                        enabledIds.remove(mcpId)
                    } else {
                        enabledIds.insert(mcpId)
                    }
                },
                sdkLoaded: wsService.sdkLoaded,
                onProbeSdk: { wsService.probeSdk() },
                isInputFocused: $isInputFocused
            )
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .simultaneousGesture(
            TapGesture().onEnded {
                isInputFocused = false
            }
        )
        .navigationTitle("\(project.icon) \(project.name)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: { showSidebar = true }) {
                    Image(systemName: "list.bullet")
                }
            }
        }
        .sheet(isPresented: $showSidebar) {
            SessionSidebarView(projectId: project.id)
        }
        .onAppear {
            wsService.switchProject(projectId: project.id, cwd: project.path)
            fetchMcps()
        }
        // Auto-enable new SDK MCPs and skills when they appear
        .onChange(of: wsService.sdkMcpServers.map { $0.name }) { _ in autoEnableNewEntries() }
        .onChange(of: wsService.sdkSkills) { _ in autoEnableNewEntries() }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation {
            proxy.scrollTo("Bottom", anchor: .bottom)
        }
    }

    private func handleSend(text: String, images: [ImageAttachment]?, mcps: [String]?) {
        if text.hasPrefix("/") {
            wsService.sendCommand(text)
        } else {
            // Separate enabled custom MCPs from disabled SDK servers/skills (mirrors web)
            let enabledCustomMcps = mcps?.filter { !$0.hasPrefix("sdk:") && !$0.hasPrefix("skill:") }
            let disabledSdkServers = sdkMcpEntries
                .filter { !enabledIds.contains($0.id) }
                .map { $0.name }
            let disabledSkills = skillEntries
                .filter { !enabledIds.contains($0.id) }
                .map { $0.name }
            wsService.sendPrompt(
                text,
                images: images,
                enabledMcps: enabledCustomMcps,
                disabledSdkServers: disabledSdkServers.isEmpty ? nil : disabledSdkServers,
                disabledSkills: disabledSkills.isEmpty ? nil : disabledSkills
            )
        }
    }

    private func fetchMcps() {
        Task {
            do {
                let mcps: [McpInfo] = try await APIClient.shared.fetch(path: "/api/mcps")
                let tagged = mcps.map { m -> McpInfo in
                    var copy = m
                    copy.source = "custom"
                    return copy
                }
                customMcps = tagged
                // Enable all custom MCPs by default
                for m in tagged {
                    enabledIds.insert(m.id)
                }
                initializedMcps = true
            } catch {
                print("Failed to load MCPs: \(error)")
            }
        }
    }

    private func autoEnableNewEntries() {
        guard initializedMcps else { return }
        let allNew = sdkMcpEntries + skillEntries
        guard !allNew.isEmpty else { return }
        for entry in allNew {
            enabledIds.insert(entry.id)
        }
    }
}
