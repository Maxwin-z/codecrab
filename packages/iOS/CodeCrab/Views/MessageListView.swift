import SwiftUI

// MARK: - Turn group (user message + agent response events)

struct TurnGroup: Identifiable {
    let id: String
    let userMessage: ChatMessage?
    let agentEvents: [SdkEvent]
}

struct MessageListView: View {
    let messages: [ChatMessage]
    let streamingText: String
    let streamingThinking: String
    let isRunning: Bool
    let sdkEvents: [SdkEvent]
    var onResumeSession: ((String) -> Void)? = nil

    /// Group user messages and SDK events into turns
    private var turnGroups: [TurnGroup] {
        let sortedUserMsgs = messages
            .filter { $0.role == "user" }
            .sorted { $0.timestamp < $1.timestamp }

        var groups: [TurnGroup] = []

        // Events before the first user message (e.g. from session resume)
        if let firstTs = sortedUserMsgs.first?.timestamp {
            let earlyEvents = sdkEvents.filter { $0.ts < firstTs }.sorted { $0.ts < $1.ts }
            if !earlyEvents.isEmpty {
                groups.append(TurnGroup(id: "turn-pre", userMessage: nil, agentEvents: earlyEvents))
            }
        }

        for (i, userMsg) in sortedUserMsgs.enumerated() {
            let nextTs = i + 1 < sortedUserMsgs.count
                ? sortedUserMsgs[i + 1].timestamp
                : Double.infinity
            let events = sdkEvents
                .filter { $0.ts >= userMsg.timestamp && $0.ts < nextTs }
                .sorted { $0.ts < $1.ts }
            groups.append(TurnGroup(id: "turn-\(userMsg.id)", userMessage: userMsg, agentEvents: events))
        }

        // No user messages but have SDK events
        if sortedUserMsgs.isEmpty && !sdkEvents.isEmpty {
            groups.append(TurnGroup(id: "turn-all", userMessage: nil, agentEvents: sdkEvents.sorted { $0.ts < $1.ts }))
        }

        return groups
    }

    var body: some View {
        VStack(spacing: 4) {
            if !messages.isEmpty || !sdkEvents.isEmpty || isRunning {
                ForEach(Array(turnGroups.enumerated()), id: \.element.id) { index, group in
                    if let userMsg = group.userMessage {
                        MessageBubbleView(message: userMsg, isRunning: isRunning)
                            .padding(.vertical, 6)
                    }
                    let isLastStreaming = isRunning && index == turnGroups.count - 1
                    if !group.agentEvents.isEmpty || isLastStreaming {
                        AgentResponseView(
                            events: group.agentEvents,
                            isStreaming: isLastStreaming,
                            streamingThinking: isLastStreaming ? streamingThinking : "",
                            streamingText: isLastStreaming ? streamingText : "",
                            onResumeSession: onResumeSession
                        )
                    }
                }

                // Edge case: isRunning but no turn groups yet
                if isRunning && turnGroups.isEmpty {
                    AgentResponseView(
                        events: [],
                        isStreaming: true,
                        streamingThinking: streamingThinking,
                        streamingText: streamingText,
                        onResumeSession: onResumeSession
                    )
                }
            }
        }
    }
}

// MARK: - Agent Response View (with message/debug toggle)

struct AgentResponseView: View {
    let events: [SdkEvent]
    let isStreaming: Bool
    var streamingThinking: String = ""
    var streamingText: String = ""
    var onResumeSession: ((String) -> Void)? = nil
    @State private var showDebug = false
    @State private var renderMarkdown: Bool

    init(events: [SdkEvent], isStreaming: Bool, streamingThinking: String = "", streamingText: String = "", onResumeSession: ((String) -> Void)? = nil) {
        self.events = events
        self.isStreaming = isStreaming
        self.streamingThinking = streamingThinking
        self.streamingText = streamingText
        self.onResumeSession = onResumeSession
        // Non-streaming (historical) turns start with markdown rendered;
        // actively streaming turns start with plain text, auto-switch on completion.
        self._renderMarkdown = State(initialValue: !isStreaming)
    }

    private static let messageTypes: Set<String> = ["thinking", "text", "tool_use", "tool_result", "cron_task_completed"]

    private var messageEvents: [SdkEvent] {
        events.filter { event in
            if Self.messageTypes.contains(event.type) { return true }
            // Include result events with execSessionId (cron task results from history)
            if event.type == "result",
               let data = event.data,
               case .string(_) = data["execSessionId"] { return true }
            return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: showDebug ? 2 : 4) {
            if showDebug {
                ForEach(events) { event in
                    SdkEventInlineView(event: event)
                }
            } else {
                ForEach(messageEvents) { event in
                    if event.type == "cron_task_completed" {
                        CronTaskCompletedView(event: event, onResumeSession: onResumeSession)
                    } else if event.type == "result", let data = event.data, case .string(_) = data["execSessionId"] {
                        CronResultView(event: event, onResumeSession: onResumeSession)
                    } else {
                        MessageModeEventView(event: event, isStreaming: isStreaming, renderMarkdown: isStreaming ? false : renderMarkdown)
                    }
                }
            }

            // Live streaming content (before "Generating..." indicator)
            if isStreaming {
                if !streamingThinking.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                        Text("🧠")
                            .font(.caption)
                        Text("Thinking")
                            .font(.callout)
                            .fontDesign(.monospaced)
                        Text(streamingThinking.components(separatedBy: .newlines).joined(separator: " "))
                            .font(.caption)
                            .fontDesign(.monospaced)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundColor(.orange.opacity(0.8))
                }
                if !streamingText.isEmpty {
                    let displayText = streamingText
                        .replacingOccurrences(of: "\\n?\\[SUMMARY:[^\\n]*\\]?", with: "", options: .regularExpression)
                        .replacingOccurrences(of: "\\n?\\[SUGGESTIONS:[^\\n]*\\]?", with: "", options: .regularExpression)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !displayText.isEmpty {
                        InlineSelectableText(
                            text: displayText,
                            font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular),
                            textColor: .label
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                // "Generating..." at the bottom
                HStack(spacing: 6) {
                    StreamingDotsView()
                    Text("Generating...")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.top, 2)
            }

            // Toggle buttons (bottom-left)
            HStack(spacing: 6) {
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { showDebug.toggle() } }) {
                    HStack(spacing: 3) {
                        Image(systemName: showDebug ? "ladybug.fill" : "bubble.left.fill")
                            .font(.system(size: 9))
                        Text(showDebug ? "Debug" : "Message")
                            .font(.system(size: 9, weight: .medium))
                    }
                    .foregroundStyle(showDebug ? .orange : .secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color(UIColor.tertiarySystemFill)))
                }
                .buttonStyle(PlainButtonStyle())
                if !isStreaming && !showDebug {
                    Button(action: { withAnimation(.easeInOut(duration: 0.15)) { renderMarkdown.toggle() } }) {
                        HStack(spacing: 3) {
                            Text(renderMarkdown ? "📝" : "📄")
                                .font(.system(size: 9))
                            Text(renderMarkdown ? "Md" : "Txt")
                                .font(.system(size: 9, weight: .medium))
                        }
                        .foregroundStyle(renderMarkdown ? .blue : .secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color(UIColor.tertiarySystemFill)))
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                Spacer()
            }
        }
        // Auto-switch to markdown when query completes
        .onChange(of: isStreaming) { _, streaming in
            if !streaming {
                withAnimation(.easeInOut(duration: 0.15)) {
                    renderMarkdown = true
                }
            }
        }
    }
}

// MARK: - Message Mode Views

struct MessageModeEventView: View {
    let event: SdkEvent
    let isStreaming: Bool
    var renderMarkdown: Bool = false

    var body: some View {
        switch event.type {
        case "text":
            MessageModeTextView(event: event, renderMarkdown: renderMarkdown)
        case "thinking":
            MessageModeThinkingView(event: event, isStreaming: isStreaming)
        case "tool_use":
            MessageModeToolUseView(event: event, isStreaming: isStreaming)
        case "tool_result":
            MessageModeToolResultView(event: event, isStreaming: isStreaming)
        default:
            EmptyView()
        }
    }
}

private struct MessageModeTextView: View {
    let event: SdkEvent
    var renderMarkdown: Bool = false
    @State private var existingPaths: Set<String> = []
    @State private var previewFilePath: String? = nil

    private var content: String {
        guard let data = event.data, case .string(let c) = data["content"] else { return "" }
        return c
            .replacingOccurrences(of: "\\n?\\[SUMMARY:[^\\n]*\\]?", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\n?\\[SUGGESTIONS:[^\\n]*\\]?", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        if !content.isEmpty {
            Group {
                if renderMarkdown {
                    MarkdownContentView(content: content)
                } else if existingPaths.isEmpty {
                    InlineSelectableText(
                        text: content,
                        font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular),
                        textColor: .label
                    )
                } else {
                    FileLinkedTextView(
                        text: content,
                        font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular),
                        textColor: .label,
                        existingPaths: existingPaths,
                        onPathTap: { path in
                            previewFilePath = path
                        }
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .sheet(isPresented: Binding(
                get: { previewFilePath != nil },
                set: { if !$0 { previewFilePath = nil } }
            )) {
                if let path = previewFilePath {
                    FilePreviewSheet(
                        filePath: path,
                        fileName: (path as NSString).lastPathComponent
                    )
                }
            }
            .task(id: content) {
                let detected = extractFilePaths(from: content)
                guard !detected.isEmpty else { return }
                let found = await probeFilePaths(detected)
                existingPaths = found
            }
        }
    }
}

// MARK: - Markdown Content View

private struct MarkdownContentView: View {
    let content: String

    private enum TableAlignment {
        case left, center, right
    }

    private enum BlockKind {
        case text(String)
        case code(language: String, content: String)
        case table(headers: [String], alignments: [TableAlignment], rows: [[String]])
    }

    private struct ContentBlock: Identifiable {
        let id = UUID()
        let kind: BlockKind
    }

    private var blocks: [ContentBlock] {
        // First pass: split by code fences
        var rawBlocks: [(isCode: Bool, language: String, text: String)] = []
        let lines = content.components(separatedBy: "\n")
        var buffer: [String] = []
        var inCode = false
        var lang = ""

        for line in lines {
            if !inCode && line.hasPrefix("```") {
                let text = buffer.joined(separator: "\n")
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    rawBlocks.append((false, "", text))
                }
                buffer = []
                inCode = true
                lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if inCode && line.hasPrefix("```") {
                rawBlocks.append((true, lang, buffer.joined(separator: "\n")))
                buffer = []
                inCode = false
                lang = ""
            } else {
                buffer.append(line)
            }
        }
        if !buffer.isEmpty {
            let text = buffer.joined(separator: "\n")
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                rawBlocks.append((inCode, inCode ? lang : "", text))
            }
        }

        // Second pass: extract tables from text blocks
        var result: [ContentBlock] = []
        for raw in rawBlocks {
            if raw.isCode {
                result.append(ContentBlock(kind: .code(language: raw.language, content: raw.text)))
            } else {
                result.append(contentsOf: extractTables(from: raw.text))
            }
        }
        return result
    }

    // MARK: Table Detection

    private func extractTables(from text: String) -> [ContentBlock] {
        let lines = text.components(separatedBy: "\n")
        var result: [ContentBlock] = []
        var textBuffer: [String] = []
        var i = 0

        while i < lines.count {
            if i + 2 <= lines.count,
               isTableRow(lines[i]),
               i + 1 < lines.count && isTableSeparator(lines[i + 1]) {
                let accum = textBuffer.joined(separator: "\n")
                if !accum.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    result.append(ContentBlock(kind: .text(accum)))
                }
                textBuffer = []

                let headers = parseTableRow(lines[i])
                let alignments = parseAlignments(lines[i + 1], count: headers.count)
                var rows: [[String]] = []
                var j = i + 2
                while j < lines.count && isTableRow(lines[j]) {
                    rows.append(parseTableRow(lines[j]))
                    j += 1
                }
                result.append(ContentBlock(kind: .table(headers: headers, alignments: alignments, rows: rows)))
                i = j
            } else {
                textBuffer.append(lines[i])
                i += 1
            }
        }

        let accum = textBuffer.joined(separator: "\n")
        if !accum.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(ContentBlock(kind: .text(accum)))
        }
        return result
    }

    private func isTableRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.contains("|") && !trimmed.hasPrefix("```")
    }

    private func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("|") && trimmed.contains("-") else { return false }
        let allowed = CharacterSet(charactersIn: "|-: ")
        return trimmed.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private func parseTableRow(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s = String(s.dropFirst()) }
        if s.hasSuffix("|") { s = String(s.dropLast()) }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private func parseAlignments(_ line: String, count: Int) -> [TableAlignment] {
        let cells = parseTableRow(line)
        return (0..<count).map { idx in
            guard idx < cells.count else { return .left }
            let c = cells[idx].trimmingCharacters(in: .whitespaces)
            if c.hasPrefix(":") && c.hasSuffix(":") { return .center }
            if c.hasSuffix(":") { return .right }
            return .left
        }
    }

    private func swiftUIAlignment(_ a: TableAlignment) -> Alignment {
        switch a {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }

    // MARK: Body

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { block in
                switch block.kind {
                case .code(let language, let code):
                    codeBlockView(language: language, code: code)
                case .text(let text):
                    inlineMarkdownView(text)
                case .table(let headers, let alignments, let rows):
                    tableView(headers: headers, alignments: alignments, rows: rows)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Code Block

    private func codeBlockView(language: String, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !language.isEmpty {
                Text(language)
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
            }
            InlineSelectableText(
                text: code,
                font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .callout).pointSize, weight: .regular),
                textColor: .label
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(8)
    }

    // MARK: Inline Markdown

    @ViewBuilder
    private func inlineMarkdownView(_ text: String) -> some View {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: text, options: options) {
            Text(attributed)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Table

    @ViewBuilder
    private func tableView(headers: [String], alignments: [TableAlignment], rows: [[String]]) -> some View {
        let colCount = headers.count
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                // Header
                GridRow {
                    ForEach(0..<colCount, id: \.self) { idx in
                        Text(headers[idx])
                            .font(.caption)
                            .fontWeight(.semibold)
                            .fontDesign(.monospaced)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: swiftUIAlignment(idx < alignments.count ? alignments[idx] : .left))
                    }
                }
                .background(Color(UIColor.tertiarySystemBackground))

                // Separator
                GridRow {
                    Rectangle()
                        .fill(Color(UIColor.separator))
                        .frame(height: 1)
                        .gridCellColumns(colCount)
                }

                // Data rows
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    GridRow {
                        ForEach(0..<colCount, id: \.self) { colIdx in
                            Text(colIdx < row.count ? row[colIdx] : "")
                                .font(.caption)
                                .fontDesign(.monospaced)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: swiftUIAlignment(colIdx < alignments.count ? alignments[colIdx] : .left))
                        }
                    }
                    .background(rowIdx % 2 == 1 ? Color(UIColor.secondarySystemBackground).opacity(0.3) : Color.clear)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(UIColor.separator), lineWidth: 0.5)
        )
    }
}

private struct MessageModeThinkingView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool = false

    private var content: String {
        guard let data = event.data, case .string(let c) = data["content"] else { return "" }
        return c
    }

    /// Single-line preview with newlines collapsed
    private var thinkingPreview: String {
        content.components(separatedBy: .newlines).joined(separator: " ")
    }

    var body: some View {
        if !content.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                        Text("🧠")
                            .font(.caption)
                        Text("Thinking")
                            .font(.callout)
                            .fontDesign(.monospaced)
                            .layoutPriority(1)
                        if !expanded {
                            Text(thinkingPreview)
                                .font(.caption)
                                .fontDesign(.monospaced)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                    .foregroundColor(.orange.opacity(0.8))
                }
                .buttonStyle(PlainButtonStyle())

                if expanded {
                    InlineSelectableText(
                        text: content,
                        font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .subheadline).pointSize, weight: .regular),
                        textColor: .secondaryLabel
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

private struct MessageModeToolUseView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool = false

    private var toolName: String {
        guard let data = event.data, case .string(let name) = data["toolName"] else { return "unknown" }
        return name
    }

    private var input: String {
        guard let data = event.data, case .string(let c) = data["input"] else { return "" }
        return c
    }

    /// Parse the input JSON string into a dictionary
    private var inputDict: [String: Any]? {
        guard let data = input.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    private var toolIcon: String {
        switch toolName {
        case "Read", "ReadFile": return "📖"
        case "Write", "WriteFile": return "✏️"
        case "Edit", "EditFile": return "✏️"
        case "Bash", "bash": return "💻"
        case "Glob": return "🔍"
        case "Grep": return "🔍"
        case "Agent": return "🤖"
        case "ToolSearch": return "🔎"
        default: return "🔧"
        }
    }

    /// Smart summary based on tool type
    private var summary: String {
        let dict = inputDict
        switch toolName {
        case "Read", "ReadFile", "Write", "WriteFile", "Edit", "EditFile":
            if let path = dict?["file_path"] as? String ?? dict?["path"] as? String {
                return truncatePath(path)
            }
            return String(input.prefix(20)) + (input.count > 20 ? "..." : "")
        case "Bash", "bash":
            if let desc = dict?["description"] as? String, !desc.isEmpty {
                return String(desc.prefix(60))
            }
            if let cmd = dict?["command"] as? String {
                return String(cmd.prefix(60))
            }
            return String(input.prefix(20)) + (input.count > 20 ? "..." : "")
        case "Glob":
            if let pattern = dict?["pattern"] as? String { return pattern }
            return String(input.prefix(20)) + (input.count > 20 ? "..." : "")
        case "Grep":
            if let pattern = dict?["pattern"] as? String { return pattern }
            return String(input.prefix(20)) + (input.count > 20 ? "..." : "")
        default:
            let firstLine = input.components(separatedBy: .newlines).first ?? ""
            return String(firstLine.prefix(60))
        }
    }

    /// Truncate file path to show the trailing portion: ...path/to/file.swift
    private func truncatePath(_ path: String, maxLength: Int = 50) -> String {
        if path.count <= maxLength { return path }
        return "..." + String(path.suffix(maxLength))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                HStack(spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .medium))
                    Text(toolIcon)
                        .font(.caption)
                    Text(toolName)
                        .font(.callout)
                        .fontDesign(.monospaced)
                        .fontWeight(.medium)
                    if !expanded && !summary.isEmpty {
                        Text(summary)
                            .font(.caption)
                            .fontDesign(.monospaced)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer()
                }
                .foregroundColor(.cyan)
            }
            .buttonStyle(PlainButtonStyle())

            if expanded && !input.isEmpty {
                InlineSelectableText(
                    text: input,
                    font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular),
                    textColor: .secondaryLabel
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 18)
                .padding(.top, 4)
            }
        }
    }
}

private struct MessageModeToolResultView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool = false

    private var content: String {
        guard let data = event.data, case .string(let c) = data["content"] else { return "" }
        return c
    }

    private var isError: Bool {
        guard let data = event.data, case .bool(let e) = data["isError"] else { return false }
        return e
    }

    private var charCount: Int {
        if let data = event.data, case .number(let n) = data["length"] { return Int(n) }
        return content.count
    }

    /// Single-line preview with newlines collapsed
    private var resultPreview: String {
        content.components(separatedBy: .newlines).joined(separator: " ")
    }

    private var charCountLabel: String {
        "(\(charCount) chars)"
    }

    var body: some View {
        if !content.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                        Text("📋")
                            .font(.caption)
                        Circle()
                            .fill(isError ? Color.red : Color.green)
                            .frame(width: 6, height: 6)
                        Text("Result")
                            .font(.callout)
                            .fontDesign(.monospaced)
                            .layoutPriority(1)
                        if !expanded {
                            Text(resultPreview)
                                .font(.caption)
                                .fontDesign(.monospaced)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(charCountLabel)
                                .font(.caption)
                                .fontDesign(.monospaced)
                                .lineLimit(1)
                                .layoutPriority(1)
                        }
                    }
                    .foregroundColor(isError ? .red : .secondary)
                }
                .buttonStyle(PlainButtonStyle())

                if expanded {
                    InlineSelectableText(
                        text: content.count > 300 ? String(content.prefix(300)) + "\n… (truncated)" : content,
                        font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular),
                        textColor: isError ? .systemRed : .secondaryLabel
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 18)
                    .padding(.top, 4)
                }
            }
        }
    }
}

// MARK: - Cron Result View (from persisted session history — result event with execSessionId)

private struct CronResultView: View {
    let event: SdkEvent
    var onResumeSession: ((String) -> Void)? = nil

    private var execSessionId: String {
        guard let data = event.data, case .string(let sid) = data["execSessionId"] else { return "" }
        return sid
    }

    private var durationMs: Double {
        guard let data = event.data, case .number(let ms) = data["durationMs"] else { return 0 }
        return ms
    }

    private var costUsd: Double? {
        guard let data = event.data, case .number(let c) = data["costUsd"] else { return nil }
        return c
    }

    private var isError: Bool {
        guard let data = event.data, case .bool(let e) = data["isError"] else { return false }
        return e
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundColor(isError ? .red : .green)
                    .font(.system(size: 13))
                Text(event.detail ?? (isError ? "Failed" : "Completed"))
                    .font(.caption)
                    .fontDesign(.monospaced)
                    .foregroundColor(.secondary)
                if let cost = costUsd {
                    Text("$\(String(format: "%.4f", cost))")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                }
                Spacer()
            }

            if !execSessionId.isEmpty, let action = onResumeSession {
                Button(action: { action(execSessionId) }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.right.circle")
                            .font(.system(size: 12))
                        Text("View Execution Details")
                            .font(.caption)
                            .fontDesign(.monospaced)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10))
                    }
                    .foregroundColor(.blue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.blue.opacity(0.08))
                    .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
            }
        }
    }
}

// MARK: - Cron Task Completed View

private struct CronTaskCompletedView: View {
    let event: SdkEvent
    var onResumeSession: ((String) -> Void)? = nil

    private var cronJobName: String {
        guard let data = event.data, case .string(let name) = data["cronJobName"], !name.isEmpty else {
            if let data = event.data, case .string(let id) = data["cronJobId"] { return id }
            return "Task"
        }
        return name
    }

    private var execSessionId: String {
        guard let data = event.data, case .string(let sid) = data["execSessionId"] else { return "" }
        return sid
    }

    private var success: Bool {
        guard let data = event.data, case .bool(let s) = data["success"] else { return false }
        return s
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: success ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundColor(success ? .green : .red)
                    .font(.system(size: 14))
                Text("Scheduled Task: \(cronJobName)")
                    .font(.callout)
                    .fontDesign(.monospaced)
                    .fontWeight(.medium)
                Spacer()
            }

            if !execSessionId.isEmpty, let action = onResumeSession {
                Button(action: { action(execSessionId) }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.right.circle")
                            .font(.system(size: 12))
                        Text("View Execution Details")
                            .font(.caption)
                            .fontDesign(.monospaced)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10))
                    }
                    .foregroundColor(.blue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.blue.opacity(0.08))
                    .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
            }
        }
        .padding(10)
        .background(Color(UIColor.secondarySystemBackground).opacity(0.5))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(success ? Color.green.opacity(0.3) : Color.red.opacity(0.3), lineWidth: 0.5)
        )
    }
}

struct MessageBubbleView: View {
    let message: ChatMessage
    let isRunning: Bool
    @State private var expandThinking = false
    @State private var selectableText: SelectableTextItem?

    private func formatMessageTime(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let calendar = Calendar.current

        if calendar.isDateInToday(date) {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: date)
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "M月d日 HH:mm"
            return formatter.string(from: date)
        }
    }

    var body: some View {
        Group {
            if message.role == "user" {
                userBubble
            } else if message.role == "system" && !(message.toolCalls?.isEmpty ?? true) {
                VStack(spacing: 4) {
                    ForEach(message.toolCalls!) { tool in
                        ToolCallView(tool: tool)
                    }
                }
            } else if message.role == "system" {
                systemBubble
            } else if message.role == "assistant" {
                assistantBubble
            }
        }
        .sheet(item: $selectableText) { item in
            SelectableTextSheet(text: item.content)
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                if let images = message.images, !images.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(images.indices, id: \.self) { idx in
                            let img = images[idx]
                            if let urlStr = img.url, !urlStr.isEmpty,
                               let serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url"),
                               let fullURL = URL(string: serverURL + urlStr) {
                                AsyncImage(url: fullURL) { image in
                                    image
                                        .resizable()
                                        .scaledToFit()
                                        .frame(maxHeight: 128)
                                        .cornerRadius(8)
                                } placeholder: {
                                    ProgressView()
                                        .frame(width: 64, height: 64)
                                }
                            } else if let data = Data(base64Encoded: img.data),
                                      let uiImage = UIImage(data: data) {
                                Image(uiImage: uiImage)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(maxHeight: 128)
                                    .cornerRadius(8)
                            }
                        }
                    }
                }
                InlineSelectableText(
                    text: message.content,
                    font: .systemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .medium),
                    textColor: .white,
                    tintColor: .white,
                    hugsContent: true
                )
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .background(
                        LinearGradient(
                            colors: [Color.blue, Color.blue.opacity(0.85)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: Color.blue.opacity(0.35), radius: 6, x: 0, y: 3)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Color.white.opacity(0.2), lineWidth: 1)
                    )
                Text(formatMessageTime(message.timestamp))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.trailing, 4)
            }
            .frame(maxWidth: UIScreen.main.bounds.width * 0.80, alignment: .trailing)
        }
    }

    private var systemBubble: some View {
        Group {
            if !message.content.isEmpty || message.costUsd != nil {
                HStack(spacing: 4) {
                    if !message.content.isEmpty {
                        Text(message.content)
                    }
                    if let cost = message.costUsd {
                        Text("($\(String(format: "%.4f", cost)) | \(String(format: "%.1f", (message.durationMs ?? 0) / 1000))s)")
                            .foregroundColor(.secondary.opacity(0.7))
                    }
                }
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)
            }
        }
    }

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Thinking - collapsible
            if let thinking = message.thinking, !thinking.isEmpty {
                Button(action: { expandThinking.toggle() }) {
                    HStack(spacing: 4) {
                        Text(expandThinking ? "−" : "+")
                            .font(.caption)
                        Text("Thinking...")
                            .font(.caption)
                        Spacer()
                    }
                    .foregroundColor(.orange.opacity(0.8))
                }
                .buttonStyle(PlainButtonStyle())

                if expandThinking {
                    InlineSelectableText(
                        text: thinking,
                        font: .preferredFont(forTextStyle: .caption1),
                        textColor: .secondaryLabel
                    )
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(UIColor.secondarySystemBackground))
                    .cornerRadius(8)
                }
            }

            // Content
            if !message.content.isEmpty {
                InlineSelectableText(
                    text: message.content,
                    font: .preferredFont(forTextStyle: .body),
                    textColor: .label
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Timestamp
            Text(formatMessageTime(message.timestamp))
                .font(.caption2)
                .foregroundColor(.secondary)
                .padding(.leading, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            if message.thinking != nil && !message.thinking!.isEmpty {
                expandThinking = isRunning
            }
        }
        .onChange(of: isRunning) { _, running in
            if !running && message.thinking != nil && !message.thinking!.isEmpty {
                withAnimation {
                    expandThinking = false
                }
            }
        }
    }
}

// MARK: - Selectable Text Sheet

struct SelectableTextItem: Identifiable {
    let id = UUID()
    let content: String
}

struct SelectableTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            SelectableTextView(text: text)
                .padding()
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Done") { dismiss() }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: {
                            UIPasteboard.general.string = text
                        }) {
                            Label("Copy All", systemImage: "doc.on.doc")
                        }
                    }
                }
        }
    }
}

struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = .systemFont(ofSize: 16)
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.backgroundColor = .clear
        return textView
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        uiView.text = text
    }
}

/// Inline selectable text using UITextView — supports native text selection
/// within ScrollView without gesture conflicts.
struct InlineSelectableText: UIViewRepresentable {
    let text: String
    var font: UIFont = .preferredFont(forTextStyle: .body)
    var textColor: UIColor = .label
    var tintColor: UIColor? = nil
    /// When true, the view shrinks to fit its text content instead of filling available width.
    var hugsContent: Bool = false

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.font = font
        tv.textColor = textColor
        if let tint = tintColor {
            tv.tintColor = tint
        }
        let hug: UILayoutPriority = hugsContent ? .defaultHigh : .defaultLow
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.setContentHuggingPriority(hug, for: .horizontal)
        return tv
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text {
            uiView.text = text
            uiView.invalidateIntrinsicContentSize()
        }
        uiView.font = font
        uiView.textColor = textColor
        if let tint = tintColor {
            uiView.tintColor = tint
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxWidth = proposal.width ?? UIScreen.main.bounds.width
        let fitted = uiView.sizeThatFits(CGSize(width: maxWidth, height: CGFloat.greatestFiniteMagnitude))
        let width = hugsContent ? min(ceil(fitted.width), maxWidth) : maxWidth
        return CGSize(width: width, height: fitted.height)
    }
}

// MARK: - Tool Call View

struct ToolCallView: View {
    let tool: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            Button(action: { expanded.toggle() }) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)
                    Text(tool.name)
                        .font(.caption)
                        .fontDesign(.monospaced)
                        .foregroundColor(.cyan)
                    Text(summarizeInput())
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer()
                    Text(expanded ? "−" : "+")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(UIColor.secondarySystemBackground).opacity(0.5))
            }
            .buttonStyle(PlainButtonStyle())

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    // Input
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Input:")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        InlineSelectableText(
                            text: formatJSON(tool.input),
                            font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular),
                            textColor: .secondaryLabel
                        )
                    }

                    // Result
                    if let result = tool.result {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Result:")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                            InlineSelectableText(
                                text: truncate(result, max: 300),
                                font: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular),
                                textColor: tool.isError == true ? .systemRed : .secondaryLabel
                            )
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(UIColor.secondarySystemBackground).opacity(0.3))
            }
        }
        .background(Color(UIColor.secondarySystemBackground).opacity(0.3))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(UIColor.separator), lineWidth: 0.5)
        )
    }

    private var statusColor: Color {
        if tool.isError == true { return .red }
        if tool.result != nil { return .green }
        return .orange
    }

    private func summarizeInput() -> String {
        guard case .object(let dict) = tool.input else { return "" }

        switch tool.name {
        case "Read", "ReadFile":
            if case .string(let path) = dict["file_path"] ?? dict["path"] { return path }
        case "Write", "WriteFile", "Edit", "EditFile":
            if case .string(let path) = dict["file_path"] ?? dict["path"] { return path }
        case "Bash", "bash":
            if case .string(let cmd) = dict["command"] { return String(cmd.prefix(60)) }
        case "Glob", "Grep":
            if case .string(let pat) = dict["pattern"] { return pat }
        default:
            break
        }
        return ""
    }

    private func formatJSON(_ value: JSONValue) -> String {
        switch value {
        case .object(let dict):
            var items: [String] = []
            for (k, v) in dict {
                items.append("\(k): \(formatValue(v))")
            }
            return items.joined(separator: ", ")
        case .array(let arr):
            return arr.map { formatValue($0) }.joined(separator: ", ")
        default:
            return formatValue(value)
        }
    }

    private func formatValue(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .number(let n): return String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        default: return "..."
        }
    }

    private func truncate(_ str: String, max: Int) -> String {
        if str.count <= max { return str }
        return String(str.prefix(max)) + "\n... (truncated)"
    }
}

// MARK: - Streaming Dots Animation

struct StreamingDotsView: View {
    @State private var phase: Int = 0

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 4, height: 4)
                    .opacity(phase == index ? 1.0 : 0.3)
            }
        }
        .onAppear {
            Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                withAnimation(.easeInOut(duration: 0.2)) {
                    phase = (phase + 1) % 3
                }
            }
        }
    }
}
