import Foundation

struct ThreadParticipant: Codable, Identifiable, Equatable, Hashable {
    let agentId: String
    let agentName: String

    var id: String { agentId }

    // Server returns extra fields (sessionId, joinedAt, lastActiveAt) — ignore them
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try container.decode(String.self, forKey: .agentId)
        agentName = try container.decode(String.self, forKey: .agentName)
    }

    init(agentId: String, agentName: String) {
        self.agentId = agentId
        self.agentName = agentName
    }
}

struct ThreadInfo: Decodable, Identifiable, Equatable, Hashable {
    let id: String
    var title: String
    var status: String  // "active" | "completed" | "stalled"
    let parentThreadId: String?
    var participants: [ThreadParticipant]
    let createdAt: Double
    var updatedAt: Double
    var stalledReason: String?
    /// Messages are NOT returned from REST — only populated via WebSocket events
    var messages: [ThreadMessageInfo]

    enum CodingKeys: String, CodingKey {
        case id, title, status, parentThreadId, participants, createdAt, updatedAt, stalledReason, messages
        // extra server fields we ignore
        case config, turnCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        status = try container.decode(String.self, forKey: .status)
        parentThreadId = try container.decodeIfPresent(String.self, forKey: .parentThreadId)
        participants = (try? container.decode([ThreadParticipant].self, forKey: .participants)) ?? []
        createdAt = try container.decode(Double.self, forKey: .createdAt)
        updatedAt = try container.decode(Double.self, forKey: .updatedAt)
        stalledReason = try container.decodeIfPresent(String.self, forKey: .stalledReason)
        // messages is not sent by the REST API — default to empty
        messages = (try? container.decode([ThreadMessageInfo].self, forKey: .messages)) ?? []
    }

    init(id: String, title: String, status: String, parentThreadId: String?, participants: [ThreadParticipant], createdAt: Double, updatedAt: Double, stalledReason: String? = nil, messages: [ThreadMessageInfo] = []) {
        self.id = id
        self.title = title
        self.status = status
        self.parentThreadId = parentThreadId
        self.participants = participants
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.stalledReason = stalledReason
        self.messages = messages
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

struct ThreadMessageInfo: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let from: String      // agent name (flattened from AgentRef)
    let to: String         // agent name or "broadcast"
    let content: String
    let artifacts: [ThreadArtifactRef]
    let timestamp: Double

    enum CodingKeys: String, CodingKey {
        case id, from, to, content, artifacts
        case createdAt  // REST uses "createdAt"
        case timestamp  // WS uses "timestamp"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        content = try container.decode(String.self, forKey: .content)
        artifacts = (try? container.decode([ThreadArtifactRef].self, forKey: .artifacts)) ?? []

        // REST: createdAt, WS: timestamp
        if let ts = try? container.decode(Double.self, forKey: .timestamp) {
            timestamp = ts
        } else {
            timestamp = (try? container.decode(Double.self, forKey: .createdAt)) ?? Date().timeIntervalSince1970 * 1000
        }

        // "from" can be a string (WS) or AgentRef object (REST)
        if let str = try? container.decode(String.self, forKey: .from) {
            from = str
        } else if let ref = try? container.decode(AgentRefPayload.self, forKey: .from) {
            from = ref.agentName
        } else {
            from = "unknown"
        }

        // "to" can be a string (WS: agentName or "broadcast") or AgentRef object (REST)
        if let str = try? container.decode(String.self, forKey: .to) {
            to = str
        } else if let ref = try? container.decode(AgentRefPayload.self, forKey: .to) {
            to = ref.agentName
        } else {
            to = "broadcast"
        }
    }

    init(id: String, from: String, to: String, content: String, artifacts: [ThreadArtifactRef], timestamp: Double) {
        self.id = id
        self.from = from
        self.to = to
        self.content = content
        self.artifacts = artifacts
        self.timestamp = timestamp
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(from, forKey: .from)
        try container.encode(to, forKey: .to)
        try container.encode(content, forKey: .content)
        try container.encode(artifacts, forKey: .artifacts)
        try container.encode(timestamp, forKey: .timestamp)
    }
}

/// Internal helper for decoding AgentRef objects from REST API
private struct AgentRefPayload: Decodable {
    let agentId: String
    let agentName: String
}

struct ThreadArtifactRef: Codable, Equatable, Hashable {
    let id: String
    let name: String
    let path: String
}

struct ThreadArtifactInfo: Codable, Identifiable, Equatable {
    let id: String
    let threadId: String
    let name: String
    let mimeType: String
    let path: String
    let size: Int
    let createdBy: ThreadParticipant
    let createdAt: Double
}

/// Wrapper for /api/threads response: { threads: [...] }
struct ThreadsResponse: Decodable {
    let threads: [ThreadInfo]
}

/// Wrapper for /api/threads/:id/messages response: { messages: [...] }
struct ThreadMessagesResponse: Decodable {
    let messages: [ThreadMessageInfo]
}

/// Wrapper for /api/threads/:id/artifacts response: { artifacts: [...] }
struct ThreadArtifactsResponse: Decodable {
    let artifacts: [ThreadArtifactInfo]
}

struct AutoResumeBanner: Identifiable, Equatable {
    let id: String
    let agentId: String
    let agentName: String
    let threadId: String
    let threadTitle: String
    let triggeredBy: ThreadParticipant
    let timestamp: Double
}
