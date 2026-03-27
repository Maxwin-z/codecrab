import Foundation

/// Provider configuration — matches server-v2 ProviderConfig
struct ProviderConfig: Codable, Identifiable {
    let id: String
    let name: String
    let provider: String        // "anthropic" | "openai" | "google" | "custom"
    let apiKey: String?
    let modelId: String?
    let baseUrl: String?
}

/// Backward compat alias
typealias ModelConfig = ProviderConfig

struct ModelInfo: Codable, Equatable {
    let value: String
    let displayName: String
    let description: String
    let supportsEffort: Bool?
    let supportedEffortLevels: [String]?
    let supportsAdaptiveThinking: Bool?
    let supportsFastMode: Bool?
}
