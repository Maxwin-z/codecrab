import SwiftUI

struct HomeView: View {
    @EnvironmentObject var wsService: WebSocketService
    @EnvironmentObject var shareHandler: ShareHandler
    @ObservedObject private var pushService = PushNotificationService.shared

    @State private var selectedProject: Project?
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
                ProjectListView(selectedProject: $selectedProject)
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
                NavigationStack {
                    if let project = selectedProject {
                        ChatView(
                            project: project,
                            pendingAttachments: $shareAttachments,
                            pendingSessionId: $shareSessionId
                        )
                            .id(project.id)
                    } else {
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
        }
        .onChange(of: shareHandler.pendingProjectId) { _, projectId in
            guard let projectId = projectId else { return }
            handleIncomingShare(projectId: projectId)
        }
    }

    private func handleDeepLink(_ deepLink: PushDeepLink) {
        // Check if the app is showing the same project+session already
        if let current = selectedProject,
           current.id == deepLink.projectId,
           wsService.sessionId == deepLink.sessionId {
            // Already viewing this session — ignore
            return
        }

        // Show toast for foreground; for background tap, navigate directly
        let isAppActive = UIApplication.shared.applicationState == .active
        if isAppActive {
            toastData = PushToastData(
                projectId: deepLink.projectId,
                sessionId: deepLink.sessionId,
                title: deepLink.title,
                body: deepLink.body
            )
        } else {
            // App was in background — navigate immediately
            navigateToDeepLink(projectId: deepLink.projectId, sessionId: deepLink.sessionId)
        }
    }

    private func navigateToDeepLink(projectId: String, sessionId: String) {
        // Find the project from cached list, or create a minimal one
        if let project = projects.first(where: { $0.id == projectId }) {
            selectedProject = project
        } else {
            // Fetch projects and retry
            Task {
                await fetchProjects()
                if let project = projects.first(where: { $0.id == projectId }) {
                    selectedProject = project
                }
            }
        }

        // Resume the specific session after a brief delay to let project switch complete
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            wsService.resumeSession(sessionId)
        }
    }

    private func fetchProjects() async {
        do {
            let fetched: [Project] = try await APIClient.shared.fetch(path: "/api/projects")
            self.projects = fetched
        } catch {
            print("[HomeView] Failed to fetch projects: \(error)")
        }
    }

    private func handleIncomingShare(projectId: String) {
        // Find matching project
        if let project = projects.first(where: { $0.id == projectId }) {
            selectedProject = project
            shareAttachments = shareHandler.pendingAttachments
            shareSessionId = shareHandler.pendingSessionId
            shareHandler.clear()
        } else {
            // Fetch projects first, then retry
            Task {
                await fetchProjects()
                if let project = projects.first(where: { $0.id == projectId }) {
                    selectedProject = project
                    shareAttachments = shareHandler.pendingAttachments
                    shareSessionId = shareHandler.pendingSessionId
                    shareHandler.clear()
                } else {
                    shareHandler.clear()
                }
            }
        }
    }
}
