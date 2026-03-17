import Foundation

struct TimeAgo {
    static func format(from timestamp: Double, now: Date = Date()) -> String {
        let diff = now.timeIntervalSince1970 * 1000 - timestamp
        if diff < 0 { return "just now" }
        
        let minutes = diff / 60_000
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(Int(minutes))m ago" }
        
        let hours = minutes / 60
        if hours < 24 { return "\(Int(hours))h ago" }
        
        let days = hours / 24
        return "\(Int(days))d ago"
    }
}
