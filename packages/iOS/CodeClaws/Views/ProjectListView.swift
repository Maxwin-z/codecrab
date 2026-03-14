import SwiftUI

struct ProjectListView: View {
    @EnvironmentObject var wsService: WebSocketService
    @Binding var selectedProject: Project?
    @State private var projects: [Project] = []
    @State private var isLoading = false
    
    var body: some View {
        List(selection: $selectedProject) {
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
                    .contextMenu {
                        Button(role: .destructive) {
                            deleteProject(project)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await fetchProjects()
        }
        .task {
            wsService.connect()
            await fetchProjects()
        }
    }
    
    private func fetchProjects() async {
        isLoading = true
        do {
            let fetched: [Project] = try await APIClient.shared.fetch(path: "/api/projects")
            self.projects = fetched
        } catch {
            print("Failed to fetch projects: \(error)")
        }
        isLoading = false
    }
    
    private func deleteProject(_ project: Project) {
        Task {
            do {
                try await APIClient.shared.request(path: "/api/projects/\(project.id)", method: "DELETE")
                projects.removeAll { $0.id == project.id }
                if selectedProject?.id == project.id {
                    selectedProject = nil
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
        if let status = wsService.projectStatuses.first(where: { $0.projectId == project.id }),
           let lastMod = status.lastModified {
            return lastMod
        }
        return project.updatedAt
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
                Text("..." + (activity.textSnippet ?? "").suffix(30))
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
                Text("..." + (activity.textSnippet ?? "").suffix(30))
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

    private func shortenedPath(_ path: String) -> String {
        var p = path
        if let homeDir = ProcessInfo.processInfo.environment["HOME"],
           p.hasPrefix(homeDir) {
            p = "~" + p.dropFirst(homeDir.count)
        }
        return p
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
        Project(id: "1", name: "Pencil SDK", path: "~/code/pencil-sdk", icon: "\u{270F}\u{FE0F}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 2 * 3600_000),
        Project(id: "2", name: "Design System", path: "~/code/design-system", icon: "\u{1F3A8}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 5 * 3600_000),
        Project(id: "3", name: "Lightning API", path: "~/code/lightning-api", icon: "\u{26A1}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 86400_000),
        Project(id: "4", name: "ML Pipeline", path: "~/code/ml-pipeline", icon: "\u{1F9E0}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 3 * 86400_000),
        Project(id: "5", name: "Launch App", path: "~/code/launch-app", icon: "\u{1F680}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 6 * 3600_000),
        Project(id: "6", name: "Config Tools", path: "~/code/config-tools", icon: "\u{1F527}", createdAt: 0, updatedAt: Date().timeIntervalSince1970 * 1000 - 7 * 86400_000),
    ]

    return NavigationStack {
        ProjectListPreviewWrapper(projects: sampleProjects)
            .environmentObject(wsService)
    }
}

private struct ProjectListPreviewWrapper: View {
    let projects: [Project]
    @State private var selectedProject: Project?

    var body: some View {
        List(selection: $selectedProject) {
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
