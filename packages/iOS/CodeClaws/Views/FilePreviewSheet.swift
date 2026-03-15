import SwiftUI
import Textual

// MARK: - FilePreviewSheet (sheet wrapper with NavigationStack)

struct FilePreviewSheet: View {
    let filePath: String
    let fileName: String

    @Environment(\.dismiss) var dismiss
    @State private var navigationPath = NavigationPath()

    var body: some View {
        NavigationStack(path: $navigationPath) {
            FilePreviewPageView(filePath: filePath, fileName: fileName, navigationPath: $navigationPath)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
                .navigationDestination(for: LinkedFile.self) { file in
                    FilePreviewPageView(filePath: file.path, fileName: file.name, navigationPath: $navigationPath)
                }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(false)
    }
}

// MARK: - LinkedFile

private struct LinkedFile: Hashable {
    let path: String
    let name: String
}

// MARK: - FilePreviewPageView (reusable for root and pushed pages)

private struct FilePreviewPageView: View {
    let filePath: String
    let fileName: String
    @Binding var navigationPath: NavigationPath

    @State private var fileContent: FileContent? = nil
    @State private var isLoading = true
    @State private var error: String? = nil
    @State private var showLineNumbers = true
    @State private var showRendered = true
    @State private var shareURL: URL? = nil
    @State private var showShareSheet = false
    @State private var isPreparingShare = false

    private var ext: String {
        (fileName as NSString).pathExtension.lowercased()
    }

    private var isMarkdown: Bool {
        ext == "md" || ext == "markdown" || ext == "mdx"
    }

    private var languageLabel: String {
        switch ext {
        case "swift": return "Swift"
        case "ts": return "TypeScript"
        case "tsx": return "TSX"
        case "js": return "JavaScript"
        case "jsx": return "JSX"
        case "json": return "JSON"
        case "md": return "Markdown"
        case "html", "htm": return "HTML"
        case "css": return "CSS"
        case "scss": return "SCSS"
        case "py": return "Python"
        case "rb": return "Ruby"
        case "go": return "Go"
        case "rs": return "Rust"
        case "yaml", "yml": return "YAML"
        case "toml": return "TOML"
        case "xml": return "XML"
        case "sh", "bash", "zsh": return "Shell"
        case "sql": return "SQL"
        case "graphql", "gql": return "GraphQL"
        case "txt": return "Text"
        case "env": return "Env"
        case "lock": return "Lock"
        case "plist": return "Plist"
        default: return ext.uppercased()
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // File info bar
            if let fc = fileContent {
                fileInfoBar(fc)
            }

            // Content
            if isLoading {
                Spacer()
                ProgressView("Loading...")
                Spacer()
            } else if let error = error {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundColor(.orange)
                    Text(error)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
                Spacer()
            } else if let fc = fileContent {
                if fc.binary {
                    binaryFileView(fc)
                } else if fc.truncated == true {
                    truncatedFileView(fc)
                } else if let content = fc.content {
                    if isMarkdown && showRendered {
                        markdownView(content)
                    } else {
                        codeView(content)
                    }
                }
            }
        }
        .navigationTitle(fileName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    if isMarkdown {
                        Button(action: {
                            showRendered.toggle()
                        }) {
                            Label(
                                showRendered ? "Show source" : "Show preview",
                                systemImage: showRendered ? "chevron.left.forwardslash.chevron.right" : "eye"
                            )
                        }
                    }
                    if !isMarkdown || !showRendered {
                        Button(action: {
                            showLineNumbers.toggle()
                        }) {
                            Label(
                                showLineNumbers ? "Hide line numbers" : "Show line numbers",
                                systemImage: showLineNumbers ? "list.number" : "list.bullet"
                            )
                        }
                    }
                    Button(action: {
                        if let content = fileContent?.content {
                            UIPasteboard.general.string = content
                        }
                    }) {
                        Label("Copy contents", systemImage: "doc.on.doc")
                    }
                    Button(action: {
                        UIPasteboard.general.string = filePath
                    }) {
                        Label("Copy path", systemImage: "link")
                    }

                    Divider()

                    Button(action: {
                        Task { await prepareAndShare() }
                    }) {
                        Label(
                            isPreparingShare ? "Preparing..." : (isMarkdown ? "Share as PDF" : "Share file"),
                            systemImage: "square.and.arrow.up"
                        )
                    }
                    .disabled(isPreparingShare || fileContent?.content == nil)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task {
            await loadFile()
        }
        .sheet(isPresented: $showShareSheet) {
            if let url = shareURL {
                ShareActivityView(activityItems: [url])
            }
        }
    }

    // MARK: - File Info Bar

    @ViewBuilder
    private func fileInfoBar(_ fc: FileContent) -> some View {
        HStack(spacing: 12) {
            // Language badge
            Text(languageLabel)
                .font(.caption2)
                .fontWeight(.semibold)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.12))
                .foregroundColor(.accentColor)
                .cornerRadius(4)

            // Size
            Text(formatSize(fc.size))
                .font(.caption2)
                .foregroundColor(.secondary)

            // Line count
            if let lines = fc.lineCount, lines > 0 {
                Text("\(lines) lines")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Spacer()

            // Modified time
            if let modifiedAt = fc.modifiedAt {
                Text(TimeAgo.format(from: modifiedAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(UIColor.secondarySystemBackground))
    }

    // MARK: - Markdown View

    @ViewBuilder
    private func markdownView(_ content: String) -> some View {
        ScrollView {
            StructuredText(markdown: content)
                .textual.structuredTextStyle(.gitHub)
                .textual.textSelection(.enabled)
                .padding(16)
        }
        .environment(\.openURL, OpenURLAction { url in
            // External links — open in browser
            if url.scheme == "http" || url.scheme == "https" {
                return .systemAction
            }
            // Relative file links — resolve and push navigation
            let linkPath = (url.scheme == "file" ? url.path : url.absoluteString)
                .removingPercentEncoding ?? url.absoluteString
            let dir = (filePath as NSString).deletingLastPathComponent
            let resolved = ((dir as NSString).appendingPathComponent(linkPath) as NSString).standardizingPath
            let name = (resolved as NSString).lastPathComponent
            navigationPath.append(LinkedFile(path: resolved, name: name))
            return .handled
        })
    }

    // MARK: - Code View

    @ViewBuilder
    private func codeView(_ content: String) -> some View {
        CodeContentView(content: content, showLineNumbers: showLineNumbers)
    }

    // MARK: - Binary / Truncated Views

    @ViewBuilder
    private func binaryFileView(_ fc: FileContent) -> some View {
        Spacer()
        VStack(spacing: 12) {
            Image(systemName: "doc.zipper")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("Binary file")
                .font(.headline)
            Text(formatSize(fc.size))
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text("Preview not available for binary files")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        Spacer()
    }

    @ViewBuilder
    private func truncatedFileView(_ fc: FileContent) -> some View {
        Spacer()
        VStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("File too large")
                .font(.headline)
            Text(formatSize(fc.size))
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text("Files over 512 KB cannot be previewed")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        Spacer()
    }

    // MARK: - Helpers

    private func loadFile() async {
        isLoading = true
        do {
            let urlPath = filePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filePath
            let fc: FileContent = try await APIClient.shared.fetch(path: "/api/files/read?path=\(urlPath)")
            fileContent = fc
            isLoading = false
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }

    private func formatSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }

    private func prepareAndShare() async {
        guard let content = fileContent?.content else { return }
        isPreparingShare = true
        defer { isPreparingShare = false }

        let tempDir = FileManager.default.temporaryDirectory

        if isMarkdown {
            let title = (fileName as NSString).deletingPathExtension
            if let url = MarkdownPDFExporter.generatePDF(markdown: content, title: title) {
                shareURL = url
                showShareSheet = true
            }
        } else {
            let url = tempDir.appendingPathComponent(fileName)
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                shareURL = url
                showShareSheet = true
            } catch {
                // silently fail
            }
        }
    }
}

// MARK: - Share Activity View

private struct ShareActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Code Content View (extracted for type-checker performance)

private struct CodeContentView: View {
    let content: String
    let showLineNumbers: Bool

    private var lines: [String] {
        content.components(separatedBy: "\n")
    }

    private var gutterWidth: Int {
        max(3, String(lines.count).count)
    }

    private var charWidth: CGFloat {
        let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        return ("W" as NSString).size(withAttributes: [.font: font]).width
    }

    private var estimatedContentWidth: CGFloat {
        let maxChars = lines.reduce(0) { max($0, $1.count) }
        let gutterW: CGFloat = showLineNumbers ? CGFloat(gutterWidth * 9 + 12 + 8) : 0
        return CGFloat(maxChars) * charWidth + gutterW + 24 // horizontal padding
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        CodeLineView(
                            lineNumber: index + 1,
                            text: line,
                            gutterWidth: gutterWidth,
                            showLineNumbers: showLineNumbers
                        )
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minWidth: max(geo.size.width, estimatedContentWidth), alignment: .leading)
            }
        }
        .background(Color(UIColor.systemBackground))
    }
}

private struct CodeLineView: View {
    let lineNumber: Int
    let text: String
    let gutterWidth: Int
    let showLineNumbers: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if showLineNumbers {
                Text(lineNumberText)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: gutterFrame, alignment: .trailing)
                    .padding(.trailing, 8)
            }
            Text(text.isEmpty ? " " : text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.vertical, 0.5)
    }

    private var lineNumberText: String {
        String(format: "%\(gutterWidth)d", lineNumber)
    }

    private var gutterFrame: CGFloat {
        CGFloat(gutterWidth * 9 + 12)
    }
}
