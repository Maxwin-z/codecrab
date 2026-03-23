import SwiftUI
import Combine

/// A single cell within the grid layout.
/// Shows content based on its CellContent, with activation highlight and close button.
struct GridCellView: View {
    let cellIndex: Int
    @ObservedObject var gridManager: GridLayoutManager
    @EnvironmentObject var wsService: WebSocketService
    @Binding var shareAttachments: [ImageAttachment]
    @Binding var shareSessionId: String?

    private var cellState: GridCellState {
        guard cellIndex < gridManager.cells.count else {
            return GridCellState(id: cellIndex)
        }
        return gridManager.cells[cellIndex]
    }

    private var isActive: Bool {
        cellIndex < gridManager.cells.count && gridManager.activeCellIndex == cellIndex
    }

    private var isExpanded: Bool {
        gridManager.expandedCellIndex == cellIndex
    }

    private var showChrome: Bool {
        !gridManager.isSingleLayout && !isExpanded
    }

    var body: some View {
        VStack(spacing: 0) {
            if showChrome {
                cellHeader
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            gridManager.expandCell(at: cellIndex)
                        }
                    }
                    .onTapGesture {
                        gridManager.activateCell(at: cellIndex)
                    }
            }
            cellContent
                .simultaneousGesture(
                    TapGesture().onEnded {
                        if showChrome {
                            gridManager.activateCell(at: cellIndex)
                        }
                    }
                )
        }
        .clipShape(RoundedRectangle(cornerRadius: showChrome ? 10 : 0))
        .overlay(
            RoundedRectangle(cornerRadius: showChrome ? 10 : 0)
                .stroke(isActive && showChrome ? Color.accentColor : Color.gray.opacity(showChrome ? 0.3 : 0), lineWidth: isActive && showChrome ? 2 : 0.5)
        )
    }

    // MARK: - Header Bar

    private var cellHeader: some View {
        HStack(spacing: 6) {
            // Back button (when in chat)
            if case .chat = cellState.content {
                Button {
                    gridManager.navigateBack(inCell: cellIndex)
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            // Content label
            Text(cellState.content.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(isActive ? .primary : .secondary)
                .lineLimit(1)

            Spacer()

            // Active indicator
            if isActive {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
            }

            // Close button (only for non-empty cells)
            if cellState.content != .empty {
                Button {
                    gridManager.closeCell(at: cellIndex)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(4)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(isActive ? Color.accentColor.opacity(0.08) : Color(uiColor: .secondarySystemBackground))
    }

    // MARK: - Content

    @ViewBuilder
    private var cellContent: some View {
        switch cellState.content {
        case .empty:
            emptyPlaceholder
        case .soul:
            SoulPageView()
        case .cron:
            CronPageView()
        case .projectSessions(let project):
            GridSessionListView(
                project: project,
                cellIndex: cellIndex,
                gridManager: gridManager
            )
        case .chat(let route):
            GridChatWrapper(
                route: route,
                cellIndex: cellIndex,
                isActiveCell: isActive,
                gridManager: gridManager,
                shareAttachments: $shareAttachments,
                shareSessionId: $shareSessionId
            )
        }
    }

    private var emptyPlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "plus.rectangle.on.rectangle")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text("Select content from sidebar")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Grid Session List (embedded, no NavigationStack)

/// A simplified session list for use inside grid cells.
/// Tapping a session navigates within the grid cell instead of pushing a NavigationStack.
struct GridSessionListView: View {
    let project: Project
    let cellIndex: Int
    @ObservedObject var gridManager: GridLayoutManager
    @EnvironmentObject var wsService: WebSocketService

    @State private var sessions: [SessionInfo] = []
    @State private var isLoading = false
    @State private var now = Date()

    let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    let refreshTimer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        List {
            if isLoading && sessions.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else if sessions.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 36))
                        .foregroundColor(.secondary.opacity(0.3))
                    Text("No sessions")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 30)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                // New session button
                Button {
                    gridManager.navigateToChat(
                        ChatRoute(project: project, sessionId: nil),
                        inCell: cellIndex
                    )
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 14))
                        Text("New Session")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(Color.accentColor)
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)

                ForEach(sessions) { session in
                    let isProcessing = isSessionProcessing(session)
                    let isRecentlyActive = !isProcessing &&
                        (Date().timeIntervalSince1970 * 1000 - session.lastModified) < 600_000

                    Button {
                        gridManager.navigateToChat(
                            ChatRoute(project: project, sessionId: session.sessionId),
                            inCell: cellIndex
                        )
                    } label: {
                        SessionRowView(session: session, now: now, isProcessing: isProcessing, isRecentlyActive: isRecentlyActive)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.plain)
        .task { await fetchSessions() }
        .refreshable { await fetchSessions() }
        .onReceive(timer) { _ in now = Date() }
        .onReceive(refreshTimer) { _ in Task { await fetchSessions(silent: true) } }
    }

    private func isSessionProcessing(_ session: SessionInfo) -> Bool {
        let projectIsRunning = wsService.runningProjectIds.contains(project.id)
        let wsProcessingSessionId = wsService.projectStatuses.first(where: {
            $0.projectId == project.id && $0.status == "processing"
        })?.sessionId

        return session.status == "processing" ||
            (wsProcessingSessionId != nil && wsProcessingSessionId == session.sessionId) ||
            (projectIsRunning && wsProcessingSessionId == nil && session.sessionId == sessions.first?.sessionId)
    }

    private func fetchSessions(silent: Bool = false) async {
        if !silent { isLoading = true }
        do {
            let fetched: [SessionInfo] = try await APIClient.shared.fetch(path: "/api/sessions?projectId=\(project.id)")
            self.sessions = fetched.sorted { $0.lastModified > $1.lastModified }
        } catch {
            print("Failed to fetch sessions: \(error)")
        }
        if !silent { isLoading = false }
    }
}

// MARK: - Grid Chat Wrapper

/// Wraps ChatView for grid cells. Connects to WebSocket only when the cell is active.
/// When a cell is inactive, it displays a cached snapshot of its last state so that
/// multiple cells can show different projects' chats simultaneously.
struct GridChatWrapper: View {
    let route: ChatRoute
    let cellIndex: Int
    let isActiveCell: Bool
    @ObservedObject var gridManager: GridLayoutManager
    @EnvironmentObject var wsService: WebSocketService
    @Binding var shareAttachments: [ImageAttachment]
    @Binding var shareSessionId: String?

    // Cached state for inactive display
    @State private var cachedMessages: [ChatMessage] = []
    @State private var cachedStreamingText: String = ""
    @State private var cachedStreamingThinking: String = ""
    @State private var cachedSdkEvents: [SdkEvent] = []
    @State private var cachedIsRunning: Bool = false
    @State private var hasBeenActivated: Bool = false

    var body: some View {
        Group {
            if isActiveCell {
                ChatView(
                    project: route.project,
                    initialSessionId: route.sessionId,
                    pendingAttachments: $shareAttachments,
                    pendingSessionId: $shareSessionId,
                    autoConnect: false
                )
            } else if hasBeenActivated {
                InactiveChatContentView(
                    project: route.project,
                    messages: cachedMessages,
                    streamingText: cachedStreamingText,
                    streamingThinking: cachedStreamingThinking,
                    sdkEvents: cachedSdkEvents,
                    isRunning: cachedIsRunning
                )
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 28))
                        .foregroundStyle(.tertiary)
                    Text("Tap to start chatting")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            if isActiveCell {
                hasBeenActivated = true
                switchToThisSession()
            }
        }
        .onChange(of: isActiveCell) { wasActive, nowActive in
            if wasActive && !nowActive {
                // Becoming inactive: capture snapshot of current state
                cacheCurrentState()
            }
            if nowActive {
                hasBeenActivated = true
                // Defer to ensure sibling cells have cached their state first
                DispatchQueue.main.async {
                    switchToThisSession()
                }
            }
        }
    }

    private func cacheCurrentState() {
        cachedMessages = wsService.messages
        cachedStreamingText = wsService.displayStreamingText
        cachedStreamingThinking = wsService.streamingThinking
        cachedSdkEvents = wsService.sdkEvents
        cachedIsRunning = wsService.isRunning
    }

    private func switchToThisSession() {
        wsService.switchProject(projectId: route.project.id, cwd: route.project.path, name: route.project.name, icon: route.project.icon)
        if let sessionId = route.sessionId {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                wsService.resumeSession(sessionId)
            }
        } else {
            wsService.newChat()
        }
    }
}

// MARK: - Inactive Chat Content View

/// Read-only view of a chat cell's cached state, shown when the cell is not active.
/// Displays the messages snapshot without interactive controls.
struct InactiveChatContentView: View {
    let project: Project
    let messages: [ChatMessage]
    let streamingText: String
    let streamingThinking: String
    let sdkEvents: [SdkEvent]
    let isRunning: Bool

    var body: some View {
        VStack(spacing: 0) {
            if messages.isEmpty && streamingText.isEmpty && streamingThinking.isEmpty && !isRunning {
                VStack {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 28))
                            .foregroundStyle(.tertiary)
                        Text("Tap to continue chatting")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                }
            } else {
                ScrollView {
                    MessageListView(
                        messages: messages,
                        streamingText: streamingText,
                        streamingThinking: streamingThinking,
                        isRunning: isRunning,
                        sdkEvents: sdkEvents
                    )
                    .padding()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
