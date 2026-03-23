import SwiftUI

// MARK: - File path detection & probing

/// Detectable file extensions for path linking
private let detectableExtsPattern =
    "png|jpg|jpeg|gif|svg|webp|ico|bmp|" +
    "mp4|mov|avi|mkv|webm|mp3|wav|m4a|" +
    "md|markdown|mdx|" +
    "ts|tsx|js|jsx|mjs|cjs|" +
    "py|pyw|rb|go|rs|java|kt|scala|" +
    "swift|m|h|c|cpp|cc|cxx|cs|" +
    "html|htm|css|scss|less|" +
    "json|yaml|yml|toml|xml|graphql|gql|" +
    "sh|bash|zsh|fish|" +
    "sql|r|lua|php|pl|ex|exs|erl|" +
    "txt|csv|log|env|ini|cfg|conf|" +
    "pdf"

private let filePathRegex: NSRegularExpression? = {
    try? NSRegularExpression(
        pattern: "((?:/[\\w@.+-]+)+\\.(?:\(detectableExtsPattern)))(?::\\d+)?\\b",
        options: [.caseInsensitive]
    )
}()

/// Extract unique absolute file paths from text
func extractFilePaths(from text: String) -> [String] {
    guard let regex = filePathRegex else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    let matches = regex.matches(in: text, range: range)
    var paths = Set<String>()
    for match in matches {
        if let pathRange = Range(match.range(at: 1), in: text) {
            paths.insert(String(text[pathRange]))
        }
    }
    return Array(paths)
}

// MARK: - Probe API

struct ProbeResult: Codable {
    let exists: Bool
    let isFile: Bool
    let size: Int?
}

struct ProbeResponse: Codable {
    let results: [String: ProbeResult]
}

/// In-memory probe cache to avoid re-probing identical paths
private var probeCache: [String: Bool] = [:]

/// Probe the server for file existence (batch)
func probeFilePaths(_ paths: [String]) async -> Set<String> {
    guard !paths.isEmpty else { return [] }

    var uncached: [String] = []
    var existing = Set<String>()

    for p in paths {
        if let cached = probeCache[p] {
            if cached { existing.insert(p) }
        } else {
            uncached.append(p)
        }
    }

    guard !uncached.isEmpty else { return existing }

    do {
        struct ProbeRequest: Encodable { let paths: [String] }
        let response: ProbeResponse = try await APIClient.shared.fetch(
            path: "/api/files/probe",
            method: "POST",
            body: ProbeRequest(paths: uncached)
        )
        for (p, info) in response.results {
            let valid = info.exists && info.isFile
            probeCache[p] = valid
            if valid { existing.insert(p) }
        }
    } catch {
        // silently ignore probe errors
    }

    return existing
}

// MARK: - FileLinkedTextView (UIViewRepresentable)

/// A UITextView wrapper that renders text with file paths as tappable links.
/// Detected paths that exist on the server are highlighted in blue and underlined.
struct FileLinkedTextView: UIViewRepresentable {
    let text: String
    var font: UIFont = .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
    var textColor: UIColor = .label
    let existingPaths: Set<String>
    var onPathTap: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.delegate = context.coordinator
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tv.linkTextAttributes = [
            .foregroundColor: UIColor.systemBlue,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        return tv
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.onPathTap = onPathTap
        let newAttr = buildAttributedString()
        // Only update if content changed
        if uiView.attributedText?.string != text || context.coordinator.lastPaths != existingPaths {
            uiView.attributedText = newAttr
            context.coordinator.lastPaths = existingPaths
            uiView.invalidateIntrinsicContentSize()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIScreen.main.bounds.width
        let size = uiView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        return CGSize(width: width, height: size.height)
    }

    private func buildAttributedString() -> NSAttributedString {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
        ]
        let result = NSMutableAttributedString(string: text, attributes: attrs)

        for path in existingPaths {
            var searchStart = 0
            let nsText = text as NSString
            while searchStart < nsText.length {
                let searchRange = NSRange(location: searchStart, length: nsText.length - searchStart)
                let range = nsText.range(of: path, options: [], range: searchRange)
                if range.location == NSNotFound { break }
                // Use a custom URL scheme so we can intercept taps
                if let url = URL(string: "filepreview://\(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)") {
                    result.addAttribute(.link, value: url, range: range)
                }
                searchStart = range.location + range.length
            }
        }

        return result
    }

    class Coordinator: NSObject, UITextViewDelegate {
        var onPathTap: ((String) -> Void)?
        var lastPaths: Set<String> = []

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            if case .link(let url) = textItem.content, url.scheme == "filepreview" {
                return UIAction { _ in
                    let path = url.absoluteString
                        .replacingOccurrences(of: "filepreview://", with: "")
                        .removingPercentEncoding ?? url.path
                    self.onPathTap?(path)
                }
            }
            return defaultAction
        }
    }
}
