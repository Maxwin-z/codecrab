import SwiftUI

struct ProjectListView: View {
    @EnvironmentObject var wsService: WebSocketService
    @Binding var selection: DetailDestination?
    @State private var projects: [Project] = []
    @State private var agents: [Agent] = []
    @State private var cronJobs: [CronJob] = []
    @State private var isLoading = false
    @State private var cardRefreshID = UUID()
    @State private var editingProject: Project?
    @State private var showCopiedToast = false

    private var selectedProjectId: String? {
        if case .project(let p) = selection { return p.id }
        return nil
    }

    /// Cron jobs grouped by projectId for quick lookup
    private var cronJobsByProject: [String: [CronJob]] {
        Dictionary(grouping: cronJobs.filter { $0.context.projectId != nil },
                   by: { $0.context.projectId! })
    }

    /// Projects sorted by most recent activity first
    private var sortedProjects: [Project] {
        projects.sorted { a, b in
            lastActiveTime(for: a) > lastActiveTime(for: b)
        }
    }

    private func lastActiveTime(for project: Project) -> Double {
        let restTime = project.lastActivityAt ?? project.updatedAt
        if let status = wsService.projectStatuses.first(where: { $0.projectId == project.id }),
           let lastMod = status.lastModified {
            return max(lastMod, restTime)
        }
        return restTime
    }

    var body: some View {
        List(selection: $selection) {
            // Dashboard cards
            Section {
                SoulCardView(refreshID: cardRefreshID)
                    .allowsHitTesting(false)
                    .tag(DetailDestination.soul)
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 4, trailing: 8))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                CronCardView(refreshID: cardRefreshID)
                    .allowsHitTesting(false)
                    .tag(DetailDestination.cron)
                    .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }

            // Agent list
            if !agents.isEmpty {
                Section {
                    ForEach(agents) { agent in
                        AgentCard(agent: agent, isSelected: {
                            if case .agent(let a) = selection { return a.id == agent.id }
                            return false
                        }())
                        .tag(DetailDestination.agent(agent))
                        .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                        .listRowSeparator(.automatic)
                        .listRowBackground(Color.clear)
                        .contextMenu {
                            Button {
                                Task { await startEditingAgent(agent) }
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            Divider()
                            Button(role: .destructive) {
                                deleteAgent(agent)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("Agents")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .textCase(nil)
                }
            }

            // Project list
            Section {
                if isLoading && projects.isEmpty {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.automatic)
                } else if projects.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "folder")
                            .font(.system(size: 48))
                            .foregroundColor(.gray)
                        Text("No projects yet")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.automatic)
                } else {
                    ForEach(sortedProjects) { project in
                        ProjectCard(
                            project: project,
                            isSelected: selectedProjectId == project.id,
                            cronJobs: cronJobsByProject[project.id] ?? []
                        )
                        .tag(DetailDestination.project(project))
                        .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                        .listRowSeparator(.automatic)
                        .listRowBackground(Color.clear)
                        .contextMenu {
                            Button {
                                editingProject = project
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            Button {
                                UIPasteboard.general.string = project.path
                                withAnimation {
                                    showCopiedToast = true
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                    withAnimation {
                                        showCopiedToast = false
                                    }
                                }
                            } label: {
                                Label("Copy Path", systemImage: "doc.on.doc")
                            }
                            Divider()
                            Button(role: .destructive) {
                                deleteProject(project)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            } header: {
                Text("Projects")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textCase(nil)
            }

            // Thread list (below Projects)
            if !wsService.threads.isEmpty {
                Section {
                    ForEach(wsService.sortedThreads) { thread in
                        ThreadCard(thread: thread, isSelected: {
                            if case .thread(let id) = selection { return id == thread.id }
                            return false
                        }())
                        .tag(DetailDestination.thread(thread.id))
                        .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                        .listRowSeparator(.automatic)
                        .listRowBackground(Color.clear)
                    }
                } header: {
                    Text("Threads")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .overlay(alignment: .bottom) {
            if showCopiedToast {
                Text("Path copied")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(item: $editingProject) { project in
            EditProjectSheet(project: project) { updated in
                if let idx = projects.firstIndex(where: { $0.id == updated.id }) {
                    projects[idx] = updated
                }
            }
        }
        .refreshable {
            await fetchAll()
        }
        .task {
            wsService.connect()
            await fetchAll()
        }
    }

    private func fetchAll() async {
        isLoading = true
        cardRefreshID = UUID()
        async let projectsTask: () = fetchProjects()
        async let agentsTask: () = fetchAgents()
        async let cronTask: () = fetchCronJobs()
        async let threadsTask: () = fetchThreads()
        _ = await (projectsTask, agentsTask, cronTask, threadsTask)
        isLoading = false
    }

    private func fetchProjects() async {
        do {
            let fetched: [Project] = try await APIClient.shared.fetch(path: "/api/projects")
            self.projects = fetched.filter { !$0.id.hasPrefix("__") }
        } catch {
            print("Failed to fetch projects: \(error)")
        }
    }

    private func fetchAgents() async {
        do {
            let fetched: [Agent] = try await APIClient.shared.fetch(path: "/api/agents")
            self.agents = fetched
        } catch {
            print("Failed to fetch agents: \(error)")
        }
    }

    private func startEditingAgent(_ agent: Agent) async {
        do {
            struct EditAgentResponse: Codable {
                let projectId: String
                let projectPath: String
                let agentId: String
                let agentName: String
                let agentEmoji: String
                let currentClaudeMd: String
            }
            let response: EditAgentResponse = try await APIClient.shared.fetch(
                path: "/api/agents/\(agent.id)/edit",
                method: "POST"
            )
            let now = Date().timeIntervalSince1970 * 1000
            let editorProject = Project(
                id: response.projectId,
                name: agent.name,
                path: response.projectPath,
                icon: agent.emoji,
                createdAt: now,
                updatedAt: now,
                lastActivityAt: nil
            )
            selection = .project(editorProject)
        } catch {
            print("Failed to start editing agent: \(error)")
        }
    }

    private func deleteAgent(_ agent: Agent) {
        Task {
            do {
                try await APIClient.shared.request(path: "/api/agents/\(agent.id)", method: "DELETE")
                agents.removeAll { $0.id == agent.id }
                if case .agent(let a) = selection, a.id == agent.id {
                    selection = nil
                }
            } catch {
                print("Failed to delete agent: \(error)")
            }
        }
    }

    private func fetchCronJobs() async {
        do {
            let fetched: [CronJob] = try await APIClient.shared.fetch(path: "/api/cron/jobs")
            self.cronJobs = fetched
        } catch {
            print("Failed to fetch cron jobs: \(error)")
        }
    }

    private func fetchThreads() async {
        do {
            let response: ThreadsResponse = try await APIClient.shared.fetch(path: "/api/threads")
            for thread in response.threads {
                // Only add if not already in store (store wins for real-time data)
                if wsService.threads[thread.id] == nil {
                    wsService.upsertThread(thread)
                }
            }
        } catch {
            print("Failed to fetch threads: \(error)")
        }
    }

    private func deleteProject(_ project: Project) {
        Task {
            do {
                try await APIClient.shared.request(path: "/api/projects/\(project.id)", method: "DELETE")
                projects.removeAll { $0.id == project.id }
                if case .project(let p) = selection, p.id == project.id {
                    selection = nil
                }
            } catch {
                print("Failed to delete project: \(error)")
            }
        }
    }
}

struct ProjectCard: View {
    let project: Project
    let isSelected: Bool
    var cronJobs: [CronJob] = []
    @EnvironmentObject var wsService: WebSocketService

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(project.icon)
                    .font(.system(size: 18))
                Text(project.name)
                    .font(.headline)
                    .foregroundColor(isSelected ? .accentColor : .primary)
                    .lineLimit(1)
                Spacer()
                Text(TimeAgo.format(from: lastActiveTime))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                indicator
            }

            HStack(spacing: 4) {
                Text(shortenedPath(project.path))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }

            // Live activity row
            if let activity = wsService.projectActivities[project.id] {
                activityRow(activity)
            }

            // Cron jobs summary row
            if !cronJobs.isEmpty {
                cronRow
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
        )
    }

    private var lastActiveTime: Double {
        let restTime = project.lastActivityAt ?? project.updatedAt
        if let status = wsService.projectStatuses.first(where: { $0.projectId == project.id }),
           let lastMod = status.lastModified {
            return max(lastMod, restTime)
        }
        return restTime
    }

    @ViewBuilder
    var indicator: some View {
        if wsService.runningProjectIds.contains(project.id) {
            Circle().fill(Color.orange).frame(width: 8, height: 8)
        } else if let status = wsService.projectStatuses.first(where: { $0.projectId == project.id }),
                  let lastMod = status.lastModified,
                  Date().timeIntervalSince1970 * 1000 - lastMod < 600_000 {
            Circle().fill(Color.green).frame(width: 8, height: 8)
        }
    }

    @ViewBuilder
    private func activityRow(_ activity: ProjectActivity) -> some View {
        HStack(spacing: 4) {
            switch activity.activityType {
            case "thinking":
                Text("💭")
                    .font(.caption2)
                Text("..." + (activity.textSnippet ?? "").suffix(80))
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            case "tool_use":
                Text("🔧")
                    .font(.caption2)
                Text("tool_use [\(activity.toolName ?? "unknown")]")
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            case "text":
                Text("💬")
                    .font(.caption2)
                Text("..." + (activity.textSnippet ?? "").suffix(80))
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            default:
                EmptyView()
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var cronRow: some View {
        let activeJobs = cronJobs.filter { $0.status == "pending" || $0.status == "running" }
        let nextJob = activeJobs
            .compactMap { job -> (CronJob, Date)? in
                guard let date = job.nextRunDate else { return nil }
                return (job, date)
            }
            .min(by: { $0.1 < $1.1 })

        HStack(spacing: 4) {
            Image(systemName: "clock.arrow.2.circlepath")
                .font(.caption2)
                .foregroundStyle(.purple)
            Text("\(activeJobs.count)")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.purple)
            if let (job, date) = nextJob {
                Text("·")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(date.formatted(date: .omitted, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("·")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(job.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
        }
    }

    private func shortenedPath(_ path: String) -> String {
        var p = path
        if let homeDir = ProcessInfo.processInfo.environment["HOME"],
           p.hasPrefix(homeDir) {
            p = "~" + p.dropFirst(homeDir.count)
        }
        return p
    }
}

// MARK: - Agent Card

struct AgentCard: View {
    let agent: Agent
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text(agent.emoji)
                .font(.system(size: 28))
                .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .font(.headline)
                    .foregroundColor(isSelected ? .accentColor : .primary)
                    .lineLimit(1)
                Text("Agent")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
        )
    }
}

// MARK: - Thread Card

struct ThreadCard: View {
    let thread: ThreadInfo
    let isSelected: Bool
    @EnvironmentObject var wsService: WebSocketService

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
                Text(thread.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(isSelected ? .accentColor : .primary)
                    .lineLimit(1)
                Spacer()
                ThreadStatusBadge(status: thread.status)
            }

            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    Image(systemName: "person.2")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text("\(thread.participants.count)")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                if !thread.messages.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "message")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("\(thread.messages.count)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                Spacer()
                Text(TimeAgo.format(from: thread.updatedAt))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if !thread.participants.isEmpty {
                HStack(spacing: 4) {
                    ForEach(thread.participants.prefix(3)) { p in
                        Text("@\(p.agentName)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    if thread.participants.count > 3 {
                        Text("+\(thread.participants.count - 3)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
        )
    }
}

// MARK: - Edit Project Sheet

struct EditProjectSheet: View {
    let project: Project
    var onSave: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""
    @State private var selectedIcon: String = ""
    @State private var isSaving = false
    @State private var showIconPicker = false

    private let icons = ["🚀","💻","⭐","🎯","🎨","📱","🌐","⚡","🔧","🎮",
        "📊","🔬","🎵","📚","🏗️","🤖","💡","🔒","🎬","🌈",
        "🦀","🐍","🦊","🐳","🐧","🦅","🐝","🦋","🍎","🍊",
        "💎","🔮","🎪","🏰","🎲","🧩","🔭","🧪","⚙️","🛠️",
        "📡","🗂️","📦","🏷️","✏️","📝","🗃️","💼","🎓","🌍",
        "🌙","☀️","⛅","🌊","🔥","💧","🌿","🍀","🌸","🌺",
        "🎸","🎹","🥁","🎤","🎧","📷","🎥","📺","💻","⌨️"]

    var body: some View {
        NavigationView {
            Form {
                Section {
                    HStack(spacing: 16) {
                        Button(action: { showIconPicker = true }) {
                            Text(selectedIcon)
                                .font(.largeTitle)
                                .frame(width: 60, height: 60)
                                .background(Color(UIColor.secondarySystemBackground))
                                .cornerRadius(12)
                        }
                        TextField("Project Name", text: $name)
                            .textFieldStyle(RoundedBorderTextFieldStyle())
                    }
                }
                Section {
                    LabeledContent("Path") {
                        Text(project.path)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            .navigationTitle("Edit Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.isEmpty || isSaving)
                }
            }
            .sheet(isPresented: $showIconPicker) {
                NavigationView {
                    ScrollView {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 20) {
                            ForEach(icons, id: \.self) { icon in
                                Button(action: {
                                    selectedIcon = icon
                                    showIconPicker = false
                                }) {
                                    Text(icon).font(.largeTitle)
                                }
                            }
                        }
                        .padding()
                    }
                    .navigationTitle("Choose Icon")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button("Done") { showIconPicker = false }
                        }
                    }
                }
                .presentationDetents([.medium, .large])
            }
        }
        .onAppear {
            name = project.name
            selectedIcon = project.icon
        }
    }

    private func save() {
        isSaving = true
        Task {
            do {
                struct PatchReq: Encodable { let name: String; let icon: String }
                let req = PatchReq(name: name, icon: selectedIcon)
                let updated: Project = try await APIClient.shared.fetch(
                    path: "/api/projects/\(project.id)", method: "PATCH", body: req
                )
                onSave(updated)
                dismiss()
            } catch {
                print("Failed to update project: \(error)")
                isSaving = false
            }
        }
    }
}

// MARK: - Preview

#Preview("Project List") {
    let wsService: WebSocketService = {
        let service = WebSocketService()
        let now = Date().timeIntervalSince1970 * 1000
        service.projectStatuses = [
            ProjectStatus(projectId: "1", status: "idle", sessionId: nil, firstPrompt: nil, lastModified: now - 2 * 3600_000),
            ProjectStatus(projectId: "2", status: "idle", sessionId: nil, firstPrompt: nil, lastModified: now - 5 * 3600_000),
            ProjectStatus(projectId: "3", status: "processing", sessionId: "s1", firstPrompt: nil, lastModified: now - 86400_000),
            ProjectStatus(projectId: "4", status: "processing", sessionId: "s2", firstPrompt: nil, lastModified: now - 3 * 86400_000),
            ProjectStatus(projectId: "5", status: "idle", sessionId: nil, firstPrompt: nil, lastModified: now - 6 * 3600_000),
            ProjectStatus(projectId: "6", status: "idle", sessionId: nil, firstPrompt: nil, lastModified: now - 7 * 86400_000),
        ]
        return service
    }()

    let sampleProjects: [Project] = [
        Project(id: "1", name: "Pencil SDK", path: "~/code/pencil-sdk", icon: "\u{270F}\u{FE0F}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 2 * 3600_000, lastActivityAt: nil),
        Project(id: "2", name: "Design System", path: "~/code/design-system", icon: "\u{1F3A8}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 5 * 3600_000, lastActivityAt: nil),
        Project(id: "3", name: "Lightning API", path: "~/code/lightning-api", icon: "\u{26A1}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 86400_000, lastActivityAt: nil),
        Project(id: "4", name: "ML Pipeline", path: "~/code/ml-pipeline", icon: "\u{1F9E0}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 3 * 86400_000, lastActivityAt: nil),
        Project(id: "5", name: "Launch App", path: "~/code/launch-app", icon: "\u{1F680}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 6 * 3600_000, lastActivityAt: nil),
        Project(id: "6", name: "Config Tools", path: "~/code/config-tools", icon: "\u{1F527}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 7 * 86400_000, lastActivityAt: nil),
    ]

    NavigationStack {
        ProjectListPreviewWrapper(projects: sampleProjects)
            .environmentObject(wsService)
    }
}

private struct ProjectListPreviewWrapper: View {
    let projects: [Project]
    @State private var selectedProject: Project?

    var body: some View {
        List {
            ForEach(projects) { project in
                Button {
                    selectedProject = project
                } label: {
                    ProjectCard(project: project, isSelected: selectedProject?.id == project.id)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                .listRowSeparator(.automatic)
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Projects")
        .onAppear {
            selectedProject = projects.first
        }
    }
}
