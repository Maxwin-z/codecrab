import SwiftUI

// MARK: - Models

struct EnhancedFileEntry: Codable, Identifiable {
    var id: String { path }
    let name: String
    let path: String
    let isDirectory: Bool
    let size: Int?
    let modifiedAt: Double?

    var ext: String {
        (name as NSString).pathExtension.lowercased()
    }

    var icon: String {
        if isDirectory { return "folder.fill" }
        switch ext {
        case "swift": return "swift"
        case "ts", "tsx": return "t.square"
        case "js", "jsx": return "j.square"
        case "json": return "curlybraces"
        case "md", "txt", "rtf": return "doc.text"
        case "html", "htm": return "globe"
        case "css", "scss", "less": return "paintbrush"
        case "py": return "chevron.left.forwardslash.chevron.right"
        case "rb": return "diamond"
        case "go": return "chevron.left.forwardslash.chevron.right"
        case "rs": return "gearshape"
        case "yaml", "yml", "toml": return "list.bullet.rectangle"
        case "png", "jpg", "jpeg", "gif", "svg", "webp", "ico": return "photo"
        case "mp3", "wav", "m4a": return "music.note"
        case "mp4", "mov", "avi": return "film"
        case "zip", "tar", "gz", "rar": return "archivebox"
        case "pdf": return "doc.richtext"
        case "sh", "zsh", "bash": return "terminal"
        case "xml", "plist": return "chevron.left.forwardslash.chevron.right"
        case "lock": return "lock"
        case "env": return "key"
        case "gitignore", "dockerignore": return "eye.slash"
        default: return "doc"
        }
    }

    var iconColor: Color {
        if isDirectory { return .blue }
        switch ext {
        case "swift": return .orange
        case "ts", "tsx": return .blue
        case "js", "jsx": return .yellow
        case "json": return .green
        case "md", "txt": return .secondary
        case "html", "htm": return .red
        case "css", "scss": return .purple
        case "py": return .blue
        case "png", "jpg", "jpeg", "gif", "svg", "webp": return .pink
        default: return .secondary
        }
    }

    var formattedSize: String {
        guard let size = size else { return "" }
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return String(format: "%.1f KB", Double(size) / 1024) }
        return String(format: "%.1f MB", Double(size) / (1024 * 1024))
    }
}

struct EnhancedFileListing: Codable {
    let current: String
    let parent: String?
    let items: [EnhancedFileEntry]
}

struct FileContent: Codable {
    let path: String
    let name: String
    let size: Int
    let modifiedAt: Double?
    let binary: Bool
    let content: String?
    let lineCount: Int?
    let truncated: Bool?
}

// MARK: - File Browser View

struct FileBrowserView: View {
    let projectPath: String
    let onSelectFile: ((String) -> Void)?

    @Environment(\.dismiss) var dismiss
    @State private var currentPath: String = ""
    @State private var items: [EnhancedFileEntry] = []
    @State private var parent: String? = nil
    @State private var isLoading = false
    @State private var searchText = ""
    @State private var showHidden = false
    @State private var selectedFile: EnhancedFileEntry? = nil
    @State private var navigationStack: [String] = []

    init(projectPath: String, onSelectFile: ((String) -> Void)? = nil) {
        self.projectPath = projectPath
        self.onSelectFile = onSelectFile
    }

    private var filteredItems: [EnhancedFileEntry] {
        if searchText.isEmpty { return items }
        let query = searchText.lowercased()
        return items.filter { $0.name.lowercased().contains(query) }
    }

    private var directories: [EnhancedFileEntry] {
        filteredItems.filter { $0.isDirectory }
    }

    private var files: [EnhancedFileEntry] {
        filteredItems.filter { !$0.isDirectory }
    }

    private var displayPath: String {
        if currentPath.isEmpty { return "..." }
        let home = NSHomeDirectory()
        if currentPath.hasPrefix(home) {
            return "~" + currentPath.dropFirst(home.count)
        }
        return currentPath
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Breadcrumb path bar
                ScrollView(.horizontal, showsIndicators: false) {
                    breadcrumbBar
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                }
                .background(Color(UIColor.secondarySystemBackground))

                // Search
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        .font(.system(size: 14))
                    TextField("Filter files...", text: $searchText)
                        .font(.subheadline)
                    if !searchText.isEmpty {
                        Button(action: { searchText = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.secondary)
                                .font(.system(size: 14))
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(UIColor.tertiarySystemBackground))
                .cornerRadius(8)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)

                if isLoading {
                    Spacer()
                    ProgressView()
                    Spacer()
                } else if filteredItems.isEmpty {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: searchText.isEmpty ? "folder" : "magnifyingglass")
                            .font(.system(size: 32))
                            .foregroundColor(.secondary)
                        Text(searchText.isEmpty ? "Empty directory" : "No matching files")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                } else {
                    // File list
                    List {
                        if !directories.isEmpty {
                            Section {
                                ForEach(directories) { item in
                                    fileRow(item)
                                }
                            }
                        }
                        if !files.isEmpty {
                            Section {
                                ForEach(files) { item in
                                    fileRow(item)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        showHidden.toggle()
                        if !currentPath.isEmpty {
                            navigate(to: currentPath)
                        }
                    }) {
                        Image(systemName: showHidden ? "eye" : "eye.slash")
                            .font(.system(size: 15))
                    }
                }
            }
            .fullScreenCover(item: $selectedFile) { file in
                FilePreviewSheet(filePath: file.path, fileName: file.name)
            }
            .task {
                navigate(to: projectPath)
            }
        }
    }

    // MARK: - Breadcrumb

    @ViewBuilder
    private var breadcrumbBar: some View {
        HStack(spacing: 4) {
            // Back button
            if navigationStack.count > 0 {
                Button(action: goBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.accentColor)
                        .frame(width: 24, height: 24)
                        .background(Color.accentColor.opacity(0.1))
                        .clipShape(Circle())
                }
            }

            // Path segments
            let segments = pathSegments()
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                if index > 0 {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8))
                        .foregroundStyle(.tertiary)
                }
                Button(action: {
                    navigateToSegment(index, segments: segments)
                }) {
                    Text(segment.name)
                        .font(.caption)
                        .fontWeight(index == segments.count - 1 ? .semibold : .regular)
                        .foregroundColor(index == segments.count - 1 ? .primary : .secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(index == segments.count - 1 ? Color.accentColor.opacity(0.1) : Color.clear)
                        .cornerRadius(4)
                }
            }
        }
    }

    // MARK: - File Row

    @ViewBuilder
    private func fileRow(_ item: EnhancedFileEntry) -> some View {
        Button(action: {
            if item.isDirectory {
                navigationStack.append(currentPath)
                navigate(to: item.path)
            } else {
                if let onSelect = onSelectFile {
                    onSelect(item.path)
                    dismiss()
                } else {
                    selectedFile = item
                }
            }
        }) {
            HStack(spacing: 12) {
                Image(systemName: item.icon)
                    .font(.system(size: 18))
                    .foregroundColor(item.iconColor)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(.primary)
                        .lineLimit(1)

                    if !item.isDirectory, item.size != nil {
                        Text(item.formattedSize)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer()

                if item.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !item.isDirectory, let onSelect = onSelectFile {
                Button(action: {
                    onSelect(item.path)
                    dismiss()
                }) {
                    Label("Add to message", systemImage: "plus.message")
                }
            }
            Button(action: {
                UIPasteboard.general.string = item.path
            }) {
                Label("Copy path", systemImage: "doc.on.doc")
            }
        }
    }

    // MARK: - Navigation

    private func navigate(to path: String) {
        searchText = ""
        isLoading = true
        Task {
            do {
                let urlPath = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
                let hiddenParam = showHidden ? "&showHidden=1" : ""
                let listing: EnhancedFileListing = try await APIClient.shared.fetch(path: "/api/files?path=\(urlPath)\(hiddenParam)")
                currentPath = listing.current
                parent = listing.parent
                items = listing.items
                isLoading = false
            } catch {
                print("Failed to fetch files: \(error)")
                isLoading = false
            }
        }
    }

    private func goBack() {
        if let prev = navigationStack.popLast() {
            navigate(to: prev)
        }
    }

    private struct PathSegment {
        let name: String
        let path: String
    }

    private func pathSegments() -> [PathSegment] {
        guard !currentPath.isEmpty else { return [] }
        let home = NSHomeDirectory()
        var segments: [PathSegment] = []

        if currentPath.hasPrefix(home) {
            segments.append(PathSegment(name: "~", path: home))
            let relative = String(currentPath.dropFirst(home.count))
            let parts = relative.split(separator: "/").map(String.init)
            var accumulated = home
            for part in parts {
                accumulated = (accumulated as NSString).appendingPathComponent(part)
                segments.append(PathSegment(name: part, path: accumulated))
            }
        } else {
            let parts = currentPath.split(separator: "/").map(String.init)
            segments.append(PathSegment(name: "/", path: "/"))
            var accumulated = ""
            for part in parts {
                accumulated += "/\(part)"
                segments.append(PathSegment(name: part, path: accumulated))
            }
        }

        // Show at most last 4 segments
        if segments.count > 4 {
            let trimmed = Array(segments.suffix(4))
            return [PathSegment(name: "...", path: segments[segments.count - 5].path)] + trimmed
        }
        return segments
    }

    private func navigateToSegment(_ index: Int, segments: [PathSegment]) {
        let targetPath = segments[index].path
        if targetPath != currentPath {
            navigationStack.append(currentPath)
            navigate(to: targetPath)
        }
    }
}
