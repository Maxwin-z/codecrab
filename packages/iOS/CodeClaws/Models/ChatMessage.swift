import Foundation

struct ChatMessage: Codable, Identifiable, Equatable {
    let id: String
    let role: String
    let content: String
    var images: [ImageAttachment]?
    var thinking: String?
    var toolCalls: [ToolCall]?
    var costUsd: Double?
    var durationMs: Double?
    let timestamp: Double
}

struct ToolCall: Codable, Identifiable, Equatable {
    let name: String
    let id: String
    let input: JSONValue
    var result: String?
    var isError: Bool?
}

struct ImageAttachment: Codable, Equatable {
    let data: String
    let mediaType: String
    let name: String?
}
