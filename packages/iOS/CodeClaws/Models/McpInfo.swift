import Foundation

struct McpInfo: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String
    let icon: String?
    let toolCount: Int
}
