import SwiftUI

struct CronPageView: View {
    @State private var jobs: [CronJob] = []
    @State private var isLoading = true

    private var activeJobs: [CronJob] {
        jobs.filter { $0.status == "pending" || $0.status == "running" }
    }

    private var pausedJobs: [CronJob] {
        jobs.filter { $0.status == "disabled" }
    }

    private var historyJobs: [CronJob] {
        jobs.filter { $0.status == "completed" || $0.status == "failed" || $0.status == "deprecated" }
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if jobs.isEmpty {
                emptyState
            } else {
                jobList
            }
        }
        .navigationTitle("Scheduled Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await fetchJobs() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        .task {
            await fetchJobs()
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.arrow.2.circlepath")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            Text("No Scheduled Tasks")
                .font(.headline)
            Text("Scheduled tasks are created during chat sessions. Ask the assistant to set up recurring workflows or one-time reminders.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Job List

    private var jobList: some View {
        List {
            if !activeJobs.isEmpty {
                Section {
                    ForEach(activeJobs) { job in
                        NavigationLink {
                            CronJobDetailView(job: job)
                        } label: {
                            JobRowView(job: job)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 6, height: 6)
                        Text("Active (\(activeJobs.count))")
                    }
                    .textCase(nil)
                }
            }

            if !pausedJobs.isEmpty {
                Section {
                    ForEach(pausedJobs) { job in
                        NavigationLink {
                            CronJobDetailView(job: job)
                        } label: {
                            JobRowView(job: job)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.secondary.opacity(0.4))
                            .frame(width: 6, height: 6)
                        Text("Paused (\(pausedJobs.count))")
                    }
                    .textCase(nil)
                }
            }

            if !historyJobs.isEmpty {
                Section {
                    ForEach(historyJobs) { job in
                        NavigationLink {
                            CronJobDetailView(job: job)
                        } label: {
                            JobRowView(job: job)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.secondary.opacity(0.2))
                            .frame(width: 6, height: 6)
                        Text("History (\(historyJobs.count))")
                    }
                    .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Fetch

    private func fetchJobs() async {
        do {
            let fetched: [CronJob] = try await APIClient.shared.fetch(path: "/api/cron/jobs?includeDeprecated=true")
            self.jobs = fetched
        } catch {
            print("Failed to fetch cron jobs: \(error)")
        }
        isLoading = false
    }
}

// MARK: - Job Row

struct JobRowView: View {
    let job: CronJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Name + status
            HStack(spacing: 8) {
                Image(systemName: job.statusIcon)
                    .font(.system(size: 14))
                    .foregroundColor(statusColor)

                Text(job.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)

                Spacer()

                Text(statusLabel)
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(statusColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .foregroundColor(statusColor)
            }

            // Description or prompt preview
            if let desc = job.description ?? Optional(job.prompt) {
                Text(desc)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }

            // Details row
            HStack(spacing: 12) {
                // Schedule type
                HStack(spacing: 3) {
                    Image(systemName: scheduleIcon)
                        .font(.system(size: 9))
                    Text(job.scheduleDescription)
                        .font(.caption2)
                }
                .foregroundColor(.secondary)

                // Run count
                Text("\(job.runCount) run\(job.runCount != 1 ? "s" : "")\(job.maxRuns != nil ? " / \(job.maxRuns!)" : "")")
                    .font(.caption2)
                    .foregroundColor(.secondary)

                // Next run
                if let nextDate = job.nextRunDate,
                   (job.status == "pending" || job.status == "running") {
                    HStack(spacing: 2) {
                        Image(systemName: "clock")
                            .font(.system(size: 9))
                        Text("next \(timeUntil(nextDate))")
                            .font(.caption2)
                    }
                    .foregroundColor(.secondary)
                }

                Spacer()

                // Last run
                if let lastRunAt = job.lastRunAt {
                    Text(timeAgo(lastRunAt))
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.6))
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Helpers

    private var statusColor: Color {
        switch job.status {
        case "pending": return .blue
        case "running": return .orange
        case "completed": return .green
        case "failed": return .red
        case "disabled": return .secondary
        case "deprecated": return .secondary.opacity(0.6)
        default: return .secondary
        }
    }

    private var statusLabel: String {
        switch job.status {
        case "pending": return "Pending"
        case "running": return "Running"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "disabled": return "Paused"
        case "deprecated": return "Deleted"
        default: return job.status.capitalized
        }
    }

    private var scheduleIcon: String {
        switch job.schedule.kind {
        case "at": return "calendar"
        case "every": return "timer"
        case "cron": return "repeat"
        default: return "clock"
        }
    }

    private func timeAgo(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return iso }
        let diff = Date().timeIntervalSince(date)
        let mins = Int(diff / 60)
        if mins < 1 { return "just now" }
        if mins < 60 { return "\(mins)m ago" }
        let hours = mins / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    private func timeUntil(_ date: Date) -> String {
        let diff = date.timeIntervalSinceNow
        if diff < 0 { return "overdue" }
        let mins = Int(diff / 60)
        if mins < 1 { return "<1m" }
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}

// MARK: - Job Detail View

struct CronJobDetailView: View {
    let job: CronJob

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {

                // Header: name + status badge
                HStack(spacing: 10) {
                    Image(systemName: job.statusIcon)
                        .font(.title3)
                        .foregroundColor(statusColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(job.name)
                            .font(.headline)
                        Text(statusLabel)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(statusColor.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                            .foregroundColor(statusColor)
                    }
                    Spacer()
                }

                // Description
                if let desc = job.description, !desc.isEmpty {
                    detailSection("Description") {
                        Text(desc)
                            .font(.subheadline)
                            .foregroundColor(.primary)
                    }
                }

                // Prompt
                detailSection("Prompt") {
                    Text(job.prompt)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundColor(.primary)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .textSelection(.enabled)
                }

                // Schedule
                detailSection("Schedule") {
                    HStack(spacing: 6) {
                        Image(systemName: scheduleIcon)
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(scheduleTypeLabel)
                            .font(.subheadline.weight(.medium))
                        Text("—")
                            .foregroundColor(.secondary)
                        Text(job.scheduleDescription)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }

                // Metadata
                detailSection("Details") {
                    VStack(spacing: 0) {
                        metadataRow("Created", value: formatDate(job.createdAt))
                        Divider()
                        metadataRow("Updated", value: formatDate(job.updatedAt))
                        if let nextRunAt = job.nextRunAt {
                            Divider()
                            metadataRow("Next Run", value: formatDate(nextRunAt))
                        }
                        if let lastRunAt = job.lastRunAt {
                            Divider()
                            metadataRow("Last Run", value: formatDate(lastRunAt))
                        }
                        Divider()
                        metadataRow("Runs", value: "\(job.runCount)\(job.maxRuns != nil ? " / \(job.maxRuns!)" : "")")
                        if let projectId = job.context.projectId {
                            Divider()
                            metadataRow("Project ID", value: projectId)
                        }
                    }
                    .padding(12)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding()
        }
        .navigationTitle("Task Detail")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func detailSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            content()
        }
    }

    private func metadataRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundColor(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 6)
    }

    private var statusColor: Color {
        switch job.status {
        case "pending": return .blue
        case "running": return .orange
        case "completed": return .green
        case "failed": return .red
        case "disabled": return .secondary
        case "deprecated": return .secondary.opacity(0.6)
        default: return .secondary
        }
    }

    private var statusLabel: String {
        switch job.status {
        case "pending": return "Pending"
        case "running": return "Running"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "disabled": return "Paused"
        case "deprecated": return "Deleted"
        default: return job.status.capitalized
        }
    }

    private var scheduleIcon: String {
        switch job.schedule.kind {
        case "at": return "calendar"
        case "every": return "timer"
        case "cron": return "repeat"
        default: return "clock"
        }
    }

    private var scheduleTypeLabel: String {
        switch job.schedule.kind {
        case "at": return "One-time"
        case "every": return "Interval"
        case "cron": return "Cron"
        default: return "Unknown"
        }
    }

    private func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        // Try without fractional seconds
        let fallback = ISO8601DateFormatter()
        if let date = fallback.date(from: iso) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        return iso
    }
}
