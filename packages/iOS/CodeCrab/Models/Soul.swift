import Foundation
import Combine
import SwiftUI

// MARK: - Soul Settings (server-authoritative)

class SoulSettings: ObservableObject {
    static let shared = SoulSettings()

    @Published var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: "soul_enabled")
            pushToServer(enabled: isEnabled)
        }
    }

    /// Prevents didSet from pushing back when syncing FROM server
    private var isSyncing = false

    private init() {
        // UserDefaults is a local cache — real state comes from server via syncFromServer()
        if UserDefaults.standard.object(forKey: "soul_enabled") == nil {
            self.isEnabled = true
        } else {
            self.isEnabled = UserDefaults.standard.bool(forKey: "soul_enabled")
        }
    }

    /// Fetch authoritative state from server and update local
    func syncFromServer() async {
        struct Settings: Codable { let enabled: Bool }
        do {
            let settings: Settings = try await APIClient.shared.fetch(path: "/api/soul/settings")
            await MainActor.run {
                guard self.isEnabled != settings.enabled else { return }
                isSyncing = true
                isEnabled = settings.enabled
                isSyncing = false
            }
        } catch {
            // Server unavailable — keep local cache
        }
    }

    private func pushToServer(enabled: Bool) {
        guard !isSyncing else { return }
        struct Body: Encodable { let enabled: Bool }
        Task {
            try? await APIClient.shared.request(
                path: "/api/soul/settings",
                method: "PUT",
                body: Body(enabled: enabled)
            )
        }
    }
}

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
