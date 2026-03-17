import Foundation

struct McpInfo: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String
    let icon: String?
    let toolCount: Int
    var source: String?   // "custom", "sdk", or "skill"
    var tools: [String]?  // tool names (for SDK MCPs)
}

/// SDK MCP server info from the Claude Code init message
struct SdkMcpServer: Equatable {
    let name: String
    let status: String
}

/// SDK skill info with name and description
struct SdkSkill: Equatable {
    let name: String
    let description: String
}
