import Combine
import Foundation

// MARK: - Provider

enum VoiceProvider: String, Codable, CaseIterable, Identifiable {
    case gemini
    case dashscope

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .gemini: return "Google Gemini"
        case .dashscope: return "阿里云 Dashscope"
        }
    }

    var icon: String {
        switch self {
        case .gemini: return "globe.americas"
        case .dashscope: return "cloud.fill"
        }
    }

    var defaultEndpoint: String {
        switch self {
        case .gemini: return "https://generativelanguage.googleapis.com/v1beta"
        case .dashscope: return "https://dashscope.aliyuncs.com/compatible-mode/v1"
        }
    }

    var defaultModels: [VoiceModel] {
        switch self {
        case .gemini:
            return [
                VoiceModel(id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", description: "高性价比"),
                VoiceModel(id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", description: "最佳效果"),
                VoiceModel(id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", description: "快速稳定"),
            ]
        case .dashscope:
            return [
                VoiceModel(id: "qwen-omni-turbo", displayName: "Qwen Omni Turbo", description: "快速，中英双语"),
                VoiceModel(id: "qwen3-omni-flash", displayName: "Qwen3 Omni Flash", description: "极速，超低延迟"),
                VoiceModel(id: "qwen2.5-omni-7b", displayName: "Qwen2.5 Omni 7B", description: "开源模型"),
            ]
        }
    }

    /// Whether this provider uses the Gemini native API format (vs OpenAI-compatible)
    var usesGeminiFormat: Bool { self == .gemini }
}

// MARK: - Model

struct VoiceModel: Identifiable, Codable, Hashable {
    let id: String
    let displayName: String
    let description: String
}

// MARK: - Config

struct VoiceModelConfig: Codable {
    var provider: VoiceProvider
    var apiKeys: [String: String]
    var endpoint: String
    var selectedModelId: String
    var customModelId: String

    var apiKey: String {
        get { apiKeys[provider.rawValue] ?? "" }
        set { apiKeys[provider.rawValue] = newValue }
    }

    var effectiveModelId: String {
        let custom = customModelId.trimmingCharacters(in: .whitespaces)
        return custom.isEmpty ? selectedModelId : custom
    }

    var isConfigured: Bool {
        !apiKey.trimmingCharacters(in: .whitespaces).isEmpty
    }

    static let `default` = VoiceModelConfig(
        provider: .gemini,
        apiKeys: [:],
        endpoint: VoiceProvider.gemini.defaultEndpoint,
        selectedModelId: "gemini-2.5-flash",
        customModelId: ""
    )

    // Custom decoding for forward-compatibility
    private enum CodingKeys: String, CodingKey {
        case provider, apiKeys, endpoint, selectedModelId, customModelId
    }

    init(provider: VoiceProvider, apiKeys: [String: String],
         endpoint: String, selectedModelId: String, customModelId: String = "") {
        self.provider = provider
        self.apiKeys = apiKeys
        self.endpoint = endpoint
        self.selectedModelId = selectedModelId
        self.customModelId = customModelId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decodeIfPresent(VoiceProvider.self, forKey: .provider) ?? .gemini
        apiKeys = try c.decodeIfPresent([String: String].self, forKey: .apiKeys) ?? [:]
        endpoint = try c.decodeIfPresent(String.self, forKey: .endpoint) ?? provider.defaultEndpoint
        selectedModelId = try c.decodeIfPresent(String.self, forKey: .selectedModelId) ?? "gemini-2.5-flash"
        customModelId = try c.decodeIfPresent(String.self, forKey: .customModelId) ?? ""
    }
}

// MARK: - Config Store

@MainActor
class VoiceModelConfigStore: ObservableObject {
    static let shared = VoiceModelConfigStore()

    private static let key = "voiceModelConfig"

    @Published var config: VoiceModelConfig {
        didSet { save() }
    }

    var isConfigured: Bool { config.isConfigured }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode(VoiceModelConfig.self, from: data) {
            config = decoded
        } else {
            config = .default
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    /// All models from providers that have a configured API key
    var availableModels: [AvailableVoiceModel] {
        var models: [AvailableVoiceModel] = []
        for provider in VoiceProvider.allCases {
            let key = config.apiKeys[provider.rawValue] ?? ""
            guard !key.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            for model in provider.defaultModels {
                models.append(AvailableVoiceModel(provider: provider, model: model))
            }
        }
        return models
    }
}

// MARK: - Available Model (resolved)

struct AvailableVoiceModel: Identifiable, Hashable {
    let provider: VoiceProvider
    let model: VoiceModel

    var id: String { "\(provider.rawValue):\(model.id)" }

    var displayName: String { "\(provider.displayName) - \(model.displayName)" }

    func buildConfig(from base: VoiceModelConfig) -> VoiceModelConfig {
        VoiceModelConfig(
            provider: provider,
            apiKeys: base.apiKeys,
            endpoint: provider.defaultEndpoint,
            selectedModelId: model.id,
            customModelId: ""
        )
    }
}
