import SwiftUI
import PhotosUI

struct InputBarView: View {
    let onSend: (String, [ImageAttachment]?, [String]?) -> Void
    let onAbort: () -> Void
    let onPermissionModeChange: (String) -> Void
    let isRunning: Bool
    let isAborting: Bool
    let currentModel: String
    let permissionMode: String
    let availableMcps: [McpInfo]
    let enabledMcps: [String]
    let onToggleMcp: (String) -> Void
    @Binding var isInputFocused: Bool

    @State private var text: String = ""
    @State private var attachments: [ImageAttachment] = []
    @State private var selectedItem: PhotosPickerItem? = nil
    @State private var showMcpPopover = false
    @FocusState private var isFocused: Bool

    private var isSafe: Bool { permissionMode == "default" }
    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            // Image previews
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments.indices, id: \.self) { idx in
                            if let data = Data(base64Encoded: attachments[idx].data),
                               let uiImage = UIImage(data: data) {
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 56, height: 56)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))

                                    Button(action: { attachments.remove(at: idx) }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.system(size: 16))
                                            .foregroundColor(.white)
                                            .background(Color.black.opacity(0.5).clipShape(Circle()))
                                    }
                                    .offset(x: 4, y: -4)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
            }

            // Text input
            TextField(isRunning ? "Running..." : "Cmd+Enter to send", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .disabled(isRunning)
                .focused($isFocused)
                .onSubmit {
                    send()
                }
                .onChange(of: isRunning) { running in
                    if !running {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            isFocused = true
                        }
                    }
                }
                .onChange(of: isFocused) { _, focused in
                    isInputFocused = focused
                }
                .onChange(of: isInputFocused) { _, focused in
                    isFocused = focused
                }

            // Bottom toolbar
            HStack(spacing: 0) {
                // Left: action buttons
                HStack(spacing: 2) {
                    // Attach images
                    PhotosPicker(selection: $selectedItem, matching: .images) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 17))
                            .foregroundColor(.secondary)
                            .frame(width: 34, height: 34)
                    }
                    .disabled(isRunning)
                    .onChange(of: selectedItem) { _, newItem in
                        Task {
                            if let data = try? await newItem?.loadTransferable(type: Data.self),
                               let image = UIImage(data: data),
                               let attachment = ImageCompressor.compressImage(image) {
                                attachments.append(attachment)
                            }
                        }
                    }

                    // MCP toggle
                    if !availableMcps.isEmpty {
                        Button(action: { showMcpPopover.toggle() }) {
                            Image(systemName: "puzzlepiece.extension")
                                .font(.system(size: 15))
                                .foregroundColor(enabledMcps.count < availableMcps.count ? .orange : .secondary)
                                .frame(width: 34, height: 34)
                        }
                        .disabled(isRunning)
                        .popover(isPresented: $showMcpPopover) {
                            McpPopoverView(
                                mcps: availableMcps,
                                enabledMcps: enabledMcps,
                                onToggle: onToggleMcp
                            )
                        }
                    }

                    // Image count indicator
                    if !attachments.isEmpty {
                        Text("\(attachments.count) image\(attachments.count > 1 ? "s" : "")")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .padding(.leading, 4)
                    }
                }

                Spacer()

                // Right: permission mode + model + send/abort
                HStack(spacing: 8) {
                    // Safe / YOLO toggle
                    Button(action: {
                        onPermissionModeChange(isSafe ? "bypassPermissions" : "default")
                    }) {
                        HStack(spacing: 3) {
                            Image(systemName: isSafe ? "shield" : "bolt.fill")
                                .font(.system(size: 10))
                            Text(isSafe ? "Safe" : "YOLO")
                                .font(.caption2).bold()
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(isSafe ? Color.green.opacity(0.12) : Color.orange.opacity(0.12))
                        .foregroundColor(isSafe ? .green : .orange)
                        .cornerRadius(8)
                    }
                    .disabled(isRunning)
                    .buttonStyle(.plain)

                    // Model name
                    Text(currentModel)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .fontDesign(.monospaced)
                        .lineLimit(1)

                    // Send / Abort button
                    if isRunning {
                        Button(action: onAbort) {
                            if isAborting {
                                ProgressView()
                                    .frame(width: 32, height: 32)
                            } else {
                                Image(systemName: "stop.fill")
                                    .font(.system(size: 12))
                                    .frame(width: 32, height: 32)
                                    .background(Color.red)
                                    .foregroundColor(.white)
                                    .clipShape(Circle())
                            }
                        }
                    } else {
                        Button(action: send) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 32, height: 32)
                                .background(canSend ? Color.primary : Color.gray.opacity(0.3))
                                .foregroundColor(canSend ? Color(UIColor.systemBackground) : .gray)
                                .clipShape(Circle())
                        }
                        .disabled(!canSend)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: -2)
    }

    private func send() {
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty || !attachments.isEmpty else { return }
        onSend(msg, attachments.isEmpty ? nil : attachments, enabledMcps)
        text = ""
        attachments.removeAll()
    }
}

// MARK: - MCP Popover

private struct McpPopoverView: View {
    let mcps: [McpInfo]
    let enabledMcps: [String]
    let onToggle: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("MCP Servers")
                    .font(.caption).bold()
                Text("Toggle servers for this query")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(mcps) { mcp in
                        let isEnabled = enabledMcps.contains(mcp.id)
                        Button(action: { onToggle(mcp.id) }) {
                            HStack(spacing: 10) {
                                Text(mcp.icon ?? "🔌")
                                    .font(.body)
                                    .frame(width: 24)

                                VStack(alignment: .leading, spacing: 1) {
                                    Text(mcp.name)
                                        .font(.caption)
                                        .fontWeight(.medium)
                                        .foregroundColor(.primary)
                                        .lineLimit(1)
                                    Text(mcp.description)
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer()

                                Text("\(mcp.toolCount) tools")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)

                                Toggle("", isOn: Binding(
                                    get: { isEnabled },
                                    set: { _ in onToggle(mcp.id) }
                                ))
                                .labelsHidden()
                                .scaleEffect(0.75)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                        }
                    }
                }
            }
        }
        .frame(width: 300, height: min(CGFloat(mcps.count) * 52 + 60, 320))
    }
}
