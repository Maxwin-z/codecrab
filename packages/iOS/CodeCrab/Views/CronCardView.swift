import SwiftUI

struct CronSummary: Codable {
    let totalActive: Int
    let totalAll: Int
    let statusCounts: StatusCounts
    let nextJob: NextJob?

    struct StatusCounts: Codable {
        let pending: Int
        let running: Int
        let disabled: Int
        let failed: Int
        let completed: Int
        let deprecated: Int
    }

    struct NextJob: Codable {
        let id: String
        let name: String
        let nextRunAt: String?
        let status: String
    }
}

struct CronCardView: View {
    var refreshID = UUID()
    var onTap: () -> Void = {}
    @State private var summary: CronSummary?

    var body: some View {
        Button {
            onTap()
        } label: {
            cardContent
        }
        .buttonStyle(.plain)
        .task(id: refreshID) {
            await fetchSummary()
        }
    }

    @ViewBuilder
    private var cardContent: some View {
        let hasJobs = (summary?.totalAll ?? 0) > 0

        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.blue.opacity(0.15))
                        .frame(width: 32, height: 32)
                    Image(systemName: "clock.arrow.2.circlepath")
                        .font(.system(size: 14))
                        .foregroundColor(hasJobs ? .blue : .secondary)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("Scheduled Tasks")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.primary)
                    if hasJobs, let summary = summary {
                        Text("\(summary.totalActive) active · \(summary.totalAll) total")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        Text("Automated workflows")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundColor(.secondary.opacity(0.3))
            }

            if hasJobs, let summary = summary {
                // Status badges
                HStack(spacing: 4) {
                    if summary.statusCounts.running > 0 {
                        statusBadge(
                            "\(summary.statusCounts.running) running",
                            icon: "play.circle.fill",
                            color: .orange
                        )
                    }
                    if summary.statusCounts.pending > 0 {
                        statusBadge(
                            "\(summary.statusCounts.pending) pending",
                            color: .blue
                        )
                    }
                    if summary.statusCounts.failed > 0 {
                        statusBadge(
                            "\(summary.statusCounts.failed) failed",
                            icon: "exclamationmark.triangle.fill",
                            color: .red
                        )
                    }
                    if summary.statusCounts.disabled > 0 {
                        statusBadge(
                            "\(summary.statusCounts.disabled) paused",
                            color: .secondary
                        )
                    }
                }

                // Next upcoming job
                if let nextJob = summary.nextJob {
                    HStack(spacing: 4) {
                        Image(systemName: "clock")
                            .font(.caption2)
                            .foregroundColor(.blue)
                        Text(nextJob.name)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        if let nextRunAt = nextJob.nextRunAt {
                            Text(timeUntil(nextRunAt))
                                .font(.caption2)
                                .foregroundColor(.secondary.opacity(0.5))
                        }
                    }
                }

                // Footer
                if summary.statusCounts.completed > 0 {
                    Divider()
                    HStack {
                        Text("\(summary.statusCounts.completed) completed")
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.5))
                        Spacer()
                    }
                }
            } else {
                // Empty state hint
                HStack(spacing: 4) {
                    Image(systemName: "info.circle")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                    Text("Create tasks in chat to automate workflows")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(.systemGray6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 0.5)
        )
    }

    // MARK: - Helpers

    private func statusBadge(_ text: String, icon: String? = nil, color: Color) -> some View {
        HStack(spacing: 2) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.system(size: 8))
            }
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .foregroundColor(color == .secondary ? .secondary : color)
    }

    private func timeUntil(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return "" }
        let diff = date.timeIntervalSinceNow
        if diff < 0 { return "overdue" }
        let mins = Int(diff / 60)
        if mins < 1 { return "in <1m" }
        if mins < 60 { return "in \(mins)m" }
        let hours = mins / 60
        if hours < 24 { return "in \(hours)h" }
        return "in \(hours / 24)d"
    }

    private func fetchSummary() async {
        do {
            summary = try await APIClient.shared.fetch(path: "/api/cron/summary")
        } catch {
            // Silent fail — card degrades gracefully
        }
    }
}
