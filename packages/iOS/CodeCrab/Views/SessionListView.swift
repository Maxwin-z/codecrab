import SwiftUI
import Combine

/// Route for programmatic navigation to ChatView
struct ChatRoute: Hashable {
    let project: Project
    let sessionId: String?
}

struct SessionListView: View {
    let project: Project
    @EnvironmentObject var wsService: WebSocketService

    @State private var sessions: [SessionInfo] = []
    @State private var isLoading = false
    @State private var now = Date()

    let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    let refreshTimer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        List {
            // Sessions
            if isLoading && sessions.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding(.top, 20)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else if sessions.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary.opacity(0.3))
                    Text("No sessions yet")
                        .font(.headline)
                        .foregroundColor(.secondary)
                    Text("Start a new chat to begin")
                        .font(.subheadline)
                        .foregroundColor(.secondary.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                ForEach(sessions) { session in
                    NavigationLink(value: ChatRoute(project: project, sessionId: session.sessionId)) {
                        SessionRowView(session: session, now: now)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("\(project.icon) \(project.name)")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: ChatRoute(project: project, sessionId: nil)) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 16))
                }
            }
        }
        .refreshable {
            await fetchSessions()
        }
        .task {
            await fetchSessions()
        }
        .onReceive(timer) { _ in
            now = Date()
        }
        .onReceive(refreshTimer) { _ in
            Task { await fetchSessions(silent: true) }
        }
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

// MARK: - Session Row

struct SessionRowView: View {
    let session: SessionInfo
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            if session.isCron {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.system(size: 16))
                    .foregroundColor(.purple)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if session.isCron {
                        Text(session.cronJobName ?? "Scheduled")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.purple)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.purple.opacity(0.12))
                            .cornerRadius(4)
                    }

                    Text(session.summary.isEmpty ? (session.firstPrompt ?? "Untitled session") : session.summary)
                        .font(.headline)
                        .lineLimit(1)
                        .foregroundColor(.primary)
                }

                HStack {
                    Text(TimeAgo.format(from: session.lastModified, now: now))
                    Text("•")
                    Text(String(session.sessionId.suffix(6)))
                        .fontDesign(.monospaced)
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }

            Spacer()

            if session.status == "processing" {
                Circle().fill(Color.orange).frame(width: 8, height: 8)
            } else if session.status == "error" {
                Circle().fill(Color.red).frame(width: 8, height: 8)
            } else {
                Circle().fill(session.isCron ? Color.purple.opacity(0.5) : Color.gray.opacity(0.3)).frame(width: 8, height: 8)
            }
        }
        .padding(.vertical, 4)
    }
}
