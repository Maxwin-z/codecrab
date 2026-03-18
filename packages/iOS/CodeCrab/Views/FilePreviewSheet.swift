import SwiftUI
import Textual
import AVKit

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
    @State private var imageData: UIImage? = nil
    @State private var videoPlayer: AVPlayer? = nil

    private var ext: String {
        (fileName as NSString).pathExtension.lowercased()
    }

    private var isMarkdown: Bool {
        ext == "md" || ext == "markdown" || ext == "mdx"
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]
    private static let videoExtensions: Set<String> = ["mp4", "mov", "avi", "mkv", "webm"]

    private var isImage: Bool { Self.imageExtensions.contains(ext) }
    private var isVideo: Bool { Self.videoExtensions.contains(ext) }

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
                if isImage {
                    imagePreviewView(fc)
                } else if isVideo {
                    videoPreviewView(fc)
                } else if fc.binary {
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

                    if isMarkdown {
                        Button(action: {
                            Task { await prepareAndShare(asPDF: true) }
                        }) {
                            Label("Share as PDF", systemImage: "doc.richtext")
                        }
                        .disabled(isPreparingShare || fileContent?.content == nil)

                        Button(action: {
                            Task { await prepareAndShare(asPDF: false) }
                        }) {
                            Label("Share as Markdown", systemImage: "doc.plaintext")
                        }
                        .disabled(isPreparingShare || fileContent?.content == nil)
                    } else {
                        Button(action: {
                            Task { await prepareAndShare(asPDF: false) }
                        }) {
                            Label("Share file", systemImage: "square.and.arrow.up")
                        }
                        .disabled(isPreparingShare || fileContent?.content == nil)
                    }
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

    // MARK: - Image Preview

    @ViewBuilder
    private func imagePreviewView(_ fc: FileContent) -> some View {
        if let image = imageData {
            ZoomableImageView(image: image)
        } else {
            Spacer()
            ProgressView("Loading image...")
            Spacer()
        }
    }

    // MARK: - Video Preview

    @ViewBuilder
    private func videoPreviewView(_ fc: FileContent) -> some View {
        if let player = videoPlayer {
            VideoPlayer(player: player)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onDisappear {
                    player.pause()
                }
        } else {
            Spacer()
            ProgressView("Loading video...")
            Spacer()
        }
    }

    // MARK: - Helpers

    private func loadFile() async {
        isLoading = true
        do {
            let urlPath = filePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filePath
            let fc: FileContent = try await APIClient.shared.fetch(path: "/api/files/read?path=\(urlPath)")
            fileContent = fc
            isLoading = false

            // Load media content after metadata is ready
            if isImage {
                await loadImageData(urlPath: urlPath)
            } else if isVideo {
                loadVideoPlayer(urlPath: urlPath)
            }
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }

    private func loadImageData(urlPath: String) async {
        do {
            let data = try await APIClient.shared.fetchData(path: "/api/files/raw?path=\(urlPath)")
            imageData = UIImage(data: data)
        } catch {
            self.error = "Failed to load image"
        }
    }

    private func loadVideoPlayer(urlPath: String) {
        if let url = APIClient.shared.buildURL(path: "/api/files/raw?path=\(urlPath)") {
            videoPlayer = AVPlayer(url: url)
        }
    }

    private func formatSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }

    private func prepareAndShare(asPDF: Bool) async {
        guard let content = fileContent?.content else { return }
        isPreparingShare = true
        defer { isPreparingShare = false }

        let tempDir = FileManager.default.temporaryDirectory

        if asPDF {
            let title = (fileName as NSString).deletingPathExtension
            if let url = await MarkdownPDFExporter.generatePDF(markdown: content, title: title) {
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

// MARK: - Zoomable Image View (UIScrollView-based pinch-to-zoom)

private struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 5.0
        scrollView.bouncesZoom = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .systemBackground

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.tag = 100
        scrollView.addSubview(imageView)

        // Double-tap to zoom
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        context.coordinator.scrollView = scrollView

        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        guard let imageView = scrollView.viewWithTag(100) as? UIImageView else { return }
        imageView.image = image

        let bounds = scrollView.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }

        let imageSize = image.size
        let widthScale = bounds.width / imageSize.width
        let heightScale = bounds.height / imageSize.height
        let fitScale = min(widthScale, heightScale)

        let fitWidth = imageSize.width * fitScale
        let fitHeight = imageSize.height * fitScale
        imageView.frame = CGRect(
            x: max(0, (bounds.width - fitWidth) / 2),
            y: max(0, (bounds.height - fitHeight) / 2),
            width: fitWidth,
            height: fitHeight
        )

        scrollView.contentSize = CGSize(width: max(bounds.width, fitWidth), height: max(bounds.height, fitHeight))
    }

    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var scrollView: UIScrollView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            scrollView.viewWithTag(100)
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            guard let imageView = scrollView.viewWithTag(100) else { return }
            let bounds = scrollView.bounds
            let contentSize = scrollView.contentSize
            let offsetX = max(0, (bounds.width - contentSize.width) / 2)
            let offsetY = max(0, (bounds.height - contentSize.height) / 2)
            imageView.center = CGPoint(
                x: contentSize.width / 2 + offsetX,
                y: contentSize.height / 2 + offsetY
            )
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView = scrollView else { return }
            if scrollView.zoomScale > scrollView.minimumZoomScale {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            } else {
                let point = gesture.location(in: scrollView.viewWithTag(100))
                let zoomRect = CGRect(
                    x: point.x - 50,
                    y: point.y - 50,
                    width: 100,
                    height: 100
                )
                scrollView.zoom(to: zoomRect, animated: true)
            }
        }
    }
}
