import Foundation

struct ModelConfig: Codable, Identifiable {
    let id: String
    let name: String
    let provider: String
    let configDir: String?
    let apiKey: String?
    let baseUrl: String?
}

struct ModelInfo: Codable, Equatable {
    let value: String
    let displayName: String
    let description: String
    let supportsEffort: Bool?
    let supportedEffortLevels: [String]?
    let supportsAdaptiveThinking: Bool?
    let supportsFastMode: Bool?
}
