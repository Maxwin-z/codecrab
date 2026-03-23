import SwiftUI

struct FileSearchResult: Codable, Identifiable {
    var id: String { path }
    let name: String
    let path: String
    let relativePath: String
    let isDirectory: Bool

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
        case "md", "txt": return "doc.text"
        case "html", "htm": return "globe"
        case "css", "scss": return "paintbrush"
        case "py": return "chevron.left.forwardslash.chevron.right"
        case "sh", "zsh": return "terminal"
        case "yaml", "yml", "toml": return "list.bullet.rectangle"
        case "png", "jpg", "jpeg", "gif", "svg", "webp": return "photo"
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
        case "py": return .blue
        case "html": return .red
        case "css", "scss": return .purple
        default: return .secondary
        }
    }
}

struct FileMentionOverlayView: View {
    let query: String
    let projectPath: String
    let onSelect: (FileSearchResult) -> Void
    let onDismiss: () -> Void

    @State private var allFiles: [FileSearchResult] = []
    @State private var isLoading = false

    private var filtered: [FileSearchResult] {
        let q = query.lowercased()
        if q.isEmpty { return Array(allFiles.prefix(30)) }
        let matches = allFiles.filter {
            $0.name.lowercased().contains(q) || $0.relativePath.lowercased().contains(q)
        }
        return Array(matches.prefix(30))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Image(systemName: "at")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.accentColor)
                Text("Mention a file")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.6)
                }
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.secondary)
                        .frame(width: 22, height: 22)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            if filtered.isEmpty && !isLoading {
                VStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 20))
                        .foregroundColor(.secondary)
                    Text(query.isEmpty ? "Type to search files" : "No files found")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { result in
                            Button(action: { onSelect(result) }) {
                                HStack(spacing: 10) {
                                    Image(systemName: result.icon)
                                        .font(.system(size: 14))
                                        .foregroundColor(result.iconColor)
                                        .frame(width: 22)

                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(result.name)
                                            .font(.subheadline)
                                            .fontWeight(.medium)
                                            .foregroundColor(.primary)
                                            .lineLimit(1)
                                        Text(result.relativePath)
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                            .lineLimit(1)
                                    }

                                    Spacer()

                                    if result.isDirectory {
                                        Image(systemName: "folder")
                                            .font(.system(size: 10))
                                            .foregroundColor(.secondary)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Divider().padding(.leading, 44)
                        }
                    }
                }
                .frame(minHeight: 160, maxHeight: UIScreen.main.bounds.height * 0.45)
            }
        }
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(UIColor.separator), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.1), radius: 8, x: 0, y: -2)
        .task {
            await loadAllFiles()
        }
    }

    private func loadAllFiles() async {
        isLoading = true
        let encodedRoot = projectPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        do {
            let fetched: [FileSearchResult] = try await APIClient.shared.fetch(
                path: "/api/files/search?q=&root=\(encodedRoot)&limit=500"
            )
            allFiles = fetched
        } catch {
            allFiles = []
        }
        isLoading = false
    }
}
