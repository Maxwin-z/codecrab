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

    @State private var providers: [ProviderConfig] = []
    @State private var defaultProviderId: String? = nil
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

            Section(header: Text("Default Provider")) {
                if providers.isEmpty {
                    Text("No providers configured")
                        .foregroundColor(.secondary)
                } else {
                    Picker("Select Provider", selection: Binding(
                        get: { defaultProviderId ?? "" },
                        set: { newId in
                            defaultProviderId = newId
                            setDefaultProvider(newId)
                        }
                    )) {
                        ForEach(providers) { provider in
                            Text(provider.name).tag(provider.id)
                        }
                    }
                }
            }

            Section(header: Text("Providers")) {
                ForEach(providers) { provider in
                    NavigationLink(destination: ProviderEditView(provider: provider, isNew: false, onSave: fetchProviders)) {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(provider.name).font(.headline)
                                Text(provider.provider).font(.caption).foregroundColor(.secondary)
                            }
                            Spacer()
                            if provider.id == defaultProviderId {
                                Image(systemName: "star.fill").foregroundColor(.yellow)
                            }
                        }
                    }
                }
                .onDelete(perform: deleteProvider)

                Button("Add Provider") {
                    showAddModel = true
                }

                Button("Use Claude Code CLI") {
                    registerCLIProvider()
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
            fetchProviders()
            checkCLI()
        }
        .sheet(isPresented: $showAddModel) {
            NavigationView {
                ProviderEditView(provider: nil, isNew: true, onSave: fetchProviders)
            }
        }
    }
    
    private func fetchProviders() {
        Task {
            do {
                struct ProvidersResp: Codable { let providers: [ProviderConfig]; let defaultProviderId: String? }
                let resp: ProvidersResp = try await APIClient.shared.fetch(path: "/api/setup/providers")
                self.providers = resp.providers
                self.defaultProviderId = resp.defaultProviderId
            } catch {
                print("Fetch providers error: \(error)")
            }
        }
    }
    
    private func checkCLI() {
        Task {
            do {
                struct AuthInfo: Codable { let loggedIn: Bool; let authMethod: String?; let subscriptionType: String? }
                struct ProbeResp: Codable { let claudeCodeInstalled: Bool; let cliAvailable: Bool; let cliVersion: String?; let auth: AuthInfo? }
                let resp: ProbeResp = try await APIClient.shared.fetch(path: "/api/setup/detect/probe")
                if resp.cliAvailable {
                    let authStr = resp.auth?.loggedIn == true ? " - Auth OK" : " - Needs Auth"
                    cliStatus = "Installed (\(resp.cliVersion ?? "unknown"))" + authStr
                } else if resp.claudeCodeInstalled {
                    cliStatus = "Config found, CLI not in PATH"
                } else {
                    cliStatus = "Not Installed"
                }
            } catch {
                cliStatus = "Check Failed"
            }
        }
    }
    
    private func setDefaultProvider(_ id: String) {
        Task {
            do {
                struct Req: Encodable { let providerId: String }
                try await APIClient.shared.request(path: "/api/setup/default-provider", method: "PUT", body: Req(providerId: id))
            } catch {
                print("Set default provider error: \(error)")
            }
        }
    }

    private func deleteProvider(at offsets: IndexSet) {
        let ids = offsets.map { providers[$0].id }
        for id in ids {
            Task {
                try? await APIClient.shared.request(path: "/api/setup/providers/\(id)", method: "DELETE")
                fetchProviders()
            }
        }
    }

    private func registerCLIProvider() {
        Task {
            do {
                struct Req: Encodable { let subscriptionType: String? = nil }
                try await APIClient.shared.request(path: "/api/setup/use-claude", method: "POST", body: Req())
                fetchProviders()
            } catch {
                print("Register CLI error: \(error)")
            }
        }
    }
}

struct ProviderEditView: View {
    @Environment(\.dismiss) var dismiss

    let providerId: String?
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

    let providerTypes = ["anthropic", "openai", "google", "custom"]

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

    init(provider config: ProviderConfig?, isNew: Bool, onSave: @escaping () -> Void) {
        self.providerId = config?.id
        self.isNew = isNew
        self.onSave = onSave
        let key = config?.apiKey ?? ""
        self.maskedKey = key.isEmpty ? nil : key
        _name = State(initialValue: config?.name ?? "")
        _provider = State(initialValue: config?.provider ?? "anthropic")
        _baseUrl = State(initialValue: config?.baseUrl ?? "")
    }

    var body: some View {
        Form {
            Section(header: Text("Details")) {
                TextField("Name", text: $name)
                Picker("Provider", selection: $provider) {
                    ForEach(providerTypes, id: \.self) { p in
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
                    Text(testResult).font(.caption).foregroundColor(testResult.contains("OK") ? .green : .red)
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
        .navigationTitle(isNew ? "New Provider" : "Edit Provider")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func testKey() {
        guard let id = providerId, !isNew else {
            testResult = "Save provider first to test."
            return
        }
        isTesting = true
        Task {
            do {
                struct TestResp: Codable { let ok: Bool; let error: String?; let skipped: Bool?; let message: String? }
                let resp: TestResp = try await APIClient.shared.fetch(path: "/api/setup/providers/\(id)/test", method: "POST")
                if resp.ok {
                    testResult = resp.skipped == true ? "OK (skipped: \(resp.message ?? "CLI OAuth"))" : "OK"
                } else {
                    testResult = "Error: \(resp.error ?? "Unknown error")"
                }
            } catch {
                testResult = "Error: \(error.localizedDescription)"
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
                    try await APIClient.shared.request(path: "/api/setup/providers", method: "POST", body: body)
                } else if let id = providerId {
                    try await APIClient.shared.request(path: "/api/setup/providers/\(id)", method: "PUT", body: body)
                }
                onSave()
                dismiss()
            } catch {
                print("Save provider error: \(error)")
                isSaving = false
            }
        }
    }
}
