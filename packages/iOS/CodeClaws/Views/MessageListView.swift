import SwiftUI

struct MessageListView: View {
    let messages: [ChatMessage]
    let streamingText: String
    let streamingThinking: String
    let isRunning: Bool

    var body: some View {
        VStack(spacing: 16) {
            if !messages.isEmpty || !streamingText.isEmpty || !streamingThinking.isEmpty || isRunning {
                ForEach(messages) { msg in
                    MessageBubbleView(message: msg, isRunning: isRunning)
                }

                // Streaming thinking
                if !streamingThinking.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Thinking:")
                            .font(.caption)
                            .foregroundColor(.orange)
                        Text(streamingThinking)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(UIColor.secondarySystemBackground))
                    .cornerRadius(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Streaming text
                if !streamingText.isEmpty {
                    Text(streamingText)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Running indicator
                if isRunning && streamingText.isEmpty && streamingThinking.isEmpty {
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

struct MessageBubbleView: View {
    let message: ChatMessage
    let isRunning: Bool
    @State private var expandThinking = false
    @State private var selectableText: SelectableTextItem?

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
            VStack(alignment: .trailing, spacing: 8) {
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
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .onLongPressGesture {
                        selectableText = SelectableTextItem(content: message.content)
                    }
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
