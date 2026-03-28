import SwiftUI

/// Bridges an Agent to the existing SessionListView by resolving its internal project
struct AgentDetailView: View {
    let agent: Agent
    @State private var internalProject: Project?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let project = internalProject {
                SessionListView(project: project)
            } else if isLoading {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Loading agent...")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            } else if let error = errorMessage {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 40))
                        .foregroundColor(.orange)
                    Text(error)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Button("Retry") {
                        Task { await resolveProject() }
                    }
                }
            }
        }
        .task {
            await resolveProject()
        }
    }

    private func resolveProject() async {
        isLoading = true
        errorMessage = nil
        do {
            let project: Project = try await APIClient.shared.fetch(
                path: "/api/agents/\(agent.id)/use",
                method: "POST"
            )
            self.internalProject = project
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
