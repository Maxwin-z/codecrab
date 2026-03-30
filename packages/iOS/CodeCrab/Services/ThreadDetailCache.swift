import Foundation

/// File-based cache for thread detail data (messages + artifacts).
/// Stored in Caches/<threadId>/ so the OS can reclaim space if needed.
enum ThreadDetailCache {

    private static var cacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ThreadDetail", isDirectory: true)
    }

    private static func dir(for threadId: String) -> URL {
        cacheRoot.appendingPathComponent(threadId, isDirectory: true)
    }

    // MARK: - Messages

    static func loadMessages(threadId: String) -> [ThreadMessageInfo]? {
        let url = dir(for: threadId).appendingPathComponent("messages.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([ThreadMessageInfo].self, from: data)
    }

    static func saveMessages(_ messages: [ThreadMessageInfo], threadId: String) {
        let folder = dir(for: threadId)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(messages) {
            try? data.write(to: folder.appendingPathComponent("messages.json"))
        }
    }

    // MARK: - Artifacts

    static func loadArtifacts(threadId: String) -> [ThreadArtifactInfo]? {
        let url = dir(for: threadId).appendingPathComponent("artifacts.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([ThreadArtifactInfo].self, from: data)
    }

    static func saveArtifacts(_ artifacts: [ThreadArtifactInfo], threadId: String) {
        let folder = dir(for: threadId)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(artifacts) {
            try? data.write(to: folder.appendingPathComponent("artifacts.json"))
        }
    }

    // MARK: - Agents (global, not per-thread)

    static func loadAgents() -> [Agent]? {
        let url = cacheRoot.appendingPathComponent("agents.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([Agent].self, from: data)
    }

    static func saveAgents(_ agents: [Agent]) {
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(agents) {
            try? data.write(to: cacheRoot.appendingPathComponent("agents.json"))
        }
    }
}
