import ActivityKit
import Foundation

struct CodeCrabActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var activityType: String      // "thinking", "streaming", "tool_use", "working", "paused"
        var toolName: String?         // e.g. "Read", "Edit", "Bash"
        var contentSnippet: String?   // last line summary (<=60 chars)
        var elapsedSeconds: Int       // elapsed time in seconds
    }

    var projectName: String           // project name (set at start)
    var projectIcon: String           // project icon emoji
}
