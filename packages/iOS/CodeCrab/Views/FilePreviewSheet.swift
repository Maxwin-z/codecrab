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
    @State private var localVideoURL: URL? = nil

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
                    } else if isImage {
                        Button(action: {
                            Task { await shareMedia() }
                        }) {
                            Label("Share image", systemImage: "square.and.arrow.up")
                        }
                        .disabled(isPreparingShare || imageData == nil)
                    } else if isVideo {
                        Button(action: {
                            Task { await shareMedia() }
                        }) {
                            Label("Share video", systemImage: "square.and.arrow.up")
                        }
                        .disabled(isPreparingShare || localVideoURL == nil)
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
                    cleanupLocalVideo()
                }
        } else {
            Spacer()
            ProgressView("Downloading video...")
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
                await loadVideoPlayer(urlPath: urlPath)
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

    private func loadVideoPlayer(urlPath: String) async {
        do {
            let data = try await APIClient.shared.fetchData(path: "/api/files/raw?path=\(urlPath)")
            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            try data.write(to: tempURL)
            localVideoURL = tempURL
            videoPlayer = AVPlayer(url: tempURL)
        } catch {
            self.error = "Failed to load video"
        }
    }

    private func cleanupLocalVideo() {
        if let url = localVideoURL {
            try? FileManager.default.removeItem(at: url)
            localVideoURL = nil
        }
    }

    private func formatSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }

    private func shareMedia() async {
        isPreparingShare = true
        defer { isPreparingShare = false }

        if isImage, let image = imageData {
            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
            do {
                if ext == "png" {
                    try image.pngData()?.write(to: tempURL)
                } else {
                    try image.jpegData(compressionQuality: 0.95)?.write(to: tempURL)
                }
                shareURL = tempURL
                showShareSheet = true
            } catch {
                // failed to write image
            }
        } else if isVideo, let videoURL = localVideoURL {
            // Copy to a file with the original name so the share sheet shows a meaningful filename
            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
            do {
                if FileManager.default.fileExists(atPath: tempURL.path) {
                    try FileManager.default.removeItem(at: tempURL)
                }
                try FileManager.default.copyItem(at: videoURL, to: tempURL)
                shareURL = tempURL
                showShareSheet = true
            } catch {
                // failed to copy video
            }
        }
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

// MARK: - Zoomable Scroll View (UIScrollView subclass)
//
// Uses layoutSubviews to configure zoom once valid bounds are available,
// since UIViewRepresentable.updateUIView may fire before layout.

private class ZoomScrollView: UIScrollView {
    var onFirstLayout: ((_ bounds: CGRect) -> Void)?
    private var didFirstLayout = false

    override func layoutSubviews() {
        super.layoutSubviews()
        if !didFirstLayout, bounds.width > 0, bounds.height > 0 {
            didFirstLayout = true
            onFirstLayout?(bounds)
        }
    }
}

// MARK: - Zoomable Image View

private struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> ZoomScrollView {
        let scrollView = ZoomScrollView()
        scrollView.delegate = context.coordinator
        scrollView.bouncesZoom = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .systemBackground

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.tag = 100
        imageView.frame = CGRect(origin: .zero, size: image.size)
        scrollView.addSubview(imageView)
        scrollView.contentSize = image.size

        // Double-tap to toggle between fit and 2× fit
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        context.coordinator.scrollView = scrollView

        let imageSize = image.size
        let coordinator = context.coordinator
        scrollView.onFirstLayout = { [weak scrollView] bounds in
            guard let scrollView = scrollView,
                  imageSize.width > 0, imageSize.height > 0 else { return }

            let fitScale = min(bounds.width / imageSize.width,
                               bounds.height / imageSize.height)

            // min zoom: smaller of 0.5× original and 0.5× screen-fit
            scrollView.minimumZoomScale = min(0.5, fitScale * 0.5)
            // max zoom: 5× the screen-fit size
            scrollView.maximumZoomScale = fitScale * 5.0
            // start at fit-to-screen
            scrollView.zoomScale = fitScale

            coordinator.fitScale = fitScale
        }

        return scrollView
    }

    func updateUIView(_ scrollView: ZoomScrollView, context: Context) {}

    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var scrollView: UIScrollView?
        var fitScale: CGFloat = 1.0

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
            if scrollView.zoomScale > fitScale + 0.01 {
                scrollView.setZoomScale(fitScale, animated: true)
            } else {
                let point = gesture.location(in: scrollView.viewWithTag(100))
                let targetScale = fitScale * 2.0
                let zoomWidth = scrollView.bounds.width / targetScale
                let zoomHeight = scrollView.bounds.height / targetScale
                let zoomRect = CGRect(
                    x: point.x - zoomWidth / 2,
                    y: point.y - zoomHeight / 2,
                    width: zoomWidth,
                    height: zoomHeight
                )
                scrollView.zoom(to: zoomRect, animated: true)
            }
        }
    }
}
