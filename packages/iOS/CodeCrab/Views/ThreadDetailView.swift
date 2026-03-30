import SwiftUI

struct ThreadDetailView: View {
    let threadId: String
    @EnvironmentObject var wsService: WebSocketService
    @State private var restMessages: [ThreadMessageInfo] = []
    @State private var artifacts: [ThreadArtifactInfo] = []
    @State private var selectedTab: Tab = .messages
    @State private var showConfig = false
    @State private var maxTurnsText = ""
    @State private var isCompleting = false

    enum Tab: String, CaseIterable {
        case messages = "Messages"
        case artifacts = "Artifacts"
    }

    private var thread: ThreadInfo? {
        wsService.threads[threadId]
    }

    private var mergedMessages: [ThreadMessageInfo] {
        var map: [String: ThreadMessageInfo] = [:]
        for m in restMessages { map[m.id] = m }
        for m in (thread?.messages ?? []) { map[m.id] = m }
        return Array(map.values).sorted { $0.timestamp < $1.timestamp }
    }

    var body: some View {
        Group {
            if let thread = thread {
                VStack(spacing: 0) {
                    threadHeader(thread)
                    tabBar
                    Divider()
                    tabContent
                }
            } else {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Loading thread...")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            }
        }
        .navigationTitle(thread?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadData()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private func threadHeader(_ thread: ThreadInfo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Participants
            if !thread.participants.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(thread.participants) { p in
                            Text("@\(p.agentName)")
                                .font(.caption)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color(UIColor.tertiarySystemFill))
                                .cornerRadius(6)
                        }
                    }
                }
            }

            // Stalled reason
            if thread.status == "stalled", let reason = thread.stalledReason {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundColor(.orange)
                    Text(reason)
                        .font(.caption)
                        .foregroundColor(.orange)
                }
            }

            // Actions
            HStack(spacing: 8) {
                if thread.status == "active" {
                    Button {
                        Task { await completeThread() }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle")
                                .font(.caption)
                            Text("Complete")
                                .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color(UIColor.tertiarySystemFill))
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                    .disabled(isCompleting)
                }

                Button {
                    withAnimation { showConfig.toggle() }
                } label: {
                    Image(systemName: "gearshape")
                        .font(.caption)
                        .padding(6)
                        .background(Color(UIColor.tertiarySystemFill))
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)

                Spacer()

                ThreadStatusBadge(status: thread.status)
            }

            if showConfig {
                HStack(spacing: 8) {
                    TextField("Max turns", text: $maxTurnsText)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 100)
                        .font(.caption)

                    Button("Save") {
                        Task { await updateConfig() }
                    }
                    .font(.caption.weight(.medium))
                    .disabled(maxTurnsText.isEmpty)

                    Button("Cancel") {
                        withAnimation { showConfig = false }
                        maxTurnsText = ""
                    }
                    .font(.caption)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(UIColor.secondarySystemBackground))
    }

    // MARK: - Tab Bar

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedTab = tab }
                } label: {
                    VStack(spacing: 4) {
                        Text(tabLabel(tab))
                            .font(.caption.weight(.medium))
                            .foregroundColor(selectedTab == tab ? .primary : .secondary)
                        Rectangle()
                            .fill(selectedTab == tab ? Color.accentColor : Color.clear)
                            .frame(height: 2)
                    }
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 16)
    }

    private func tabLabel(_ tab: Tab) -> String {
        switch tab {
        case .messages: return "Messages (\(mergedMessages.count))"
        case .artifacts: return "Artifacts (\(artifacts.count))"
        }
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .messages:
            messagesContent
        case .artifacts:
            artifactsContent
        }
    }

    private var messagesContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    if mergedMessages.isEmpty {
                        emptyState(icon: "message", text: "No messages yet")
                    } else {
                        ForEach(mergedMessages) { msg in
                            ThreadMessageBubble(message: msg)
                                .id(msg.id)
                        }
                    }
                }
                .padding(12)
            }
            .onChange(of: mergedMessages.count) { _, _ in
                if let lastId = mergedMessages.last?.id {
                    withAnimation {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var artifactsContent: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                if artifacts.isEmpty {
                    emptyState(icon: "doc", text: "No artifacts")
                } else {
                    ForEach(artifacts) { artifact in
                        ArtifactRow(artifact: artifact)
                    }
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private func emptyState(icon: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 32))
                .foregroundColor(.gray.opacity(0.4))
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    // MARK: - Actions

    private func loadData() async {
        async let messagesTask: () = loadMessages()
        async let artifactsTask: () = loadArtifacts()
        _ = await (messagesTask, artifactsTask)
    }

    private func loadMessages() async {
        do {
            let response: ThreadMessagesResponse = try await APIClient.shared.fetch(
                path: "/api/threads/\(threadId)/messages?limit=100"
            )
            restMessages = response.messages
        } catch {
            print("[ThreadDetailView] Failed to fetch messages: \(error)")
        }
    }

    private func loadArtifacts() async {
        do {
            let response: ThreadArtifactsResponse = try await APIClient.shared.fetch(
                path: "/api/threads/\(threadId)/artifacts"
            )
            artifacts = response.artifacts
        } catch {
            print("[ThreadDetailView] Failed to fetch artifacts: \(error)")
        }
    }

    private func completeThread() async {
        isCompleting = true
        do {
            try await APIClient.shared.request(
                path: "/api/threads/\(threadId)/complete",
                method: "POST"
            )
        } catch {
            print("[ThreadDetailView] Failed to complete thread: \(error)")
        }
        isCompleting = false
    }

    private func updateConfig() async {
        guard let turns = Int(maxTurnsText), turns > 0 else { return }
        do {
            struct ConfigReq: Encodable { let maxTurns: Int }
            try await APIClient.shared.request(
                path: "/api/threads/\(threadId)/config",
                method: "PATCH",
                body: ConfigReq(maxTurns: turns)
            )
            withAnimation { showConfig = false }
            maxTurnsText = ""
        } catch {
            print("[ThreadDetailView] Failed to update config: \(error)")
        }
    }
}

// MARK: - Message Bubble

private struct ThreadMessageBubble: View {
    let message: ThreadMessageInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header
            HStack {
                Text("@\(message.from)")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.primary)
                Image(systemName: "arrow.right")
                    .font(.system(size: 8))
                    .foregroundColor(.secondary)
                Text(message.to == "broadcast" ? "all" : "@\(message.to)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text(formatTime(message.timestamp))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            // Content
            Text(message.content)
                .font(.subheadline)
                .textSelection(.enabled)

            // Artifacts
            if !message.artifacts.isEmpty {
                HStack(spacing: 6) {
                    ForEach(message.artifacts, id: \.id) { artifact in
                        HStack(spacing: 4) {
                            Image(systemName: "doc")
                                .font(.caption2)
                            Text(artifact.name)
                                .font(.caption2)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color(UIColor.tertiarySystemFill))
                        .cornerRadius(4)
                    }
                }
            }
        }
        .padding(10)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(10)
    }

    private func formatTime(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
        } else {
            formatter.dateFormat = "MMM d, HH:mm"
        }
        return formatter.string(from: date)
    }
}

// MARK: - Artifact Row

private struct ArtifactRow: View {
    let artifact: ThreadArtifactInfo

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconForMimeType(artifact.mimeType))
                .font(.body)
                .foregroundColor(.secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(artifact.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(artifact.mimeType)
                    Text("·")
                    Text(formatBytes(artifact.size))
                    Text("·")
                    Text("by @\(artifact.createdBy.agentName)")
                }
                .font(.caption2)
                .foregroundColor(.secondary)
            }

            Spacer()
        }
        .padding(10)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(8)
    }

    private func iconForMimeType(_ mimeType: String) -> String {
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("text/") { return "doc.text" }
        if mimeType.contains("pdf") { return "doc.richtext" }
        if mimeType.contains("json") { return "curlybraces" }
        return "doc"
    }

    private func formatBytes(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }
}
