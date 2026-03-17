import SwiftUI

struct VoiceSettingsView: View {
    @StateObject private var configStore = VoiceModelConfigStore.shared

    @State private var showApiKey: [String: Bool] = [:]
    @State private var testResult: String = ""
    @State private var isTesting = false

    var body: some View {
        Form {
            // Provider selection
            Section(header: Text("Provider")) {
                Picker("Provider", selection: $configStore.config.provider) {
                    ForEach(VoiceProvider.allCases) { provider in
                        Label(provider.displayName, systemImage: provider.icon)
                            .tag(provider)
                    }
                }
                .onChange(of: configStore.config.provider) { _, newProvider in
                    configStore.config.endpoint = newProvider.defaultEndpoint
                    // Select first model of new provider if current selection doesn't belong
                    if !newProvider.defaultModels.contains(where: { $0.id == configStore.config.selectedModelId }) {
                        configStore.config.selectedModelId = newProvider.defaultModels.first?.id ?? ""
                    }
                }
            }

            // API Keys (per-provider)
            Section(header: Text("API Keys")) {
                ForEach(VoiceProvider.allCases) { provider in
                    let keyBinding = Binding<String>(
                        get: { configStore.config.apiKeys[provider.rawValue] ?? "" },
                        set: { configStore.config.apiKeys[provider.rawValue] = $0 }
                    )
                    let isVisible = showApiKey[provider.rawValue] ?? false

                    VStack(alignment: .leading, spacing: 6) {
                        Text(provider.displayName)
                            .font(.caption)
                            .foregroundColor(.secondary)
                        HStack {
                            if isVisible {
                                TextField("API Key", text: keyBinding)
                                    .autocapitalization(.none)
                                    .disableAutocorrection(true)
                                    .font(.system(.body, design: .monospaced))
                            } else {
                                SecureField("API Key", text: keyBinding)
                            }
                            Button(action: {
                                showApiKey[provider.rawValue] = !isVisible
                            }) {
                                Image(systemName: isVisible ? "eye.slash" : "eye")
                                    .foregroundColor(.secondary)
                                    .frame(width: 28, height: 28)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            // Model selection
            Section(header: Text("Model")) {
                let provider = configStore.config.provider
                let models = provider.defaultModels

                Picker("Model", selection: $configStore.config.selectedModelId) {
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
                    TextField("e.g. gemini-2.5-flash-preview", text: $configStore.config.customModelId)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                }

                HStack {
                    Text("Effective Model")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(configStore.config.effectiveModelId)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundColor(.primary)
                }
            }

            // Endpoint
            Section(header: Text("Endpoint")) {
                TextField("API Endpoint", text: $configStore.config.endpoint)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .font(.system(.body, design: .monospaced))

                Button("Reset to Default") {
                    configStore.config.endpoint = configStore.config.provider.defaultEndpoint
                }
                .font(.caption)
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
                .disabled(isTesting || !configStore.isConfigured)

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
    }

    private func testApiKey() {
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
