import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct SettingsView: View {
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var wsService: WebSocketService

    @State private var models: [ModelConfig] = []
    @State private var defaultModelId: String? = nil
    @State private var cliStatus: String = "Checking..."

    @State private var showAddModel = false
    @State private var showChangeServerConfirm = false

    var body: some View {
        Form {
            Section(header: Text("Server Info")) {
                HStack {
                    Text("URL")
                    Spacer()
                    Text(auth.getServerURL() ?? "Not set")
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack {
                    Text("CLI Status")
                    Spacer()
                    Text(cliStatus)
                        .foregroundColor(.secondary)
                }
            }

            Section {
                Button {
                    showChangeServerConfirm = true
                } label: {
                    HStack {
                        Image(systemName: "server.rack")
                        Text("Change Server")
                    }
                }
                .confirmationDialog(
                    "Change Server",
                    isPresented: $showChangeServerConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Change Server & Re-login") {
                        wsService.disconnect()
                        auth.clearServerURL()
                        auth.isAuthenticated = false
                        dismiss()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This will disconnect from the current server and return to the login screen to configure a new server address and token.")
                }

                Button("Log Out") {
                    wsService.disconnect()
                    auth.logout()
                    dismiss()
                }
                .foregroundColor(.red)
            }
            
            Section(header: Text("Voice Input")) {
                NavigationLink(destination: VoiceSettingsView()) {
                    HStack {
                        Image(systemName: "waveform")
                        Text("LLM Voice Settings")
                        Spacer()
                        if VoiceModelConfigStore.shared.isConfigured {
                            Text(VoiceModelConfigStore.shared.config.provider.displayName)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        } else {
                            Text("Not configured")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }

            Section(header: Text("Default Model")) {
                if models.isEmpty {
                    Text("No models configured")
                        .foregroundColor(.secondary)
                } else {
                    Picker("Select Model", selection: Binding(
                        get: { defaultModelId ?? "" },
                        set: { newId in
                            defaultModelId = newId
                            setDefaultModel(newId)
                        }
                    )) {
                        ForEach(models) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                }
            }
            
            Section(header: Text("Models")) {
                ForEach(models) { model in
                    NavigationLink(destination: ModelEditView(model: model, isNew: false, onSave: fetchModels)) {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(model.name).font(.headline)
                                Text(model.provider).font(.caption).foregroundColor(.secondary)
                            }
                            Spacer()
                            if model.id == defaultModelId {
                                Image(systemName: "star.fill").foregroundColor(.yellow)
                            }
                        }
                    }
                }
                .onDelete(perform: deleteModel)
                
                Button("Add Model") {
                    showAddModel = true
                }
                
                Button("Use Claude Code CLI") {
                    registerCLIModel()
                }
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
        .onAppear {
            fetchModels()
            checkCLI()
        }
        .sheet(isPresented: $showAddModel) {
            NavigationView {
                ModelEditView(model: nil, isNew: true, onSave: fetchModels)
            }
        }
    }
    
    private func fetchModels() {
        Task {
            do {
                struct ModelsResp: Codable { let models: [ModelConfig]; let defaultModelId: String? }
                let resp: ModelsResp = try await APIClient.shared.fetch(path: "/api/setup/models")
                self.models = resp.models
                self.defaultModelId = resp.defaultModelId
            } catch {
                print("Fetch models error: \(error)")
            }
        }
    }
    
    private func checkCLI() {
        Task {
            do {
                struct ProbeResp: Codable { let installed: Bool; let authenticated: Bool; let version: String? }
                let resp: ProbeResp = try await APIClient.shared.fetch(path: "/api/setup/detect/probe")
                if resp.installed {
                    cliStatus = "Installed (\(resp.version ?? "unknown"))" + (resp.authenticated ? " - Auth OK" : " - Needs Auth")
                } else {
                    cliStatus = "Not Installed"
                }
            } catch {
                cliStatus = "Check Failed"
            }
        }
    }
    
    private func setDefaultModel(_ id: String) {
        Task {
            do {
                struct Req: Encodable { let modelId: String }
                try await APIClient.shared.request(path: "/api/setup/default-model", method: "PUT", body: Req(modelId: id))
            } catch {
                print("Set default model error: \(error)")
            }
        }
    }
    
    private func deleteModel(at offsets: IndexSet) {
        let ids = offsets.map { models[$0].id }
        for id in ids {
            Task {
                try? await APIClient.shared.request(path: "/api/setup/models/\(id)", method: "DELETE")
                fetchModels()
            }
        }
    }
    
    private func registerCLIModel() {
        Task {
            do {
                struct Req: Encodable { let subscriptionType: String? = nil }
                try await APIClient.shared.request(path: "/api/setup/use-claude", method: "POST", body: Req())
                fetchModels()
            } catch {
                print("Register CLI error: \(error)")
            }
        }
    }
}

struct ModelEditView: View {
    @Environment(\.dismiss) var dismiss
    
    let modelId: String?
    let isNew: Bool
    var onSave: () -> Void
    
    @State private var name: String = ""
    @State private var provider: String = "anthropic"
    @State private var apiKey: String = ""
    @State private var baseUrl: String = ""

    @State private var testResult: String = ""
    @State private var isTesting = false
    @State private var isSaving = false

    private let maskedKey: String?

    let providers = ["anthropic", "openai", "google", "custom"]

    private var apiKeyPlaceholder: String {
        if maskedKey != nil {
            return "Enter new key to replace"
        }
        switch provider {
        case "anthropic": return "sk-ant-..."
        case "openai": return "sk-..."
        case "google": return "AIza..."
        default: return "API Key"
        }
    }

    private var maskedKeyDisplay: String? {
        guard let key = maskedKey, !key.isEmpty else { return nil }
        let prefix = String(key.prefix(6))
        return prefix + String(repeating: "•", count: 8)
    }

    init(model: ModelConfig?, isNew: Bool, onSave: @escaping () -> Void) {
        self.modelId = model?.id
        self.isNew = isNew
        self.onSave = onSave
        let key = model?.apiKey ?? ""
        self.maskedKey = key.isEmpty ? nil : key
        _name = State(initialValue: model?.name ?? "")
        _provider = State(initialValue: model?.provider ?? "anthropic")
        _baseUrl = State(initialValue: model?.baseUrl ?? "")
    }
    
    var body: some View {
        Form {
            Section(header: Text("Details")) {
                TextField("Name", text: $name)
                Picker("Provider", selection: $provider) {
                    ForEach(providers, id: \.self) { p in
                        Text(p.capitalized).tag(p)
                    }
                }
                
                VStack(alignment: .leading, spacing: 6) {
                    if let masked = maskedKeyDisplay, apiKey.isEmpty {
                        Text(masked)
                            .font(.system(.body, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                    HStack(spacing: 8) {
                        SecureField(apiKeyPlaceholder, text: $apiKey)
                        Button {
                            #if canImport(UIKit)
                            if let str = UIPasteboard.general.string {
                                apiKey = str
                            }
                            #elseif canImport(AppKit)
                            if let str = NSPasteboard.general.string(forType: .string) {
                                apiKey = str
                            }
                            #endif
                        } label: {
                            Image(systemName: "doc.on.clipboard")
                                .foregroundColor(.accentColor)
                        }
                        .buttonStyle(.borderless)
                    }
                }

                if provider == "custom" {
                    TextField("Base URL", text: $baseUrl)
                        .autocapitalization(.none)
                }
            }
            
            Section {
                Button(action: testKey) {
                    HStack {
                        Text("Test API Key")
                        Spacer()
                        if isTesting { ProgressView() }
                    }
                }
                if !testResult.isEmpty {
                    Text(testResult).font(.caption).foregroundColor(testResult.contains("✅") || testResult.contains("⏭️") ? .green : .red)
                }
            }
            
            Section {
                Button(action: save) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Text("Save")
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .disabled(name.isEmpty || isSaving)
            }
        }
        .navigationTitle(isNew ? "New Model" : "Edit Model")
        .navigationBarTitleDisplayMode(.inline)
    }
    
    private func testKey() {
        guard let id = modelId, !isNew else {
            testResult = "❌ Save model first to test."
            return
        }
        isTesting = true
        Task {
            do {
                struct TestResp: Codable { let ok: Bool; let error: String? }
                let resp: TestResp = try await APIClient.shared.fetch(path: "/api/setup/models/\(id)/test", method: "POST")
                if resp.ok {
                    testResult = "✅ Success"
                } else {
                    testResult = "❌ \(resp.error ?? "Unknown error")"
                }
            } catch {
                testResult = "❌ \(error.localizedDescription)"
            }
            isTesting = false
        }
    }
    
    private func save() {
        isSaving = true
        Task {
            do {
                var body: [String: String] = [
                    "name": name,
                    "provider": provider
                ]
                if !apiKey.isEmpty { body["apiKey"] = apiKey }
                if !baseUrl.isEmpty { body["baseUrl"] = baseUrl }
                
                if isNew {
                    try await APIClient.shared.request(path: "/api/setup/models", method: "POST", body: body)
                } else if let id = modelId {
                    try await APIClient.shared.request(path: "/api/setup/models/\(id)", method: "PUT", body: body)
                }
                onSave()
                dismiss()
            } catch {
                print("Save model error: \(error)")
                isSaving = false
            }
        }
    }
}
