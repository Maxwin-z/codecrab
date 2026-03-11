import SwiftUI

struct ProjectListView: View {
    @EnvironmentObject var wsService: WebSocketService
    @State private var projects: [Project] = []
    @State private var isLoading = false
    
    let columns = [
        GridItem(.adaptive(minimum: 160), spacing: 16)
    ]
    
    var body: some View {
        ScrollView {
            if isLoading && projects.isEmpty {
                ProgressView()
                    .padding(.top, 50)
            } else if projects.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "folder")
                        .font(.system(size: 60))
                        .foregroundColor(.gray)
                    Text("No projects yet")
                        .font(.headline)
                }
                .padding(.top, 100)
            } else {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(projects) { project in
                        NavigationLink(destination: ChatView(project: project)) {
                            ProjectCard(project: project)
                        }
                        .buttonStyle(PlainButtonStyle())
                        .contextMenu {
                            Button(role: .destructive) {
                                deleteProject(project)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                .padding()
            }
        }
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
            } catch {
                print("Failed to delete project: \(error)")
            }
        }
    }
}

struct ProjectCard: View {
    let project: Project
    @EnvironmentObject var wsService: WebSocketService
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(project.icon)
                    .font(.title)
                Spacer()
                indicator
            }
            
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(project.path)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            
            Spacer()
            
            Text("Updated " + TimeAgo.format(from: project.updatedAt))
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding()
        .frame(height: 140)
        .background(Color(UIColor.secondarySystemGroupedBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.05), radius: 2, x: 0, y: 1)
    }
    
    @ViewBuilder
    var indicator: some View {
        if let status = wsService.projectStatuses.first(where: { $0.projectId == project.id }) {
            if status.status == "processing" {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 10, height: 10)
            } else if let lastMod = status.lastModified, Date().timeIntervalSince1970 * 1000 - lastMod < 600_000 {
                Circle()
                    .fill(Color.green)
                    .frame(width: 10, height: 10)
            }
        }
    }
}
