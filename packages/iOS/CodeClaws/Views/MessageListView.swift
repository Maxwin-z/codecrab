import SwiftUI

struct MessageListView: View {
    let messages: [ChatMessage]
    let streamingText: String
    let streamingThinking: String
    let isRunning: Bool
    
    var body: some View {
        VStack(spacing: 16) {
            if messages.isEmpty && streamingText.isEmpty && streamingThinking.isEmpty {
                VStack(spacing: 16) {
                    Text("CodeClaws")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    Text("Send a message to start")
                        .foregroundColor(.secondary)
                }
                .padding(.top, 100)
            } else {
                ForEach(messages) { msg in
                    MessageBubbleView(message: msg)
                }
                
                if isRunning {
                    if !streamingThinking.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Thinking:")
                                .font(.caption)
                                .foregroundColor(.orange)
                            Text(streamingThinking)
                                .font(.body)
                        }
                        .padding()
                        .background(Color(UIColor.secondarySystemBackground))
                        .cornerRadius(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if !streamingText.isEmpty {
                        Text(streamingText)
                            .padding()
                            .background(Color(UIColor.secondarySystemBackground))
                            .cornerRadius(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if streamingThinking.isEmpty {
                        HStack {
                            Circle()
                                .fill(Color.orange)
                                .frame(width: 10, height: 10)
                            Text("Processing...")
                                .foregroundColor(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

struct MessageBubbleView: View {
    let message: ChatMessage
    @State private var expandThinking = false
    @State private var expandTools = false
    
    var body: some View {
        VStack(alignment: message.role == "user" ? .trailing : .leading) {
            if message.role == "user" {
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
                    .padding()
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            } else if message.role == "assistant" {
                VStack(alignment: .leading, spacing: 8) {
                    if let thinking = message.thinking, !thinking.isEmpty {
                        DisclosureGroup("Thinking...", isExpanded: $expandThinking) {
                            Text(thinking)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        .accentColor(.orange)
                    }
                    if !message.content.isEmpty {
                        Text(message.content)
                            .textSelection(.enabled)
                    }
                }
                .padding()
                .background(Color(UIColor.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
            } else if message.role == "system" {
                if let tools = message.toolCalls, !tools.isEmpty {
                    DisclosureGroup("Tools Used (\(tools.count))", isExpanded: $expandTools) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(tools) { tool in
                                VStack(alignment: .leading) {
                                    HStack {
                                        Circle()
                                            .fill(tool.isError == true ? Color.red : (tool.result != nil ? Color.green : Color.orange))
                                            .frame(width: 8, height: 8)
                                        Text(tool.name)
                                            .fontDesign(.monospaced)
                                            .foregroundColor(.cyan)
                                    }
                                    Text(toolInputSummary(name: tool.name, input: tool.input))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(2)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                    .padding()
                    .background(Color(UIColor.tertiarySystemBackground))
                    .cornerRadius(8)
                } else {
                    Text(message.content)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                    if let cost = message.costUsd, let duration = message.durationMs {
                        Text(String(format: "($%.4f | %.1fs)", cost, duration / 1000.0))
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
    }
    
    private func toolInputSummary(name: String, input: JSONValue) -> String {
        switch input {
        case .object(let dict):
            if name == "Read" || name == "Edit", case .string(let path) = dict["file_path"] { return path }
            if name == "Bash", case .string(let cmd) = dict["command"] { return String(cmd.prefix(120)) }
            if name == "Glob" || name == "Grep", case .string(let pat) = dict["pattern"] { return pat }
            return "..."
        default: return ""
        }
    }
}
