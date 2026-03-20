import Foundation

struct Project: Codable, Identifiable, Hashable, Equatable {
    let id: String
    let name: String
    let path: String
    let icon: String
    let createdAt: Double
    let updatedAt: Double
    let lastActivityAt: Double?

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Project, rhs: Project) -> Bool {
        lhs.id == rhs.id
    }
}

struct ProjectStatus: Codable, Equatable, Hashable {
    let projectId: String
    let status: String
    let sessionId: String?
    let firstPrompt: String?
    let lastModified: Double?

    func hash(into hasher: inout Hasher) {
        hasher.combine(projectId)
        hasher.combine(sessionId)
    }

    static func == (lhs: ProjectStatus, rhs: ProjectStatus) -> Bool {
        lhs.projectId == rhs.projectId && lhs.sessionId == rhs.sessionId
    }
}
