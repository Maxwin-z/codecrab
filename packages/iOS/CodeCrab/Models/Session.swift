import Foundation

struct SessionInfo: Codable, Identifiable, Equatable {
    var id: String { sessionId }
    let sessionId: String
    let summary: String
    let lastModified: Double
    let firstPrompt: String?
    let cwd: String?
    let status: String?
    let isActive: Bool?
    let projectId: String?
    let cronJobName: String?
    let providerId: String?

    var isCron: Bool { cronJobName != nil }
}
