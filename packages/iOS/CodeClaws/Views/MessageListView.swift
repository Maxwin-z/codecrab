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
                    if !group.agentEvents.isEmpty {
                        AgentResponseView(events: group.agentEvents, isStreaming: isRunning && index == turnGroups.count - 1)
                    }
                }

                // Running indicator (when no SDK events are flowing yet)
                if isRunning && sdkEvents.isEmpty {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 8, height: 8)
                        Text("Processing...")
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                }
            }
        }
    }
}

// MARK: - Agent Response View (with message/debug toggle)

struct AgentResponseView: View {
    let events: [SdkEvent]
    let isStreaming: Bool
    @State private var showDebug = false

    private static let messageTypes: Set<String> = ["thinking", "text", "tool_use", "tool_result"]

    private var messageEvents: [SdkEvent] {
        events.filter { Self.messageTypes.contains($0.type) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: showDebug ? 2 : 4) {
            if showDebug {
                ForEach(events) { event in
                    SdkEventInlineView(event: event)
                }
            } else {
                ForEach(messageEvents) { event in
                    MessageModeEventView(event: event, isStreaming: isStreaming)
                }
            }

            // Toggle button (bottom-right)
            HStack {
                Spacer()
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
            }
        }
    }
}

// MARK: - Message Mode Views

struct MessageModeEventView: View {
    let event: SdkEvent
    let isStreaming: Bool

    var body: some View {
        switch event.type {
        case "text":
            MessageModeTextView(event: event)
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

    private var content: String {
        guard let data = event.data, case .string(let c) = data["content"] else { return "" }
        return c
    }

    var body: some View {
        if !content.isEmpty {
            Text(content)
                .font(.body)
                .fontDesign(.monospaced)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}

private struct MessageModeThinkingView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool

    init(event: SdkEvent, isStreaming: Bool) {
        self.event = event
        self.isStreaming = isStreaming
        self._expanded = State(initialValue: isStreaming)
    }

    private var content: String {
        guard let data = event.data, case .string(let c) = data["content"] else { return "" }
        return c
    }

    var body: some View {
        if !content.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                        Text("Thinking")
                            .font(.callout)
                            .fontDesign(.monospaced)
                        Spacer()
                    }
                    .foregroundColor(.orange.opacity(0.8))
                }
                .buttonStyle(PlainButtonStyle())

                if expanded {
                    Text(content)
                        .font(.subheadline)
                        .fontDesign(.monospaced)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
            .onChange(of: isStreaming) { _, streaming in
                if !streaming {
                    withAnimation { expanded = false }
                }
            }
        }
    }
}

private struct MessageModeToolUseView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool

    init(event: SdkEvent, isStreaming: Bool) {
        self.event = event
        self.isStreaming = isStreaming
        self._expanded = State(initialValue: isStreaming)
    }

    private var toolName: String {
        guard let data = event.data, case .string(let name) = data["toolName"] else { return "unknown" }
        return name
    }

    private var input: String {
        guard let data = event.data, case .string(let c) = data["input"] else { return "" }
        return c
    }

    private var summary: String {
        let firstLine = input.components(separatedBy: .newlines).first ?? ""
        return String(firstLine.prefix(60))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                HStack(spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .medium))
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
                Text(input)
                    .font(.caption)
                    .fontDesign(.monospaced)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 18)
                    .padding(.top, 4)
                    .textSelection(.enabled)
            }
        }
        .onChange(of: isStreaming) { _, streaming in
            if !streaming {
                withAnimation { expanded = false }
            }
        }
    }
}

private struct MessageModeToolResultView: View {
    let event: SdkEvent
    let isStreaming: Bool
    @State private var expanded: Bool

    init(event: SdkEvent, isStreaming: Bool) {
        self.event = event
        self.isStreaming = isStreaming
        self._expanded = State(initialValue: isStreaming)
    }

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

    var body: some View {
        if !content.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                        Circle()
                            .fill(isError ? Color.red : Color.green)
                            .frame(width: 6, height: 6)
                        Text("Result")
                            .font(.callout)
                            .fontDesign(.monospaced)
                        Text("\(charCount) chars")
                            .font(.caption)
                            .fontDesign(.monospaced)
                        Spacer()
                    }
                    .foregroundColor(isError ? .red : .secondary)
                }
                .buttonStyle(PlainButtonStyle())

                if expanded {
                    Text(content.count > 2000 ? String(content.prefix(2000)) + "\n… (truncated)" : content)
                        .font(.caption)
                        .fontDesign(.monospaced)
                        .foregroundColor(isError ? .red : .secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 18)
                        .padding(.top, 4)
                        .textSelection(.enabled)
                }
            }
            .onChange(of: isStreaming) { _, streaming in
                if !streaming {
                    withAnimation { expanded = false }
                }
            }
        }
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
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(images.indices, id: \.self) { idx in
                                if let data = Data(base64Encoded: images[idx].data),
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
                }
                Text(message.content)
                    .font(.body)
                    .fontWeight(.medium)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .background(
                        LinearGradient(
                            colors: [Color.blue, Color.blue.opacity(0.85)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: Color.blue.opacity(0.35), radius: 6, x: 0, y: 3)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Color.white.opacity(0.2), lineWidth: 1)
                    )
                    .onLongPressGesture {
                        selectableText = SelectableTextItem(content: message.content)
                    }
                Text(formatMessageTime(message.timestamp))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.trailing, 4)
            }
            .frame(maxWidth: UIScreen.main.bounds.width * 0.85, alignment: .trailing)
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
                    Text(thinking)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(UIColor.secondarySystemBackground))
                        .cornerRadius(8)
                        .onLongPressGesture {
                            selectableText = SelectableTextItem(content: thinking)
                        }
                }
            }

            // Content
            if !message.content.isEmpty {
                Text(message.content)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onLongPressGesture {
                        selectableText = SelectableTextItem(content: message.content)
                    }
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

// MARK: - Tool Call View

struct ToolCallView: View {
    let tool: ToolCall
    @State private var expanded = false
    @State private var selectableText: SelectableTextItem?

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
                        Text(formatJSON(tool.input))
                            .font(.caption)
                            .fontDesign(.monospaced)
                            .foregroundColor(.secondary)
                    }
                    .onLongPressGesture {
                        selectableText = SelectableTextItem(content: formatJSON(tool.input))
                    }

                    // Result
                    if let result = tool.result {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Result:")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                            Text(truncate(result, max: 2000))
                                .font(.caption)
                                .fontDesign(.monospaced)
                                .foregroundColor(tool.isError == true ? .red : .secondary)
                        }
                        .onLongPressGesture {
                            selectableText = SelectableTextItem(content: result)
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
        .sheet(item: $selectableText) { item in
            SelectableTextSheet(text: item.content)
        }
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
