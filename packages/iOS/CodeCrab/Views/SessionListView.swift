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
    @Environment(\.scenePhase) private var scenePhase

    @State private var sessions: [SessionInfo] = []
    @State private var isLoading = false
    @State private var now = Date()
    @State private var providerNames: [String: String] = [:]

    let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    let refreshTimer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

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
                    let projectIsRunning = wsService.runningProjectIds.contains(project.id)
                    let wsProcessingSessionId = wsService.projectStatuses.first(where: {
                        $0.projectId == project.id && $0.status == "processing"
                    })?.sessionId

                    // Processing: WS identifies this session, or project is running
                    // and WS doesn't specify which session so use the most recent one
                    let isProcessing = session.status == "processing" ||
                        (wsProcessingSessionId != nil && wsProcessingSessionId == session.sessionId) ||
                        (projectIsRunning && wsProcessingSessionId == nil && session.sessionId == sessions.first?.sessionId)

                    // Active: recently modified within 10 minutes (same threshold as ProjectCard)
                    let isRecentlyActive = !isProcessing &&
                        (Date().timeIntervalSince1970 * 1000 - session.lastModified) < 600_000

                    NavigationLink(value: ChatRoute(project: project, sessionId: session.sessionId)) {
                        SessionRowView(session: session, now: now, isProcessing: isProcessing, isRecentlyActive: isRecentlyActive, providerName: session.providerId.flatMap { providerNames[$0] })
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
            await fetchProviders()
        }
        .onReceive(timer) { _ in
            now = Date()
        }
        .onReceive(refreshTimer) { _ in
            Task { await fetchSessions(silent: true) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await fetchSessions(silent: true) }
            }
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

    private func fetchProviders() async {
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
                  let providers = json["providers"] as? [[String: Any]] else { return }
            var names: [String: String] = [:]
            for provider in providers {
                if let id = provider["id"] as? String, let name = provider["name"] as? String {
                    names[id] = name
                }
            }
            self.providerNames = names
        } catch {
            print("Failed to fetch providers: \(error)")
        }
    }
}

// MARK: - Session Row

struct SessionRowView: View {
    let session: SessionInfo
    let now: Date
    var isProcessing: Bool = false
    var isRecentlyActive: Bool = false
    var providerName: String? = nil

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
                    if let name = providerName {
                        Text("·")
                        Text(name)
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }

            Spacer()

            if isProcessing {
                Circle().fill(Color.orange).frame(width: 8, height: 8)
            } else if session.status == "error" {
                Circle().fill(Color.red).frame(width: 8, height: 8)
            } else if isRecentlyActive {
                Circle().fill(Color.green).frame(width: 8, height: 8)
            } else {
                Circle().fill(session.isCron ? Color.purple.opacity(0.5) : Color.gray.opacity(0.3)).frame(width: 8, height: 8)
            }
        }
        .padding(.vertical, 4)
    }
}
