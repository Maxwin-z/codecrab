import SwiftUI

/// What the detail column shows
enum DetailDestination: Hashable {
    case project(Project)
    case soul
    case cron

    static func == (lhs: DetailDestination, rhs: DetailDestination) -> Bool {
        switch (lhs, rhs) {
        case (.project(let a), .project(let b)): return a.id == b.id
        case (.soul, .soul): return true
        case (.cron, .cron): return true
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case .project(let p):
            hasher.combine(0)
            hasher.combine(p)
        case .soul:
            hasher.combine(1)
        case .cron:
            hasher.combine(2)
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var wsService: WebSocketService
    @EnvironmentObject var shareHandler: ShareHandler
    @ObservedObject private var pushService = PushNotificationService.shared

    @State private var detailDestination: DetailDestination?
    @State private var detailPath = NavigationPath()
    @State private var showCreate = false
    @State private var showSettings = false
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var projects: [Project] = []
    @State private var toastData: PushToastData? = nil
    @State private var shareAttachments: [ImageAttachment] = []
    @State private var shareSessionId: String? = nil

    var body: some View {
        ZStack {
            NavigationSplitView(columnVisibility: $columnVisibility) {
                ProjectListView(selection: $detailDestination)
                    .navigationTitle("CodeClaws")
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            HStack {
                                Button(action: { showCreate = true }) {
                                    Image(systemName: "plus")
                                }
                                Button(action: { showSettings = true }) {
                                    Image(systemName: "gear")
                                }
                            }
                        }
                    }
            } detail: {
                NavigationStack(path: $detailPath) {
                    detailRootView
                        .navigationDestination(for: ChatRoute.self) { route in
                            ChatView(
                                project: route.project,
                                initialSessionId: route.sessionId,
                                pendingAttachments: $shareAttachments,
                                pendingSessionId: $shareSessionId
                            )
                        }
                }
            }
            .sheet(isPresented: $showCreate) {
                NavigationStack {
                    CreateProjectView()
                }
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    SettingsView()
                }
            }
            .onChange(of: detailDestination) { _, _ in
                detailPath = NavigationPath()
            }

            // Toast overlay
            if let toast = toastData {
                PushToastView(
                    data: toast,
                    onTap: {
                        navigateToDeepLink(projectId: toast.projectId, sessionId: toast.sessionId)
                        toastData = nil
                    },
                    onDismiss: {
                        toastData = nil
                    }
                )
                .transition(.move(edge: .top).combined(with: .opacity))
                .zIndex(100)
            }
        }
        .onChange(of: pushService.pendingDeepLink) { _, deepLink in
            guard let deepLink = deepLink else { return }
            handleDeepLink(deepLink)
            pushService.consumeDeepLink()
        }
        .task {
            await fetchProjects()
            if let projectId = shareHandler.pendingProjectId {
                handleIncomingShare(projectId: projectId)
            } else {
                shareHandler.checkOnActivation()
            }
        }
        .onChange(of: shareHandler.pendingProjectId) { _, projectId in
            guard let projectId = projectId else { return }
            handleIncomingShare(projectId: projectId)
        }
    }

    // MARK: - Detail Root

    @ViewBuilder
    private var detailRootView: some View {
        switch detailDestination {
        case .project(let project):
            SessionListView(project: project)
                .id(project.id)
        case .soul:
            SoulPageView()
        case .cron:
            CronPageView()
        case nil:
            VStack(spacing: 20) {
                Image(systemName: "sparkles")
                    .font(.system(size: 60))
                    .foregroundColor(.gray.opacity(0.3))
                Text("Select a project to start chatting")
                    .font(.title3)
                    .foregroundColor(.secondary)
            }
            .navigationTitle("Select Project")
        }
    }

    // MARK: - Selection Helpers

    private func selectProject(_ project: Project) {
        detailPath = NavigationPath()
        detailDestination = .project(project)
    }

    // MARK: - Deep Links

    private func handleDeepLink(_ deepLink: PushDeepLink) {
        if case .project(let current) = detailDestination,
           current.id == deepLink.projectId,
           wsService.sessionId == deepLink.sessionId {
            return
        }

        let isAppActive = UIApplication.shared.applicationState == .active
        if isAppActive {
            toastData = PushToastData(
                projectId: deepLink.projectId,
                sessionId: deepLink.sessionId,
                title: deepLink.title,
                body: deepLink.body
            )
        } else {
            navigateToDeepLink(projectId: deepLink.projectId, sessionId: deepLink.sessionId)
        }
    }

    private func navigateToDeepLink(projectId: String, sessionId: String) {
        if let project = projects.first(where: { $0.id == projectId }) {
            selectProject(project)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                detailPath.append(ChatRoute(project: project, sessionId: sessionId))
            }
        } else {
            Task {
                await fetchProjects()
                if let project = projects.first(where: { $0.id == projectId }) {
                    selectProject(project)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        detailPath.append(ChatRoute(project: project, sessionId: sessionId))
                    }
                }
            }
        }
    }

    private func fetchProjects() async {
        do {
            let fetched: [Project] = try await APIClient.shared.fetch(path: "/api/projects")
            self.projects = fetched.filter { !$0.id.hasPrefix("__") }
        } catch {
            print("[HomeView] Failed to fetch projects: \(error)")
        }
    }

    // MARK: - Share Handling

    private func handleIncomingShare(projectId: String) {
        if let project = projects.first(where: { $0.id == projectId }) {
            let sid = shareHandler.pendingSessionId
            shareAttachments = shareHandler.pendingAttachments
            shareSessionId = sid
            shareHandler.clear()
            selectProject(project)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                detailPath.append(ChatRoute(project: project, sessionId: sid))
            }
        } else {
            Task {
                await fetchProjects()
                if let project = projects.first(where: { $0.id == projectId }) {
                    let sid = shareHandler.pendingSessionId
                    shareAttachments = shareHandler.pendingAttachments
                    shareSessionId = sid
                    shareHandler.clear()
                    selectProject(project)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        detailPath.append(ChatRoute(project: project, sessionId: sid))
                    }
                } else {
                    shareHandler.clear()
                }
            }
        }
    }
}
