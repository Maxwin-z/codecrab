import SwiftUI

struct FileEntry: Codable, Identifiable {
    var id: String { name }
    let name: String
    let isDirectory: Bool
}

struct FileListing: Codable {
    let current: String
    let parent: String?
    let items: [FileEntry]
}

struct CreateProjectView: View {
    @Environment(\.dismiss) var dismiss
    @State private var path: String = ""
    @State private var items: [FileEntry] = []
    @State private var parent: String? = nil
    
    @State private var projectName: String = ""
    @State private var selectedIcon: String = "🚀"
    @State private var showIconPicker = false
    @State private var isCreating = false
    @State private var showNewFolderAlert = false
    @State private var newFolderName = ""
    
    let icons = ["🚀","💻","⭐","🎯","🎨","📱","🌐","⚡","🔧","🎮",
        "📊","🔬","🎵","📚","🏗️","🤖","💡","🔒","🎬","🌈",
        "🦀","🐍","🦊","🐳","🐧","🦅","🐝","🦋","🍎","🍊",
        "💎","🔮","🎪","🏰","🎲","🧩","🔭","🧪","⚙️","🛠️",
        "📡","🗂️","📦","🏷️","✏️","📝","🗃️","💼","🎓","🌍",
        "🌙","☀️","⛅","🌊","🔥","💧","🌿","🍀","🌸","🌺",
        "🎸","🎹","🥁","🎤","🎧","📷","🎥","📺","💻","⌨️"]
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text(path.isEmpty ? "Loading..." : path)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button(action: createFolder) {
                    Label("New Folder", systemImage: "folder.badge.plus")
                }
            }
            .padding()
            
            // File Browser
            List {
                if let parent = parent {
                    Button(action: { navigate(to: parent) }) {
                        Label("↑ Go Up", systemImage: "arrow.up.doc")
                    }
                }
                
                ForEach(items.filter { $0.isDirectory }) { item in
                    Button(action: {
                        let newPath = (path as NSString).appendingPathComponent(item.name)
                        navigate(to: newPath)
                    }) {
                        Label(item.name, systemImage: "folder")
                    }
                }
            }
            .listStyle(PlainListStyle())
            
            // Bottom Panel
            VStack(spacing: 16) {
                HStack(spacing: 16) {
                    Button(action: { showIconPicker = true }) {
                        Text(selectedIcon)
                            .font(.largeTitle)
                            .frame(width: 60, height: 60)
                            .background(Color(UIColor.secondarySystemBackground))
                            .cornerRadius(12)
                    }
                    
                    TextField("Project Name", text: $projectName)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                }
                
                HStack {
                    Button("Cancel") { dismiss() }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(UIColor.secondarySystemBackground))
                        .cornerRadius(8)
                    
                    Button(action: createProject) {
                        if isCreating {
                            ProgressView()
                        } else {
                            Text("Create")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .disabled(projectName.isEmpty || isCreating)
                }
            }
            .padding()
            .background(Color(UIColor.systemBackground).shadow(radius: 5))
        }
        .navigationTitle("New Project")
        .navigationBarTitleDisplayMode(.inline)
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
        .alert("New Folder", isPresented: $showNewFolderAlert) {
            TextField("Name", text: $newFolderName)
            Button("Cancel", role: .cancel) { }
            Button("Create") {
                guard !newFolderName.isEmpty else { return }
                Task {
                    do {
                        struct Req: Encodable { let path: String; let name: String }
                        try await APIClient.shared.request(path: "/api/files/mkdir", method: "POST", body: Req(path: self.path, name: newFolderName))
                        navigate(to: self.path)
                    } catch {
                        print("Failed to create folder: \(error)")
                    }
                }
            }
        } message: {
            Text("Enter folder name")
        }
        .task {
            navigate(to: "") // triggers default load
        }
    }
    
    private func navigate(to targetPath: String) {
        Task {
            do {
                let urlPath = targetPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? targetPath
                let listing: FileListing = try await APIClient.shared.fetch(path: "/api/files?path=\(urlPath)")
                self.path = listing.current
                self.parent = listing.parent
                self.items = listing.items.sorted { $0.name.lowercased() < $1.name.lowercased() }
                
                if !self.path.isEmpty && self.path != "/" {
                    self.projectName = (self.path as NSString).lastPathComponent
                }
            } catch {
                print("Failed to fetch files: \(error)")
            }
        }
    }
    
    private func createFolder() {
        newFolderName = ""
        showNewFolderAlert = true
    }
    
    private func createProject() {
        isCreating = true
        Task {
            do {
                struct CreateReq: Encodable { let name: String; let path: String; let icon: String }
                let req = CreateReq(name: projectName, path: path, icon: selectedIcon)
                let _: Project = try await APIClient.shared.fetch(path: "/api/projects", method: "POST", body: req)
                dismiss()
            } catch {
                print("Failed to create project: \(error)")
                isCreating = false
            }
        }
    }
}
