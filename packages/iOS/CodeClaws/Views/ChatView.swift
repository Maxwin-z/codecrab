import SwiftUI

struct ChatView: View {
    let project: Project
    @EnvironmentObject var wsService: WebSocketService
    @State private var showSidebar = false
    @State private var availableMcps: [McpInfo] = []
    @State private var enabledMcps: [String] = []
    
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
                .onChange(of: wsService.messages.count) { _ in scrollToBottom(proxy) }
                .onChange(of: wsService.streamingText) { _ in scrollToBottom(proxy) }
                .onChange(of: wsService.streamingThinking) { _ in scrollToBottom(proxy) }
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
                availableMcps: availableMcps,
                enabledMcps: enabledMcps,
                onToggleMcp: { mcpId in
                    if enabledMcps.contains(mcpId) {
                        enabledMcps.removeAll { $0 == mcpId }
                    } else {
                        enabledMcps.append(mcpId)
                    }
                }
            )
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
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
            wsService.sendPrompt(text, images: images, enabledMcps: mcps)
        }
    }

    private func fetchMcps() {
        Task {
            do {
                let mcps: [McpInfo] = try await APIClient.shared.fetch(path: "/api/mcps")
                availableMcps = mcps
                enabledMcps = mcps.map { $0.id }
            } catch {
                print("Failed to load MCPs: \(error)")
            }
        }
    }
}
