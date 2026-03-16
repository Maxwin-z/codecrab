import Foundation

struct SoulDocument: Codable {
    let content: String
    let meta: SoulMeta
}

struct SoulMeta: Codable {
    let version: Int
    let lastUpdated: String
}

struct SoulStatus: Codable {
    let hasSoul: Bool
    let soulVersion: Int
    let evolutionCount: Int
    let insightCount: Int
    let contentLength: Int
    let maxLength: Int
}

struct EvolutionEntry: Codable, Identifiable {
    let timestamp: String
    let summary: String

    var id: String { timestamp }

    var timeAgo: String {
        guard let date = ISO8601DateFormatter().date(from: timestamp) else { return "" }
        let diff = Date().timeIntervalSince(date)
        let mins = Int(diff / 60)
        if mins < 1 { return "just now" }
        if mins < 60 { return "\(mins)m ago" }
        let hours = mins / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        return "\(days)d ago"
    }
}
