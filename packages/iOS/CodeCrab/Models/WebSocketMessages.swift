import Foundation

struct Question: Codable, Equatable {
    let question: String
    let header: String?
    let multiSelect: Bool?
    let options: [QuestionOption]?
    
    // Fallback if options is missing in some payloads
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        question = try container.decode(String.self, forKey: .question)
        header = try container.decodeIfPresent(String.self, forKey: .header)
        multiSelect = try container.decodeIfPresent(Bool.self, forKey: .multiSelect)
        options = try container.decodeIfPresent([QuestionOption].self, forKey: .options) ?? []
    }
}

struct QuestionOption: Codable, Equatable {
    let label: String
    let description: String?
}

struct PendingPermission: Codable, Equatable {
    let requestId: String
    let toolName: String
    let input: JSONValue
    let reason: String
}
