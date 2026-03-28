import SwiftUI

/// Response from POST /api/agents/:id/edit
private struct EditAgentResponse: Codable {
    let projectId: String
    let projectPath: String
    let agentId: String
    let agentName: String
    let currentClaudeMd: String
}

struct EditAgentView: View {
    let agent: Agent
    @EnvironmentObject var wsService: WebSocketService
    @Environment(\.dismiss) var dismiss

    @State private var systemProjectId: String?
    @State private var systemProjectPath: String?
    @State private var currentClaudeMd: String = ""
    @State private var isLoading = true
    @State private var isCompleting = false
    @State private var hasSentInitialPrompt = false
    @State private var isInputFocused = false
    @State private var prefillText = ""
    @State private var breathe = false
    @State private var isNearBottom = true
    @State private var isUserInteracting = false
    @State private var scrollViewHeight: CGFloat = 0
    @State private var inputAttachments: [ImageAttachment] = []
    @State private var errorMessage: String?

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if isLoading {
                    Spacer()
                    ProgressView("Connecting to editor...")
                    Spacer()
                } else {
                    messagesSection
                    bottomSection
                }
            }
            .navigationTitle("Edit \(agent.emoji) \(agent.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: completeEditing) {
                        if isCompleting {
                            ProgressView()
                        } else {
                            Text("Done")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isCompleting || isLoading)
                }
            }
            .overlay(alignment: .top) {
                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.red.cornerRadius(8))
                        .padding(.top, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .onTapGesture { errorMessage = nil }
                }
            }
        }
        .interactiveDismissDisabled(isCompleting)
        .onAppear { startEditing() }
    }

    // MARK: - Messages

    private var messagesSection: some View {
        Group {
            if wsService.messages.isEmpty && wsService.streamingText.isEmpty && !wsService.isRunning {
                VStack {
                    Spacer()
                    VStack(spacing: 12) {
                        Text("🤖")
                            .font(.system(size: 48))
                        Text("Preparing agent editor...")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
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
                            onResumeSession: { _ in }
                        )
                        .padding()

                        GeometryReader { geo in
                            Color.clear.preference(
                                key: EditAgentBottomKey.self,
                                value: geo.frame(in: .named("editAgentScroll")).minY
                            )
                        }
                        .frame(height: 1)
                        .id("EditBottom")
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 5)
                            .onChanged { _ in isUserInteracting = true }
                            .onEnded { _ in isUserInteracting = false }
                    )
                    .coordinateSpace(name: "editAgentScroll")
                    .background(
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { scrollViewHeight = geo.size.height }
                                .onChange(of: geo.size.height) { _, h in scrollViewHeight = h }
                        }
                    )
                    .onPreferenceChange(EditAgentBottomKey.self) { bottomY in
                        let nearBottom = bottomY <= scrollViewHeight + 150
                        if isUserInteracting || nearBottom {
                            isNearBottom = nearBottom
                        }
                    }
                    .onChange(of: wsService.messages.count) { scrollToBottom(proxy) }
                    .onChange(of: wsService.displayStreamingText) { scrollToBottom(proxy) }
                    .onChange(of: wsService.streamingThinking) { scrollToBottom(proxy) }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { isInputFocused = false }
    }

    // MARK: - Bottom

    @ViewBuilder
    private var bottomSection: some View {
        // Permission request
        if let pp = wsService.pendingPermission {
            PermissionRequestView(permission: pp) {
                wsService.respondToPermission(requestId: pp.requestId, allow: true)
            } onDeny: {
                wsService.respondToPermission(requestId: pp.requestId, allow: false)
            }
            .padding(.horizontal)
            .padding(.vertical, 4)
        }

        InputBarView(
            onSend: handleSend,
            onAbort: { wsService.abort() },
            onPermissionModeChange: { mode in wsService.setPermissionMode(mode) },
            isRunning: wsService.isRunning,
            isAborting: wsService.isAborting,
            currentModel: wsService.currentProviderId.isEmpty ? "Model" : wsService.currentProviderId,
            permissionMode: wsService.permissionMode,
            availableMcps: [],
            enabledMcps: [],
            onToggleMcp: { _ in },
            sdkLoaded: wsService.sdkLoaded,
            onProbeSdk: { wsService.probeSdk() },
            projectPath: systemProjectPath ?? "",
            isInputFocused: $isInputFocused,
            prefillText: $prefillText,
            externalAttachments: $inputAttachments
        )
        .padding(.horizontal)
        .padding(.top, 4)
    }

    // MARK: - Logic

    private func startEditing() {
        Task {
            do {
                let response: EditAgentResponse = try await APIClient.shared.fetch(
                    path: "/api/agents/\(agent.id)/edit",
                    method: "POST"
                )
                systemProjectId = response.projectId
                systemProjectPath = response.projectPath
                currentClaudeMd = response.currentClaudeMd

                // Switch to system-agent project
                wsService.switchProject(
                    projectId: response.projectId,
                    cwd: response.projectPath,
                    name: "Agent Editor",
                    icon: "🤖"
                )
                wsService.newChat()

                isLoading = false

                // Send initial prompt after a brief delay
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    sendInitialPrompt()
                }
            } catch {
                errorMessage = "Failed to start editing: \(error.localizedDescription)"
                isLoading = false
            }
        }
    }

    private func sendInitialPrompt() {
        guard !hasSentInitialPrompt else { return }
        hasSentInitialPrompt = true

        let prompt: String
        if currentClaudeMd.isEmpty {
            prompt = """
            I want to create a new agent called "\(agent.name)". This agent doesn't have any instructions yet. \
            Please help me define what this agent should do. Ask me about its purpose, target tasks, and any specific requirements.
            """
        } else {
            prompt = """
            I want to edit the agent "\(agent.name)". Here is its current CLAUDE.md:

            ```
            \(currentClaudeMd)
            ```

            Please help me refine or update these instructions. What would you like to change?
            """
        }

        wsService.sendPrompt(prompt)
    }

    @discardableResult
    private func handleSend(text: String, images: [ImageAttachment]?, mcps: [String]?) -> Bool {
        isNearBottom = true
        isInputFocused = false
        return wsService.sendPrompt(text, images: images)
    }

    private func completeEditing() {
        isCompleting = true

        // Send finalization prompt
        let finalPrompt = """
        Please finalize the agent's CLAUDE.md now. Output the complete, final CLAUDE.md content wrapped in <agent-claude-md> tags. \
        Include everything we discussed — the agent's role, capabilities, constraints, and any specific instructions.
        """
        wsService.sendPrompt(finalPrompt)

        // Watch for the response to extract CLAUDE.md content
        watchForCompletion()
    }

    private func watchForCompletion() {
        // Poll for the result in the streaming text or messages
        Task {
            // Wait for the AI to finish responding
            var attempts = 0
            while attempts < 120 { // max 2 minutes
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
                attempts += 1

                // Check if done streaming
                if !wsService.isRunning && hasSentInitialPrompt {
                    // Look for <agent-claude-md> in the latest messages
                    let allText = wsService.messages.map { $0.content }.joined(separator: "\n")
                    if let extracted = extractClaudeMd(from: allText) {
                        await saveAndDismiss(content: extracted)
                        return
                    }

                    // If no tags found, try the last assistant message
                    if let lastAssistant = wsService.messages.last(where: { $0.role == "assistant" }) {
                        if let extracted = extractClaudeMd(from: lastAssistant.content) {
                            await saveAndDismiss(content: extracted)
                            return
                        }
                    }

                    // Couldn't extract, show error
                    await MainActor.run {
                        errorMessage = "Could not extract CLAUDE.md content. Please try again."
                        isCompleting = false
                    }
                    return
                }
            }

            // Timeout
            await MainActor.run {
                errorMessage = "Timed out waiting for response"
                isCompleting = false
            }
        }
    }

    private func extractClaudeMd(from text: String) -> String? {
        guard let startRange = text.range(of: "<agent-claude-md>"),
              let endRange = text.range(of: "</agent-claude-md>") else {
            return nil
        }
        let content = String(text[startRange.upperBound..<endRange.lowerBound])
        return content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @MainActor
    private func saveAndDismiss(content: String) async {
        do {
            struct SaveReq: Encodable { let content: String }
            let req = SaveReq(content: content)
            try await APIClient.shared.request(
                path: "/api/agents/\(agent.id)/edit/complete",
                method: "POST",
                body: req
            )
            dismiss()
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
            isCompleting = false
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard force || (isNearBottom && !isUserInteracting) else { return }
        if force {
            withAnimation { proxy.scrollTo("EditBottom", anchor: .bottom) }
        } else {
            proxy.scrollTo("EditBottom", anchor: .bottom)
        }
    }
}

private struct EditAgentBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
