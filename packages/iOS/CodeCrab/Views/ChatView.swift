import SwiftUI

struct ChatView: View {
    let project: Project
    let initialSessionId: String?
    @Binding var pendingAttachments: [ImageAttachment]
    @Binding var pendingSessionId: String?
    /// When false, ChatView won't auto-call switchProject on appear (used in grid mode)
    var autoConnect: Bool = true
    @EnvironmentObject var wsService: WebSocketService
    @State private var showFileBrowser = false
    @State private var customMcps: [McpInfo] = []
    @State private var enabledIds: Set<String> = []
    @State private var isInputFocused: Bool = false
    @State private var initializedMcps = false
    @State private var prefillText: String = ""
    @State private var breathe = false
    @State private var arrowBounce = false
    @State private var execSessionId: String? = nil
    @State private var inputAttachments: [ImageAttachment] = []
    @State private var isNearBottom: Bool = true
    @State private var isUserInteracting: Bool = false
    @State private var scrollViewHeight: CGFloat = 0
    @State private var providers: [ProviderConfig] = []
    @State private var selectedProviderId: String = ""
    @State private var showSessionDetail = false

    // Agent editor mode
    @State private var agentEditorCompleting = false
    @State private var agentEditorSentInitial = false
    @State private var agentEditorError: String?
    @Environment(\.dismiss) private var dismiss

    private var isAgentEditor: Bool {
        project.id.hasPrefix("__agent-editor-")
    }

    private var editingAgentId: String? {
        guard isAgentEditor else { return nil }
        return String(project.id.dropFirst("__agent-editor-".count))
    }

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
        return wsService.sdkSkills.map { skill in
            McpInfo(
                id: "skill:\(skill.name)",
                name: skill.name,
                description: skill.description.isEmpty ? "Skill" : skill.description,
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

    private var showEmptyState: Bool {
        wsService.messages.isEmpty && wsService.streamingText.isEmpty && wsService.streamingThinking.isEmpty && !wsService.isRunning
    }

    var body: some View {
        VStack(spacing: 0) {
            messagesSection
            bottomControlsSection
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(project.icon) \(project.name)")
                            .font(.headline)
                        Circle()
                            .fill(heartbeatDotColor)
                            .frame(width: 6, height: 6)
                            .opacity(wsService.activityHeartbeat != nil && !(wsService.activityHeartbeat?.paused ?? false) ? (breathe ? 0.3 : 1.0) : 1.0)
                            .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: breathe)
                            .onAppear { breathe = true }
                        if !wsService.sessionId.isEmpty {
                            Text(String(wsService.sessionId.suffix(6)))
                                .font(.caption2)
                                .fontDesign(.monospaced)
                                .foregroundStyle(.secondary)
                        }
                        if let usage = wsService.sessionUsage,
                           usage.contextWindowMax > 0, usage.contextWindowUsed > 0 {
                            Button(action: { showSessionDetail = true }) {
                                ContextRingView(ratio: Double(usage.contextWindowUsed) / Double(usage.contextWindowMax))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if let hb = wsService.activityHeartbeat {
                        HStack(spacing: 4) {
                            Text(activityLabel(hb))
                            Text("·")
                            Text(formatElapsed(hb.elapsedMs))
                                .fontDesign(.monospaced)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
                .sheet(isPresented: $showSessionDetail) {
                    if let usage = wsService.sessionUsage {
                        SessionDetailView(usage: usage, sessionId: wsService.sessionId)
                            .presentationDetents([.medium, .large])
                    }
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if isAgentEditor {
                    Button(action: { completeAgentEditing() }) {
                        if agentEditorCompleting {
                            ProgressView()
                        } else {
                            Text("Done")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(agentEditorCompleting || wsService.messages.isEmpty)
                } else {
                    Button(action: { showFileBrowser = true }) {
                        Image(systemName: "folder")
                    }
                }
            }
        }
        .overlay(alignment: .top) {
            if let toast = wsService.toastMessage {
                ErrorToastView(message: toast) {
                    wsService.toastMessage = nil
                }
                .transition(.move(edge: .top).combined(with: .opacity))
                .zIndex(100)
            }
        }
        .sheet(isPresented: $showFileBrowser) {
            FileBrowserView(projectPath: project.path)
        }
        .sheet(isPresented: showExecSession) {
            if let sid = execSessionId {
                ExecSessionSheet(sessionId: sid)
            }
        }
        .overlay(alignment: .top) {
            if let error = agentEditorError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.red.cornerRadius(8))
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { agentEditorError = nil }
            }
        }
        .onAppear {
            if autoConnect {
                connectToProject()
            }
            fetchMcps()
            fetchProviders()
            handlePendingShare()
            restoreDraftIfNeeded()
            if isAgentEditor && initialSessionId == nil {
                sendAgentEditorInitialPrompt()
            }
        }
        .onChange(of: pendingAttachments) { _, newAttachments in
            if !newAttachments.isEmpty {
                handlePendingShare()
            }
        }
        // Auto-enable new SDK MCPs and skills when they appear
        .onChange(of: wsService.sdkMcpServers.map { $0.name }) { autoEnableNewEntries() }
        .onChange(of: wsService.sdkSkills.map { $0.name }) { autoEnableNewEntries() }
    }

    // MARK: - Messages

    private var messagesSection: some View {
        Group {
            if showEmptyState {
                VStack {
                    Spacer()
                    emptyStateView
                    Spacer()
                    Spacer()
                }
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        MessageListView(
                            messages: wsService.messages,
                            streamingText: wsService.displayStreamingText,
                            streamingThinking: wsService.streamingThinking,
                            isRunning: wsService.isRunning,
                            sdkEvents: wsService.sdkEvents,
                            onResumeSession: { sid in
                                execSessionId = sid
                            }
                        )
                        .padding()

                        // Suggested Replies (vertical, inline with messages)
                        if !wsService.suggestions.isEmpty && !wsService.isRunning {
                            VStack(spacing: 8) {
                                ForEach(wsService.suggestions, id: \.self) { suggestion in
                                    Button(action: { prefillText = suggestion }) {
                                        Text(suggestion)
                                            .font(.caption)
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(Color.accentColor.opacity(0.1))
                                            .foregroundColor(.accentColor)
                                            .cornerRadius(10)
                                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor.opacity(0.3), lineWidth: 1))
                                    }
                                }
                            }
                            .padding(.horizontal)
                            .padding(.bottom, 8)
                        }

                        GeometryReader { geo in
                            Color.clear.preference(
                                key: BottomOffsetKey.self,
                                value: geo.frame(in: .named("chatScroll")).minY
                            )
                        }
                        .frame(height: 1)
                        .id("Bottom")
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 5)
                            .onChanged { _ in isUserInteracting = true }
                            .onEnded { _ in isUserInteracting = false }
                    )
                    .coordinateSpace(name: "chatScroll")
                    .background(
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { scrollViewHeight = geo.size.height }
                                .onChange(of: geo.size.height) { _, h in scrollViewHeight = h }
                        }
                    )
                    .onPreferenceChange(BottomOffsetKey.self) { bottomY in
                        let nearBottom = bottomY <= scrollViewHeight + 150
                        // Only allow isNearBottom to flip false when the user is actively
                        // scrolling. Content growth alone (which pushes the bottom marker
                        // further away) must NOT disable auto-scroll.
                        if isUserInteracting || nearBottom {
                            isNearBottom = nearBottom
                        }
                    }
                    .onChange(of: wsService.messages.count) { scrollToBottom(proxy) }
                    .onChange(of: wsService.sdkEvents.count) { scrollToBottom(proxy) }
                    .onChange(of: wsService.displayStreamingText) { scrollToBottom(proxy) }
                    .onChange(of: wsService.streamingThinking) { scrollToBottom(proxy) }
                    .onChange(of: isInputFocused) { scrollToBottom(proxy) }
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            scrollToBottom(proxy, force: true)
                        }
                    }
                    .onChange(of: wsService.sessionId) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            scrollToBottom(proxy, force: true)
                        }
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            isInputFocused = false
        }
        .overlay(alignment: .bottomTrailing) {
            QueryQueueBarView(
                items: wsService.queryQueue,
                currentSessionId: wsService.sessionId,
                onAbort: { queryId in wsService.abort(queryId: queryId) },
                onDequeue: { queryId in wsService.dequeueQuery(queryId) },
                onExecuteNow: { queryId in wsService.executeNow(queryId) },
                isAborting: wsService.isAborting
            )
        }
    }

    // MARK: - Bottom Controls

    @ViewBuilder
    private var bottomControlsSection: some View {
        // Summary Banner
        if let summary = wsService.latestSummary {
            Text(summary)
                .font(.caption)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.green.opacity(0.2))
                .cornerRadius(4)
                .padding(.horizontal)
                .onTapGesture {
                    wsService.latestSummary = nil
                }
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
        inputBarSection
    }

    // MARK: - Input Bar

    private var inputBarSection: some View {
        InputBarView(
            onSend: handleSend,
            onAbort: { wsService.abort() },
            onPermissionModeChange: { mode in wsService.setPermissionMode(mode) },
            isRunning: wsService.isRunning,
            isAborting: wsService.isAborting,
            currentModel: wsService.currentProviderId.isEmpty ? "Model" : wsService.currentProviderId,
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
            projectPath: project.path,
            isInputFocused: $isInputFocused,
            prefillText: $prefillText,
            externalAttachments: $inputAttachments
        )
        .padding(.horizontal)
        .padding(.top, 4)
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 0) {
            // Icon
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary.opacity(0.5))
                .padding(.bottom, 16)

            // Title
            Text("CodeCrab")
                .font(.system(size: 28, weight: .bold))
                .padding(.bottom, 6)

            // Subtitle
            Text("Your AI coding companion")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            // Provider Picker
            if providers.count > 1 {
                Menu {
                    ForEach(providers) { provider in
                        Button {
                            selectedProviderId = provider.id
                        } label: {
                            HStack {
                                Text(provider.name)
                                if selectedProviderId == provider.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "cpu")
                            .font(.system(size: 12))
                        Text(selectedProviderName)
                            .font(.subheadline)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color(UIColor.tertiarySystemFill))
                    .cornerRadius(8)
                }
                .padding(.top, 20)
            }

            // Down arrow indicator
            VStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .offset(y: arrowBounce ? 4 : 0)
                    .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: arrowBounce)
                Text("Send a message to start a new session")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.top, 28)
            .onAppear { arrowBounce = true }
        }
        .padding(.horizontal)
        .animation(.easeInOut(duration: 0.25), value: isInputFocused)
    }

    private var selectedProviderName: String {
        if selectedProviderId.isEmpty {
            return "Default Provider"
        }
        return providers.first(where: { $0.id == selectedProviderId })?.name ?? selectedProviderId
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard force || (isNearBottom && !isUserInteracting) else { return }
        if force {
            withAnimation {
                proxy.scrollTo("Bottom", anchor: .bottom)
            }
        } else {
            // Non-animated scroll during streaming avoids race conditions where
            // an in-flight animation leaves the bottom marker outside the
            // threshold, falsely disabling auto-scroll.
            proxy.scrollTo("Bottom", anchor: .bottom)
        }
    }

    /// Connect to the project WebSocket (switch project + resume/new session)
    func connectToProject() {
        wsService.switchProject(projectId: project.id, cwd: project.path, name: project.name, icon: project.icon)
        if let sessionId = initialSessionId {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                wsService.resumeSession(sessionId)
            }
        } else {
            wsService.newChat()
        }
    }

    @discardableResult
    private func handleSend(text: String, images: [ImageAttachment]?, mcps: [String]?) -> Bool {
        isNearBottom = true
        isInputFocused = false
        wsService.latestSummary = nil
        if text.hasPrefix("/") {
            return wsService.sendCommand(text)
        } else {
            // Separate enabled custom MCPs from disabled SDK servers/skills (mirrors web)
            let enabledCustomMcps = mcps?.filter { !$0.hasPrefix("sdk:") && !$0.hasPrefix("skill:") }
            let disabledSdkServers = sdkMcpEntries
                .filter { !enabledIds.contains($0.id) }
                .map { $0.name }
            let disabledSkills = skillEntries
                .filter { !enabledIds.contains($0.id) }
                .map { $0.name }
            return wsService.sendPrompt(
                text,
                images: images,
                enabledMcps: enabledCustomMcps,
                disabledSdkServers: disabledSdkServers.isEmpty ? nil : disabledSdkServers,
                disabledSkills: disabledSkills.isEmpty ? nil : disabledSkills,
                providerId: selectedProviderId.isEmpty ? nil : selectedProviderId
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

    private func fetchProviders() {
        Task {
            do {
                guard let serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url"),
                      let url = URL(string: "\(serverURL)/api/setup/providers") else { return }
                var request = URLRequest(url: url)
                if let token = KeychainHelper.shared.getToken() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResp = response as? HTTPURLResponse, (200...299).contains(httpResp.statusCode) else { return }
                guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let providersList = json["providers"] as? [[String: Any]],
                      let defaultId = json["defaultProviderId"] as? String else { return }
                var configs: [ProviderConfig] = []
                for p in providersList {
                    guard let id = p["id"] as? String, let name = p["name"] as? String, let provider = p["provider"] as? String else { continue }
                    configs.append(ProviderConfig(id: id, name: name, provider: provider, apiKey: nil, modelId: p["modelId"] as? String, baseUrl: p["baseUrl"] as? String))
                }
                self.providers = configs
                // Pre-select the default provider
                if selectedProviderId.isEmpty {
                    selectedProviderId = defaultId
                }
            } catch {
                print("Failed to fetch providers: \(error)")
            }
        }
    }

    private func handlePendingShare() {
        guard !pendingAttachments.isEmpty else { return }

        // Resume session if specified
        if let sessionId = pendingSessionId {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                wsService.resumeSession(sessionId)
            }
            pendingSessionId = nil
        }

        // Pass attachments to input bar
        inputAttachments = pendingAttachments
        pendingAttachments = []
    }

    private func restoreDraftIfNeeded() {
        guard let draft = wsService.loadDraftFromCache(forProjectId: project.id) else { return }
        // Restore prompt text and attachments into the input bar
        prefillText = draft.text
        if !draft.images.isEmpty {
            inputAttachments = draft.images
        }
        // Restore session messages if current session is empty and matches
        if wsService.messages.isEmpty && !draft.messages.isEmpty {
            wsService.messages = draft.messages
            wsService.sdkEvents = wsService.chatMessagesToSdkEvents(draft.messages)
        }
        wsService.clearDraftCache()
    }

    private func autoEnableNewEntries() {
        guard initializedMcps else { return }
        let allNew = sdkMcpEntries + skillEntries
        guard !allNew.isEmpty else { return }
        for entry in allNew {
            enabledIds.insert(entry.id)
        }
    }

    private var heartbeatDotColor: Color {
        if let hb = wsService.activityHeartbeat {
            return hb.paused ? .yellow : .orange
        }
        return wsService.connected ? .green : .red
    }

    private func activityLabel(_ hb: ActivityHeartbeat) -> String {
        if hb.paused { return "Waiting for input" }
        switch hb.lastActivityType {
        case "text_delta": return "Streaming"
        case "thinking_delta": return "Thinking"
        case "tool_use": return "Tool: \(hb.lastToolName ?? "unknown")"
        case "tool_result": return "Processing result"
        default: return "Working"
        }
    }

    private func formatElapsed(_ ms: Double) -> String {
        let totalSeconds = Int(ms / 1000)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return "\(minutes)m \(seconds)s"
    }

    private var showExecSession: Binding<Bool> {
        Binding(
            get: { execSessionId != nil },
            set: { if !$0 { execSessionId = nil } }
        )
    }

    // MARK: - Agent Editor

    private func sendAgentEditorInitialPrompt() {
        guard !agentEditorSentInitial, let agentId = editingAgentId else { return }
        agentEditorSentInitial = true

        Task {
            // Wait for project switch to settle
            try? await Task.sleep(nanoseconds: 1_000_000_000)

            do {
                struct EditResponse: Codable { let initialPrompt: String }
                let resp: EditResponse = try await APIClient.shared.fetch(
                    path: "/api/agents/\(agentId)/edit",
                    method: "POST"
                )
                wsService.sendPrompt(resp.initialPrompt)
            } catch {
                agentEditorError = "Failed to load agent instructions"
            }
        }
    }

    private func completeAgentEditing() {
        guard let agentId = editingAgentId else { return }
        agentEditorCompleting = true

        let finalPrompt = """
        Please finalize the agent's CLAUDE.md now. Output the complete, final CLAUDE.md content wrapped in <agent-claude-md> tags. \
        Include everything we discussed — the agent's role, capabilities, constraints, and any specific instructions.
        """
        wsService.sendPrompt(finalPrompt)

        Task {
            var attempts = 0
            while attempts < 120 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                attempts += 1

                guard !wsService.isRunning else { continue }

                let allText = wsService.messages.map { $0.content }.joined(separator: "\n")
                if let extracted = extractAgentClaudeMd(from: allText) {
                    await saveAgentClaudeMd(agentId: agentId, content: extracted)
                    return
                }

                if let lastAssistant = wsService.messages.last(where: { $0.role == "assistant" }) {
                    if let extracted = extractAgentClaudeMd(from: lastAssistant.content) {
                        await saveAgentClaudeMd(agentId: agentId, content: extracted)
                        return
                    }
                }

                await MainActor.run {
                    agentEditorError = "Could not extract CLAUDE.md content. Please try again."
                    agentEditorCompleting = false
                }
                return
            }

            await MainActor.run {
                agentEditorError = "Timed out waiting for response"
                agentEditorCompleting = false
            }
        }
    }

    private func extractAgentClaudeMd(from text: String) -> String? {
        guard let startRange = text.range(of: "<agent-claude-md>"),
              let endRange = text.range(of: "</agent-claude-md>") else {
            return nil
        }
        return String(text[startRange.upperBound..<endRange.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @MainActor
    private func saveAgentClaudeMd(agentId: String, content: String) async {
        do {
            struct SaveReq: Encodable { let content: String }
            try await APIClient.shared.request(
                path: "/api/agents/\(agentId)/edit/complete",
                method: "POST",
                body: SaveReq(content: content)
            )
            dismiss()
        } catch {
            agentEditorError = "Failed to save: \(error.localizedDescription)"
            agentEditorCompleting = false
        }
    }
}

private struct BottomOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
