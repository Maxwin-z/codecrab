import Foundation

struct Agent: Codable, Identifiable, Hashable, Equatable {
    let id: String
    let name: String
    let emoji: String
    let createdAt: Double
    let updatedAt: Double

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Agent, rhs: Agent) -> Bool {
        lhs.id == rhs.id
    }
}
