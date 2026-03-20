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

    init(id: String, role: String, content: String, images: [ImageAttachment]? = nil, thinking: String? = nil,
         toolCalls: [ToolCall]? = nil, costUsd: Double? = nil, durationMs: Double? = nil,
         timestamp: Double) {
        self.id = id
        self.role = role
        self.content = content
        self.images = images
        self.thinking = thinking
        self.toolCalls = toolCalls
        self.costUsd = costUsd
        self.durationMs = durationMs
        self.timestamp = timestamp
    }
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
    let url: String?

    init(data: String, mediaType: String, name: String? = nil, url: String? = nil) {
        self.data = data
        self.mediaType = mediaType
        self.name = name
        self.url = url
    }
}
