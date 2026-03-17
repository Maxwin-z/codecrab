import SwiftUI

struct VoiceSettingsView: View {
    @StateObject private var configStore = VoiceModelConfigStore.shared

    @State private var editConfig: VoiceModelConfig = .default
    @State private var showApiKey = false
    @State private var hasChanges = false
    @State private var testResult: String = ""
    @State private var isTesting = false

    private var currentApiKey: String {
        editConfig.apiKeys[editConfig.provider.rawValue] ?? ""
    }

    private var apiKeyBinding: Binding<String> {
        Binding<String>(
            get: { editConfig.apiKeys[editConfig.provider.rawValue] ?? "" },
            set: {
                editConfig.apiKeys[editConfig.provider.rawValue] = $0
                hasChanges = true
            }
        )
    }

    private var maskedApiKey: String {
        let key = currentApiKey
        guard key.count > 6 else { return key.isEmpty ? "未设置" : key }
        let visible = String(key.prefix(6))
        let masked = String(repeating: "•", count: min(key.count - 6, 20))
        return visible + masked
    }

    var body: some View {
        Form {
            // Provider selection
            Section(header: Text("Provider")) {
                Picker("Provider", selection: $editConfig.provider) {
                    ForEach(VoiceProvider.allCases) { provider in
                        Label(provider.displayName, systemImage: provider.icon)
                            .tag(provider)
                    }
                }
                .onChange(of: editConfig.provider) { _, newProvider in
                    editConfig.endpoint = newProvider.defaultEndpoint
                    if !newProvider.defaultModels.contains(where: { $0.id == editConfig.selectedModelId }) {
                        editConfig.selectedModelId = newProvider.defaultModels.first?.id ?? ""
                    }
                    showApiKey = false
                    hasChanges = true
                }
            }

            // Connection (API Key + Endpoint) for selected provider only
            Section(header: Text("Connection")) {
                // API Key
                VStack(alignment: .leading, spacing: 6) {
                    Text("API Key")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    HStack {
                        if showApiKey || currentApiKey.isEmpty {
                            TextField("Enter API Key", text: apiKeyBinding)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .font(.system(.body, design: .monospaced))
                        } else {
                            Text(maskedApiKey)
                                .font(.system(.body, design: .monospaced))
                                .foregroundColor(.primary)
                                .onTapGesture { showApiKey = true }
                            Spacer()
                        }
                        if !currentApiKey.isEmpty {
                            Button(action: { showApiKey.toggle() }) {
                                Image(systemName: showApiKey ? "eye.slash" : "eye")
                                    .foregroundColor(.secondary)
                                    .frame(width: 28, height: 28)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.vertical, 2)

                // Endpoint
                VStack(alignment: .leading, spacing: 6) {
                    Text("Endpoint")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    TextField("API Endpoint", text: Binding(
                        get: { editConfig.endpoint },
                        set: { editConfig.endpoint = $0; hasChanges = true }
                    ))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                    if editConfig.endpoint != editConfig.provider.defaultEndpoint {
                        Button("Reset to Default") {
                            editConfig.endpoint = editConfig.provider.defaultEndpoint
                            hasChanges = true
                        }
                        .font(.caption)
                    }
                }
                .padding(.vertical, 2)
            }

            // Model selection for selected provider only
            Section(header: Text("Model")) {
                let models = editConfig.provider.defaultModels

                Picker("Model", selection: Binding(
                    get: { editConfig.selectedModelId },
                    set: { editConfig.selectedModelId = $0; hasChanges = true }
                )) {
                    ForEach(models) { model in
                        VStack(alignment: .leading) {
                            Text(model.displayName)
                            Text(model.description)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                        .tag(model.id)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Custom Model ID (overrides selection above)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    TextField("e.g. gemini-2.5-flash-preview", text: Binding(
                        get: { editConfig.customModelId },
                        set: { editConfig.customModelId = $0; hasChanges = true }
                    ))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                }

                HStack {
                    Text("Effective Model")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(editConfig.effectiveModelId)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundColor(.primary)
                }
            }

            // Test
            Section {
                Button(action: testApiKey) {
                    HStack {
                        Text("Test API Key")
                        Spacer()
                        if isTesting {
                            ProgressView()
                        }
                    }
                }
                .disabled(isTesting || currentApiKey.trimmingCharacters(in: .whitespaces).isEmpty)

                if !testResult.isEmpty {
                    Text(testResult)
                        .font(.caption)
                        .foregroundColor(testResult.hasPrefix("OK") ? .green : .red)
                }
            }

            // Context settings link
            Section(header: Text("Context")) {
                NavigationLink(destination: VoiceContextSettingsView()) {
                    HStack {
                        Image(systemName: "brain")
                        Text("Voice Context & Vocabulary")
                    }
                }
            }
        }
        .navigationTitle("Voice Input")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Save") {
                    configStore.config = editConfig
                    hasChanges = false
                }
                .fontWeight(.semibold)
                .disabled(!hasChanges)
            }
        }
        .onAppear {
            editConfig = configStore.config
            hasChanges = false
        }
    }

    private func testApiKey() {
        // Save first so the service uses current edits
        configStore.config = editConfig
        hasChanges = false

        isTesting = true
        testResult = ""

        Task {
            do {
                let service = MultimodalVoiceService()
                let result = try await service.completeText(
                    message: "Reply with exactly: OK",
                    systemPrompt: "You are a test assistant. Reply with exactly the word OK.",
                    config: configStore.config
                )
                testResult = result.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("OK")
                    ? "OK - API key works"
                    : "OK - Got response: \(String(result.prefix(50)))"
            } catch {
                testResult = "Error: \(error.localizedDescription)"
            }
            isTesting = false
        }
    }
}
