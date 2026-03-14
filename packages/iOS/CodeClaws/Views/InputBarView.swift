import SwiftUI
import PhotosUI
import Speech

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
    var sdkLoaded: Bool = false
    var onProbeSdk: (() -> Void)? = nil
    var projectPath: String = ""
    @Binding var isInputFocused: Bool
    @Binding var prefillText: String
    @Binding var externalAttachments: [ImageAttachment]

    @State private var text: String = ""
    @State private var attachments: [ImageAttachment] = []
    @State private var selectedItem: PhotosPickerItem? = nil
    @State private var showMcpPopover = false
    @State private var sdkProbing = false
    @State private var showLocalePicker = false
    @State private var micPulse = false
    @State private var showFileMention = false
    @State private var mentionQuery = ""
    @State private var mentionStartIndex: String.Index?
    @StateObject private var speechService = SpeechService()
    @FocusState private var isFocused: Bool

    private var isSafe: Bool { permissionMode == "default" }
    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            // File mention overlay
            if showFileMention && !projectPath.isEmpty {
                FileMentionOverlayView(
                    query: mentionQuery,
                    projectPath: projectPath,
                    onSelect: { result in
                        insertFileMention(result)
                    },
                    onDismiss: {
                        showFileMention = false
                        mentionStartIndex = nil
                    }
                )
                .padding(.horizontal, 4)
                .padding(.bottom, 4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Attachment previews (images + files)
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments.indices, id: \.self) { idx in
                            let attachment = attachments[idx]
                            ZStack(alignment: .topTrailing) {
                                if attachment.mediaType.hasPrefix("image/"),
                                   let data = Data(base64Encoded: attachment.data),
                                   let uiImage = UIImage(data: data) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 56, height: 56)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                } else {
                                    // Non-image file
                                    VStack(spacing: 2) {
                                        Image(systemName: fileIcon(for: attachment.mediaType))
                                            .font(.system(size: 20))
                                            .foregroundColor(.orange)
                                        Text(attachment.name ?? "File")
                                            .font(.system(size: 7))
                                            .lineLimit(2)
                                            .multilineTextAlignment(.center)
                                            .foregroundColor(.secondary)
                                    }
                                    .frame(width: 56, height: 56)
                                    .background(Color(UIColor.tertiarySystemFill))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                }

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
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
            }

            // Text input
            TextField(
                speechService.isRecording ? "Listening..." : "Send message to \(currentModel.isEmpty ? "Claude Code" : currentModel)",
                text: $text,
                axis: .vertical
            )
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .focused($isFocused)
                .onSubmit {
                    send()
                }
                .onChange(of: isFocused) { _, focused in
                    isInputFocused = focused
                }
                .onChange(of: isInputFocused) { _, focused in
                    isFocused = focused
                }
                .onChange(of: speechService.transcribedText) { _, newText in
                    if speechService.isRecording {
                        text = newText
                    }
                }
                .onChange(of: text) { _, newText in
                    detectFileMention(in: newText)
                }

            // Bottom toolbar
            HStack(spacing: 0) {
                // Left: permission mode + action buttons
                HStack(spacing: 2) {
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
                    .buttonStyle(.plain)

                    // Attach images
                    PhotosPicker(selection: $selectedItem, matching: .images) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 17))
                            .foregroundColor(.secondary)
                            .frame(width: 34, height: 34)
                    }
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
                        Button(action: {
                            if !sdkLoaded && !sdkProbing, let probe = onProbeSdk {
                                sdkProbing = true
                                probe()
                            } else {
                                showMcpPopover.toggle()
                            }
                        }) {
                            if sdkProbing {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .frame(width: 34, height: 34)
                            } else {
                                Image(systemName: "puzzlepiece.extension")
                                    .font(.system(size: 15))
                                    .foregroundColor(
                                        enabledMcps.count < availableMcps.count
                                            ? .orange
                                            : sdkLoaded ? .green : .secondary
                                    )
                                    .frame(width: 34, height: 34)
                            }
                        }
                        .disabled(sdkProbing)
                        .sheet(isPresented: $showMcpPopover) {
                            McpPanelView(
                                mcps: availableMcps,
                                enabledMcps: enabledMcps,
                                onToggle: onToggleMcp,
                                onSkillTap: { skillName in
                                    text = "/\(skillName) "
                                    showMcpPopover = false
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                        isFocused = true
                                    }
                                },
                                onDismiss: { showMcpPopover = false }
                            )
                            .presentationDetents([.medium, .large])
                            .presentationDragIndicator(.visible)
                        }
                        .onChange(of: sdkLoaded) { _, loaded in
                            if sdkProbing && loaded {
                                sdkProbing = false
                                showMcpPopover = true
                            }
                        }
                    }

                    // Attachment count indicator
                    if !attachments.isEmpty {
                        let imageCount = attachments.filter { $0.mediaType.hasPrefix("image/") }.count
                        let fileCount = attachments.count - imageCount
                        let label = [
                            imageCount > 0 ? "\(imageCount) image\(imageCount > 1 ? "s" : "")" : nil,
                            fileCount > 0 ? "\(fileCount) file\(fileCount > 1 ? "s" : "")" : nil
                        ].compactMap { $0 }.joined(separator: ", ")
                        Text(label)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .padding(.leading, 4)
                    }
                }

                Spacer()

                // Right: voice + send (+ abort when running)
                HStack(spacing: 8) {
                    // Voice input
                    if speechService.isRecording {
                        Button(action: { speechService.stopRecording() }) {
                            micButtonLabel
                        }
                    } else {
                        Menu {
                            let currentId = speechService.selectedLocale.identifier
                            Button {
                                speechService.changeLocale(Locale(identifier: "en-US"))
                            } label: {
                                Label("English", systemImage: currentId.hasPrefix("en") ? "checkmark" : "")
                            }
                            Button {
                                speechService.changeLocale(Locale(identifier: "zh-Hans-CN"))
                            } label: {
                                Label("简体中文", systemImage: currentId.hasPrefix("zh-Hans") ? "checkmark" : "")
                            }
                            Divider()
                            Button {
                                showLocalePicker = true
                            } label: {
                                Label("More Languages...", systemImage: "globe")
                            }
                        } label: {
                            micButtonLabel
                        } primaryAction: {
                            toggleRecording()
                        }
                    }

                    // Send button (always visible)
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
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
        }
        .background(Color(UIColor.systemBackground))
        .cornerRadius(16)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color(UIColor.separator), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 6, x: 0, y: 2)
        .onChange(of: prefillText) { _, newValue in
            if !newValue.isEmpty {
                text = newValue
                prefillText = ""
                isFocused = true
            }
        }
        .onChange(of: speechService.isRecording) { _, recording in
            if recording {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    micPulse = true
                }
            } else {
                withAnimation(.easeOut(duration: 0.2)) { micPulse = false }
            }
        }
        .onChange(of: speechService.authorizationStatus) { _, status in
            if status == .authorized {
                speechService.startRecording(existingText: text)
            }
        }
        .sheet(isPresented: $showLocalePicker) {
            LocalePickerView(
                locales: speechService.supportedLocales,
                selected: speechService.selectedLocale
            ) { locale in
                speechService.changeLocale(locale)
                showLocalePicker = false
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: externalAttachments) { _, newAttachments in
            if !newAttachments.isEmpty {
                attachments.append(contentsOf: newAttachments)
                externalAttachments = []
                isFocused = true
            }
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("text/") { return "doc.text" }
        if mimeType.contains("pdf") { return "doc.richtext" }
        if mimeType.contains("json") { return "curlybraces" }
        if mimeType.contains("zip") || mimeType.contains("archive") { return "doc.zipper" }
        if mimeType.contains("video") { return "film" }
        if mimeType.contains("audio") { return "waveform" }
        return "doc"
    }

    @ViewBuilder
    private var micButtonLabel: some View {
        ZStack {
            Image(systemName: speechService.isRecording ? "mic.fill" : "mic")
                .font(.system(size: 14))
                .foregroundColor(speechService.isRecording ? .white : Color(UIColor.systemBackground))
                .frame(width: 32, height: 32)
                .background(speechService.isRecording ? Color.red : Color.gray.opacity(0.3))
                .clipShape(Circle())
                .scaleEffect(micPulse ? 1.15 : 1.0)

            // Locale badge
            if !speechService.isRecording {
                Text(speechService.selectedLocale.language.languageCode?.identifier.uppercased() ?? "")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 3)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.8))
                    .clipShape(Capsule())
                    .offset(x: 9, y: 10)
            }
        }
    }

    private func toggleRecording() {
        switch speechService.authorizationStatus {
        case .notDetermined:
            speechService.requestAuthorization()
        case .authorized:
            speechService.startRecording(existingText: text)
        default:
            break
        }
    }

    private func localeDisplayName(_ locale: Locale) -> String {
        Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier
    }

    private func send() {
        if speechService.isRecording {
            speechService.stopRecording()
        }
        showFileMention = false
        mentionStartIndex = nil
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty || !attachments.isEmpty else { return }
        speechService.learnFromEdit(msg)
        onSend(msg, attachments.isEmpty ? nil : attachments, enabledMcps)
        text = ""
        attachments.removeAll()
    }

    // MARK: - @ File Mention

    private func detectFileMention(in newText: String) {
        guard !projectPath.isEmpty else { return }

        // Find the last `@` that could be a file mention trigger
        // It should be at the start or preceded by a space/newline
        guard let atRange = newText.range(of: "@", options: .backwards) else {
            if showFileMention {
                showFileMention = false
                mentionStartIndex = nil
            }
            return
        }

        let atIndex = atRange.lowerBound
        let isAtStart = atIndex == newText.startIndex
        let charBefore = isAtStart ? nil : newText[newText.index(before: atIndex)]
        let validTrigger = isAtStart || charBefore == " " || charBefore == "\n"

        guard validTrigger else {
            if showFileMention {
                showFileMention = false
                mentionStartIndex = nil
            }
            return
        }

        // Extract query text after @
        let afterAt = newText[newText.index(after: atIndex)...]
        // If there's a space in the query, the mention is "closed" — hide overlay
        if afterAt.contains(" ") {
            if showFileMention {
                showFileMention = false
                mentionStartIndex = nil
            }
            return
        }

        let query = String(afterAt)
        mentionStartIndex = atIndex
        mentionQuery = query
        withAnimation(.easeOut(duration: 0.15)) {
            showFileMention = true
        }
    }

    private func insertFileMention(_ result: FileSearchResult) {
        guard let startIdx = mentionStartIndex else { return }
        // Replace @query with the relative path
        let before = String(text[text.startIndex..<startIdx])
        let mention = "@\(result.relativePath) "
        text = before + mention
        withAnimation(.easeOut(duration: 0.15)) {
            showFileMention = false
        }
        mentionStartIndex = nil
        mentionQuery = ""
    }
}

// MARK: - MCP Panel (Sheet)

private struct McpPanelView: View {
    let mcps: [McpInfo]
    let enabledMcps: [String]
    let onToggle: (String) -> Void
    let onSkillTap: (String) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("MCP Servers & Skills")
                        .font(.subheadline).fontWeight(.semibold)
                    Text("Toggle servers and skills for this query")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }

                Spacer()

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            // List
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(mcps) { mcp in
                        let isEnabled = enabledMcps.contains(mcp.id)
                        let isSkill = mcp.source == "skill"

                        HStack(spacing: 12) {
                            // Icon
                            Text(mcp.icon ?? "🔌")
                                .font(.body)
                                .frame(width: 24)

                            // Name + description (tappable for skills)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(mcp.name)
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .foregroundColor(.primary)
                                        .lineLimit(1)

                                    if let source = mcp.source, source != "custom" {
                                        Text(source == "sdk" ? "SDK" : "Skill")
                                            .font(.system(size: 9, weight: .semibold))
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 2)
                                            .background(source == "sdk" ? Color.blue.opacity(0.12) : Color.purple.opacity(0.12))
                                            .foregroundColor(source == "sdk" ? .blue : .purple)
                                            .cornerRadius(4)
                                    }
                                }

                                HStack(spacing: 4) {
                                    Text(mcp.description.count > 60
                                        ? String(mcp.description.prefix(57)) + "..."
                                        : mcp.description)
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)

                                    if isSkill {
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 8, weight: .semibold))
                                            .foregroundColor(.secondary)
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if isSkill {
                                    onSkillTap(mcp.name)
                                }
                            }

                            // Tool count + toggle
                            HStack(spacing: 6) {
                                if mcp.toolCount > 0 {
                                    Text("\(mcp.toolCount) tools")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                }

                                Toggle("", isOn: Binding(
                                    get: { isEnabled },
                                    set: { _ in onToggle(mcp.id) }
                                ))
                                .labelsHidden()
                                .scaleEffect(0.75)
                                .fixedSize()
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }
}

// MARK: - Locale Picker (Sheet)

private struct LocalePickerView: View {
    let locales: [Locale]
    let selected: Locale
    let onSelect: (Locale) -> Void

    @State private var search = ""

    private var filtered: [Locale] {
        if search.isEmpty { return locales }
        let q = search.lowercased()
        return locales.filter { locale in
            let name = Locale.current.localizedString(forIdentifier: locale.identifier)?.lowercased() ?? ""
            return name.contains(q) || locale.identifier.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            List(filtered, id: \.identifier) { locale in
                Button {
                    onSelect(locale)
                } label: {
                    HStack {
                        Text(Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier)
                            .foregroundColor(.primary)
                        Spacer()
                        Text(locale.identifier)
                            .font(.caption)
                            .foregroundColor(.secondary)
                        if locale.identifier == selected.identifier {
                            Image(systemName: "checkmark")
                                .foregroundColor(.accentColor)
                        }
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search languages")
            .navigationTitle("Speech Language")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
