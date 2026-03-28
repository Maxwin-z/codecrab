import SwiftUI
import PhotosUI
import Speech

struct InputBarView: View {
    let onSend: (String, [ImageAttachment]?, [String]?) -> Bool
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
    @State private var showCanvas = false
    @State private var showCamera = false
    @State private var showLocalePicker = false
    @State private var micPulse = false
    @State private var showFileMention = false
    @State private var mentionQuery = ""
    @State private var mentionStartIndex: String.Index?
    @StateObject private var speechService = SpeechService()
    @FocusState private var isFocused: Bool

    // LLM voice recording state
    @AppStorage("voiceInputMode") private var lastVoiceMode: String = "apple"
    @State private var isLLMRecording = false
    @State private var llmAudioLevel: Float = 0
    @State private var llmAudioLevels: [Float] = []
    @State private var llmPeakAudioLevel: Float = 0
    @State private var llmRecordingDuration: TimeInterval = 0
    @State private var llmRecordingTimer: Timer?
    @State private var isLLMTranscribing = false
    @State private var voiceHint: String? = nil
    @State private var llmRecorder = LLMAudioRecorderService()
    @State private var llmVoiceService = MultimodalVoiceService()

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

            // Apple speech listening indicator
            if speechService.isRecording {
                HStack(spacing: 8) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 8, height: 8)
                        .scaleEffect(micPulse ? 1.3 : 1.0)
                    Text("Listening...")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.red)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.08))
                .cornerRadius(8)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .transition(.opacity)
            }

            // LLM recording overlay
            if isLLMRecording {
                LLMRecordingOverlayView(
                    audioLevels: llmAudioLevels,
                    duration: llmRecordingDuration,
                    maxDuration: LLMAudioRecorderService.maxDuration,
                    onCancel: { cancelLLMRecording() }
                )
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }

            // Voice hint (no voice detected / too short)
            if let hint = voiceHint {
                HStack(spacing: 6) {
                    Image(systemName: "waveform.slash")
                        .font(.caption)
                        .foregroundColor(.orange)
                    Text(hint)
                        .font(.caption)
                        .foregroundColor(.orange)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .transition(.opacity)
            }

            // Transcribing indicator
            if isLLMTranscribing {
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                        .tint(.blue)
                    Text("Transcribing...")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.blue)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.blue.opacity(0.08))
                .cornerRadius(8)
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }

            // Text input
            TextField(
                speechService.isRecording ? "Listening..." : (isLLMRecording ? "Recording..." : "Send message to \(currentModel.isEmpty ? "Claude Code" : currentModel)"),
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
                if speechService.isRecording || isLLMRecording {
                    // === Recording mode: Cancel + Done (send hidden to prevent accidental sends) ===
                    Button(action: {
                        if isLLMRecording { cancelLLMRecording() }
                        else { speechService.stopRecording() }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .semibold))
                            Text("Cancel")
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    Button(action: {
                        if isLLMRecording { stopLLMRecording() }
                        else { speechService.stopRecording() }
                    }) {
                        HStack(spacing: 5) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.white)
                                .frame(width: 10, height: 10)
                            Text("Done")
                                .font(.subheadline)
                                .fontWeight(.semibold)
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(Color.red)
                        .clipShape(Capsule())
                    }
                } else {
                    // === Normal mode ===
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

                        // Canvas (iPad only)
                        if UIDevice.current.userInterfaceIdiom == .pad {
                            Button(action: { showCanvas = true }) {
                                Image(systemName: "pencil.tip.crop.circle")
                                    .font(.system(size: 17))
                                    .foregroundColor(.secondary)
                                    .frame(width: 34, height: 34)
                            }
                            .buttonStyle(.plain)
                        }

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

                        // Camera capture
                        Button(action: { showCamera = true }) {
                            Image(systemName: "camera")
                                .font(.system(size: 16))
                                .foregroundColor(.secondary)
                                .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)

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

                    // Right: voice + send
                    HStack(spacing: 12) {
                        // Voice input menu
                        Menu {
                            // Level 1: LLM Voice
                            Button {
                                lastVoiceMode = "llm"
                                startLLMRecording()
                            } label: {
                                let configured = VoiceModelConfigStore.shared.isConfigured
                                Label(
                                    configured ? "LLM Voice" : "LLM Voice (not configured)",
                                    systemImage: "waveform"
                                )
                            }
                            .disabled(!VoiceModelConfigStore.shared.isConfigured)

                            Divider()

                            // Level 2: Apple Built-in (with language sub-menu)
                            Menu {
                                let currentId = speechService.selectedLocale.identifier
                                Button {
                                    lastVoiceMode = "apple"
                                    speechService.changeLocale(Locale(identifier: "en-US"))
                                    toggleRecording()
                                } label: {
                                    Label("English", systemImage: currentId.hasPrefix("en") ? "checkmark" : "")
                                }
                                Button {
                                    lastVoiceMode = "apple"
                                    speechService.changeLocale(Locale(identifier: "zh-Hans-CN"))
                                    toggleRecording()
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
                                Label("Apple Built-in", systemImage: "mic")
                            }
                        } label: {
                            if lastVoiceMode == "llm" {
                                llmMicButtonLabel
                            } else {
                                micButtonLabel
                            }
                        } primaryAction: {
                            // Primary tap: use last selected voice mode
                            if lastVoiceMode == "llm" && VoiceModelConfigStore.shared.isConfigured {
                                startLLMRecording()
                            } else {
                                toggleRecording()
                            }
                        }

                        // Send button
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
            .padding(.bottom, 4)
            .animation(.easeInOut(duration: 0.2), value: speechService.isRecording || isLLMRecording)
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
                isFocused = false
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
        .fullScreenCover(isPresented: $showCanvas) {
            CanvasView(
                onDone: { image in
                    showCanvas = false
                    if let attachment = ImageCompressor.compressImage(image) {
                        attachments.append(attachment)
                    }
                },
                onCancel: { showCanvas = false }
            )
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPickerView(
                onCapture: { image in
                    showCamera = false
                    if let attachment = ImageCompressor.compressImage(image) {
                        attachments.append(attachment)
                    }
                },
                onCancel: { showCamera = false }
            )
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

    @ViewBuilder
    private var llmMicButtonLabel: some View {
        ZStack {
            Image(systemName: "waveform")
                .font(.system(size: 14))
                .foregroundColor(isLLMRecording ? .white : Color(UIColor.systemBackground))
                .frame(width: 32, height: 32)
                .background(isLLMRecording ? Color.red : Color.gray.opacity(0.3))
                .clipShape(Circle())
                .scaleEffect(micPulse ? 1.15 : 1.0)
        }
    }

    private func toggleRecording() {
        switch speechService.authorizationStatus {
        case .notDetermined:
            speechService.requestAuthorization()
        case .authorized:
            // Hide keyboard when recording starts
            isFocused = false
            speechService.startRecording(existingText: text)
        default:
            break
        }
    }

    // MARK: - LLM Voice Recording

    private func startLLMRecording() {
        guard !isLLMRecording else { return }

        // Hide keyboard when recording starts
        isFocused = false

        llmRecorder.onAudioLevel = { [self] level in
            Task { @MainActor in
                self.llmAudioLevel = level
                if level > self.llmPeakAudioLevel {
                    self.llmPeakAudioLevel = level
                }
                // Keep rolling window of recent levels for waveform
                self.llmAudioLevels.append(level)
                let maxBars = 40
                if self.llmAudioLevels.count > maxBars {
                    self.llmAudioLevels.removeFirst(self.llmAudioLevels.count - maxBars)
                }
            }
        }

        do {
            try llmRecorder.startRecording()
            isLLMRecording = true
            llmRecordingDuration = 0
            llmPeakAudioLevel = 0

            // Duration timer
            llmRecordingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                Task { @MainActor in
                    self.llmRecordingDuration = self.llmRecorder.duration
                    // Auto-stop at max duration
                    if self.llmRecordingDuration >= LLMAudioRecorderService.maxDuration {
                        self.stopLLMRecording()
                    }
                }
            }

            // Pulse animation
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                micPulse = true
            }
        } catch {
            print("LLM recording start failed: \(error)")
        }
    }

    /// Cancel recording without transcription
    private func cancelLLMRecording() {
        guard isLLMRecording else { return }

        llmRecordingTimer?.invalidate()
        llmRecordingTimer = nil
        _ = llmRecorder.stopRecording()
        isLLMRecording = false
        llmAudioLevel = 0
        llmAudioLevels = []
        llmRecordingDuration = 0
        llmPeakAudioLevel = 0
        withAnimation(.easeOut(duration: 0.2)) { micPulse = false }
    }

    private func stopLLMRecording() {
        guard isLLMRecording else { return }

        llmRecordingTimer?.invalidate()
        llmRecordingTimer = nil
        let samples = llmRecorder.stopRecording()
        let duration = llmRecordingDuration
        let peakLevel = llmPeakAudioLevel
        isLLMRecording = false
        llmAudioLevel = 0
        llmAudioLevels = []
        llmRecordingDuration = 0
        llmPeakAudioLevel = 0
        withAnimation(.easeOut(duration: 0.2)) { micPulse = false }

        guard !samples.isEmpty else { return }

        print("[Voice] duration=\(String(format: "%.2f", duration))s, samples=\(samples.count), peakRMS=\(String(format: "%.6f", peakLevel))")

        // Short recording with no significant voice → skip transcription (saves tokens)
        if duration < 1.5 && peakLevel < 0.002 {
            print("[Voice] SKIP: short recording (\(String(format: "%.1f", duration))s) with no voice (peak: \(String(format: "%.6f", peakLevel)))")
            showVoiceHint("No voice detected, please try again")
            return
        }

        // Start streaming transcription
        isLLMTranscribing = true
        let configStore = VoiceModelConfigStore.shared
        let contextStore = VoiceContextStore.shared
        let contextLevel = VoiceContextLevel.forDuration(duration)

        // Extract project name from projectPath
        let projectName = projectPath.isEmpty ? nil : (projectPath as NSString).lastPathComponent

        let systemPrompt = MultimodalVoiceService.buildSystemPrompt(
            projectName: projectName,
            contextLevel: contextLevel,
            contextStore: contextStore
        )

        // Capture the text that existed before transcription starts
        let textBeforeTranscription = text
        let separator = textBeforeTranscription.isEmpty ? "" :
            (textBeforeTranscription.hasSuffix(" ") ? "" : " ")

        Task {
            var accumulated = ""
            do {
                let stream = llmVoiceService.stream(
                    audioSamples: samples,
                    systemPrompt: systemPrompt,
                    config: configStore.config
                )
                for try await chunk in stream {
                    accumulated += chunk
                    // Replace the transcription portion while preserving pre-existing text
                    let cleaned = MultimodalVoiceService.stripTranscriptionTags(accumulated)
                    text = textBeforeTranscription + separator + cleaned
                }
            } catch {
                print("LLM transcription error: \(error)")
            }

            isLLMTranscribing = false

            // Record utterance for context accumulation
            let finalText = MultimodalVoiceService.stripTranscriptionTags(accumulated)
            if !finalText.isEmpty {
                VoiceContextService.shared.recordUtterance(finalText)
            }
        }
    }

    private func showVoiceHint(_ message: String) {
        withAnimation(.easeOut(duration: 0.2)) {
            voiceHint = message
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            withAnimation(.easeIn(duration: 0.3)) {
                voiceHint = nil
            }
        }
    }

    private func localeDisplayName(_ locale: Locale) -> String {
        Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier
    }

    private func send() {
        showFileMention = false
        mentionStartIndex = nil
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty || !attachments.isEmpty else { return }
        speechService.learnFromEdit(msg)
        let sent = onSend(msg, attachments.isEmpty ? nil : attachments, enabledMcps)
        guard sent else { return }
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
        // Allow trigger after whitespace, newline, or any non-ASCII char (e.g. CJK).
        // Only reject when preceded by ASCII letter/digit (looks like an email: user@...)
        let isEmailLikeContext = charBefore.map { $0.isASCII && ($0.isLetter || $0.isNumber) } ?? false
        let validTrigger = isAtStart || !isEmailLikeContext

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
