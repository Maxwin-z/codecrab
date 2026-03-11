import Foundation

struct Project: Codable, Identifiable {
    let id: String
    let name: String
    let path: String
    let icon: String
    let createdAt: Double
    let updatedAt: Double
}

struct ProjectStatus: Codable, Equatable {
    let projectId: String
    let status: String
    let sessionId: String?
    let firstPrompt: String?
    let lastModified: Double?
}
