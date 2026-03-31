import SwiftUI
import QuickLook
import Textual

struct ThreadDetailView: View {
    let threadId: String
    @EnvironmentObject var wsService: WebSocketService
    @State private var restMessages: [ThreadMessageInfo] = []
    @State private var artifacts: [ThreadArtifactInfo] = []
    @State private var agents: [Agent] = []
    @State private var isLoading = true
    @State private var renderMarkdown = true

    private var thread: ThreadInfo? {
        wsService.threads[threadId]
    }

    private var mergedMessages: [ThreadMessageInfo] {
        var map: [String: ThreadMessageInfo] = [:]
        for m in restMessages { map[m.id] = m }
        for m in (thread?.messages ?? []) { map[m.id] = m }
        return Array(map.values).sorted { $0.timestamp < $1.timestamp }
    }

    /// Lookup agent emoji by name (lowercased for case-insensitive matching)
    private var agentEmojiMap: [String: String] {
        Dictionary(agents.map { ($0.name.lowercased(), $0.emoji) }, uniquingKeysWith: { _, last in last })
    }

    private var statusEmoji: String {
        switch thread?.status {
        case "active": return "🟢"
        case "completed": return "✅"
        case "stalled": return "🟠"
        default: return ""
        }
    }

    var body: some View {
        Group {
            if mergedMessages.isEmpty && isLoading {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Loading thread...")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                messagesContent
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 4) {
                    Text(thread?.title ?? "Thread")
                        .font(.headline)
                        .lineLimit(1)
                    Text(statusEmoji)
                        .font(.system(size: 12))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button {
                        renderMarkdown.toggle()
                    } label: {
                        Image(systemName: renderMarkdown ? "doc.richtext" : "doc.plaintext")
                            .font(.subheadline)
                    }

                    if !artifacts.isEmpty {
                        NavigationLink {
                            ThreadArtifactsListView(artifacts: artifacts, threadId: threadId)
                        } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "paperclip")
                                    .font(.subheadline)
                                Text("\(artifacts.count)")
                                    .font(.caption.weight(.medium))
                            }
                        }
                    }
                }
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .task {
            loadCache()
            await fetchRemote()
        }
    }

    // MARK: - Messages

    private var messagesContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    if mergedMessages.isEmpty {
                        emptyState(icon: "message", text: "No messages yet")
                    } else {
                        ForEach(Array(mergedMessages.enumerated()), id: \.element.id) { index, msg in
                            let prevMsg = index > 0 ? mergedMessages[index - 1] : nil
                            let showDateSeparator = shouldShowDateSeparator(current: msg, previous: prevMsg)
                            let showAvatar = prevMsg?.from != msg.from || showDateSeparator

                            if showDateSeparator {
                                dateSeparator(timestamp: msg.timestamp)
                                    .padding(.vertical, 8)
                            }

                            ChatBubbleRow(
                                message: msg,
                                emoji: agentEmojiMap[msg.from.lowercased()] ?? "🤖",
                                showAvatar: showAvatar,
                                renderMarkdown: renderMarkdown
                            )
                            .id(msg.id)
                        }
                    }
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
            }
            .background(Color(UIColor.systemBackground))
            .onChange(of: mergedMessages.count) { _, _ in
                if let lastId = mergedMessages.last?.id {
                    withAnimation {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func shouldShowDateSeparator(current: ThreadMessageInfo, previous: ThreadMessageInfo?) -> Bool {
        guard let prev = previous else { return true }
        let currentDate = Date(timeIntervalSince1970: current.timestamp / 1000)
        let prevDate = Date(timeIntervalSince1970: prev.timestamp / 1000)
        return !Calendar.current.isDate(currentDate, inSameDayAs: prevDate)
    }

    private func dateSeparator(timestamp: Double) -> some View {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let text: String = {
            if Calendar.current.isDateInToday(date) {
                return "Today"
            } else if Calendar.current.isDateInYesterday(date) {
                return "Yesterday"
            } else {
                let fmt = DateFormatter()
                fmt.dateFormat = "MMM d, yyyy"
                return fmt.string(from: date)
            }
        }()
        return Text(text)
            .font(.caption2.weight(.medium))
            .foregroundColor(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(Color(UIColor.tertiarySystemFill))
            .cornerRadius(8)
            .frame(maxWidth: .infinity)
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

    // MARK: - Data Loading

    private func loadCache() {
        if let cached = ThreadDetailCache.loadMessages(threadId: threadId), !cached.isEmpty {
            restMessages = cached
        }
        if let cached = ThreadDetailCache.loadArtifacts(threadId: threadId), !cached.isEmpty {
            artifacts = cached
        }
        if let cached = ThreadDetailCache.loadAgents(), !cached.isEmpty {
            agents = cached
        }
    }

    private func fetchRemote() async {
        async let messagesTask: () = fetchMessages()
        async let artifactsTask: () = fetchArtifacts()
        async let agentsTask: () = fetchAgents()
        _ = await (messagesTask, artifactsTask, agentsTask)
        isLoading = false
    }

    private func fetchMessages() async {
        do {
            let response: ThreadMessagesResponse = try await APIClient.shared.fetch(
                path: "/api/threads/\(threadId)/messages?limit=100"
            )
            restMessages = response.messages
            ThreadDetailCache.saveMessages(response.messages, threadId: threadId)
        } catch {
            print("[ThreadDetailView] Failed to fetch messages: \(error)")
        }
    }

    private func fetchArtifacts() async {
        do {
            let response: ThreadArtifactsResponse = try await APIClient.shared.fetch(
                path: "/api/threads/\(threadId)/artifacts"
            )
            artifacts = response.artifacts
            ThreadDetailCache.saveArtifacts(response.artifacts, threadId: threadId)
        } catch {
            print("[ThreadDetailView] Failed to fetch artifacts: \(error)")
        }
    }

    private func fetchAgents() async {
        do {
            let fetched: [Agent] = try await APIClient.shared.fetch(path: "/api/agents")
            agents = fetched
            ThreadDetailCache.saveAgents(fetched)
        } catch {
            print("[ThreadDetailView] Failed to fetch agents: \(error)")
        }
    }
}

// MARK: - Artifacts List View (push destination)

struct ThreadArtifactsListView: View {
    let artifacts: [ThreadArtifactInfo]
    let threadId: String
    @State private var previewURL: URL?
    @State private var downloadingId: String?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(artifacts) { artifact in
                    Button {
                        Task { await downloadAndPreview(artifact) }
                    } label: {
                        ArtifactRow(artifact: artifact, isDownloading: downloadingId == artifact.id)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
        }
        .navigationTitle("Artifacts")
        .navigationBarTitleDisplayMode(.inline)
        .quickLookPreview($previewURL)
    }

    private func downloadAndPreview(_ artifact: ThreadArtifactInfo) async {
        guard downloadingId == nil else { return }
        downloadingId = artifact.id
        defer { downloadingId = nil }

        do {
            let data = try await APIClient.shared.fetchData(
                path: "/api/threads/\(threadId)/artifacts/\(artifact.id)/raw"
            )
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("artifacts", isDirectory: true)
            try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let fileURL = tmp.appendingPathComponent(artifact.name)
            try data.write(to: fileURL)
            previewURL = fileURL
        } catch {
            print("[ArtifactPreview] Failed to download: \(error)")
        }
    }
}

// MARK: - Artifact Row

private struct ArtifactRow: View {
    let artifact: ThreadArtifactInfo
    var isDownloading: Bool = false

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

            if isDownloading {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
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

// MARK: - Chat Bubble Row (WeChat-style)

private struct ChatBubbleRow: View {
    let message: ThreadMessageInfo
    let emoji: String
    let showAvatar: Bool
    var renderMarkdown: Bool = true

    /// Stable color derived from agent name
    private var avatarBackground: Color {
        let colors: [Color] = [
            .blue.opacity(0.15), .purple.opacity(0.15), .green.opacity(0.15),
            .orange.opacity(0.15), .pink.opacity(0.15), .teal.opacity(0.15),
            .indigo.opacity(0.15), .mint.opacity(0.15)
        ]
        let hash = abs(message.from.hashValue)
        return colors[hash % colors.count]
    }

    @Environment(\.colorScheme) private var colorScheme

    private var bubbleBackground: Color {
        let hash = abs(message.from.hashValue)
        let baseColors: [(r: Double, g: Double, b: Double)] = [
            (0.40, 0.60, 1.00), // blue
            (0.65, 0.40, 1.00), // purple
            (0.30, 0.75, 0.45), // green
            (1.00, 0.70, 0.30), // orange
            (1.00, 0.45, 0.60), // pink
            (0.20, 0.75, 0.75), // teal
            (0.50, 0.40, 0.90), // indigo
            (0.30, 0.80, 0.70), // mint
        ]
        let c = baseColors[hash % baseColors.count]
        let opacity = colorScheme == .dark ? 0.15 : 0.12
        return Color(red: c.r, green: c.g, blue: c.b).opacity(opacity)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Avatar column (fixed width for alignment)
            if showAvatar {
                Text(emoji)
                    .font(.system(size: 22))
                    .frame(width: 36, height: 36)
                    .background(avatarBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                Color.clear
                    .frame(width: 36, height: 36)
            }

            // Message content
            VStack(alignment: .leading, spacing: 3) {
                // Agent name + recipient + time
                if showAvatar {
                    HStack(spacing: 4) {
                        Text(message.from)
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.primary)

                        if message.to != "broadcast" {
                            Image(systemName: "arrow.right")
                                .font(.system(size: 7, weight: .bold))
                                .foregroundColor(.secondary.opacity(0.6))
                            Text(message.to)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        Text(formatTime(message.timestamp))
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.7))
                    }
                }

                // Chat bubble
                VStack(alignment: .leading, spacing: 6) {
                    if renderMarkdown {
                        StructuredText(markdown: message.content)
                            .textual.structuredTextStyle(.gitHub)
                            .textual.textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(message.content)
                            .font(.subheadline)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    // Inline artifacts
                    if !message.artifacts.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(message.artifacts, id: \.id) { artifact in
                                HStack(spacing: 4) {
                                    Image(systemName: "paperclip")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                    Text(artifact.name)
                                        .font(.caption2)
                                        .foregroundColor(.primary.opacity(0.8))
                                        .lineLimit(1)
                                }
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Color(UIColor.systemBackground).opacity(0.6))
                                .cornerRadius(4)
                            }
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(bubbleBackground)
                .clipShape(BubbleShape(showTail: showAvatar))
            }

            Spacer(minLength: 40)
        }
        .padding(.top, showAvatar ? 6 : 0)
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

// MARK: - Bubble Shape

/// Chat bubble with a small top-left corner (tail pointing to avatar) and rounded other corners
private struct BubbleShape: Shape {
    let showTail: Bool

    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 12     // normal corner radius
        let tr: CGFloat = showTail ? 2 : 12  // top-left corner (small when showing tail)

        var path = Path()
        // Start from top-left
        path.move(to: CGPoint(x: rect.minX + tr, y: rect.minY))
        // Top edge → top-right corner
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r),
                     radius: r, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        // Right edge → bottom-right corner
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r),
                     radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        // Bottom edge → bottom-left corner
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r),
                     radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        // Left edge → top-left corner
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + tr))
        path.addArc(center: CGPoint(x: rect.minX + tr, y: rect.minY + tr),
                     radius: tr, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.closeSubpath()
        return path
    }
}
