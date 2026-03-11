import SwiftUI

struct HomeView: View {
    @State private var selectedProject: Project?
    @State private var showCreate = false
    @State private var showSettings = false
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
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
                    ChatView(project: project)
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
    }
}
