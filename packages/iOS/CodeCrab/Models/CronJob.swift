import Foundation

struct CronSchedule: Codable {
    let kind: String          // "at", "every", "cron"
    let at: String?           // ISO 8601 timestamp (kind == "at")
    let everyMs: Double?      // milliseconds (kind == "every")
    let expr: String?         // cron expression (kind == "cron")
    let tz: String?           // timezone (kind == "cron")
}

struct CronJobContext: Codable {
    let projectId: String?
    let clientId: String?
    let sessionId: String?
}

struct CronJob: Codable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let schedule: CronSchedule
    let prompt: String
    let context: CronJobContext
    let status: String
    let createdAt: String
    let updatedAt: String
    let lastRunAt: String?
    let nextRunAt: String?
    let runCount: Int
    let maxRuns: Int?
    let deleteAfterRun: Bool?

    var isRecurring: Bool {
        schedule.kind == "cron" || schedule.kind == "every"
    }

    var scheduleDescription: String {
        switch schedule.kind {
        case "at":
            if let at = schedule.at, let date = ISO8601DateFormatter().date(from: at) {
                return date.formatted(date: .abbreviated, time: .shortened)
            }
            return schedule.at ?? "unknown"
        case "every":
            if let ms = schedule.everyMs {
                let mins = Int(ms / 60_000)
                if mins < 60 { return "Every \(mins)m" }
                let hours = mins / 60
                if hours < 24 { return "Every \(hours)h" }
                return "Every \(hours / 24)d"
            }
            return "unknown"
        case "cron":
            return schedule.expr ?? "unknown"
        default:
            return "unknown"
        }
    }

    var nextRunDate: Date? {
        guard let nextRunAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: nextRunAt)
    }

    var statusIcon: String {
        switch status {
        case "pending": return "clock"
        case "running": return "play.circle.fill"
        case "completed": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.triangle.fill"
        case "disabled": return "pause.circle.fill"
        case "deprecated": return "trash"
        default: return "questionmark.circle"
        }
    }

    var statusColor: String {
        switch status {
        case "pending": return "blue"
        case "running": return "orange"
        case "completed": return "green"
        case "failed": return "red"
        case "disabled": return "gray"
        case "deprecated": return "gray"
        default: return "gray"
        }
    }
}
