import SwiftUI

struct ThreadListView: View {
    @EnvironmentObject var wsService: WebSocketService
    @State private var restThreads: [ThreadInfo] = []
    @State private var isLoading = true
    @State private var filter: String = "all" // "all" | "active" | "completed" | "stalled"

    private var mergedThreads: [ThreadInfo] {
        var map: [String: ThreadInfo] = [:]
        for t in restThreads { map[t.id] = t }
        // Store (real-time) wins on conflict
        for (id, t) in wsService.threads { map[id] = t }
        return Array(map.values).sorted { $0.updatedAt > $1.updatedAt }
    }

    private var filteredThreads: [ThreadInfo] {
        if filter == "all" { return mergedThreads }
        return mergedThreads.filter { $0.status == filter }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Filter tabs
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    FilterChip(label: "All", isActive: filter == "all") { filter = "all" }
                    FilterChip(label: "Active", isActive: filter == "active") { filter = "active" }
                    FilterChip(label: "Completed", isActive: filter == "completed") { filter = "completed" }
                    FilterChip(label: "Stalled", isActive: filter == "stalled") { filter = "stalled" }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }

            Divider()

            if isLoading && filteredThreads.isEmpty {
                Spacer()
                ProgressView()
                Spacer()
            } else if filteredThreads.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 40))
                        .foregroundColor(.gray.opacity(0.4))
                    Text("No threads yet")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Text("Threads are created when agents communicate with each other")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
                Spacer()
            } else {
                List {
                    ForEach(filteredThreads) { thread in
                        NavigationLink(value: thread) {
                            ThreadRow(thread: thread)
                        }
                        .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Threads")
        .navigationDestination(for: ThreadInfo.self) { thread in
            ThreadDetailView(threadId: thread.id)
        }
        .task {
            await loadThreads()
        }
        .refreshable {
            await loadThreads()
        }
    }

    private func loadThreads() async {
        do {
            let response: ThreadsResponse = try await APIClient.shared.fetch(path: "/api/threads")
            restThreads = response.threads
        } catch {
            print("[ThreadListView] Failed to fetch threads: \(error)")
        }
        isLoading = false
    }
}

// MARK: - Thread Row

private struct ThreadRow: View {
    let thread: ThreadInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(thread.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer()
                ThreadStatusBadge(status: thread.status)
            }

            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    Image(systemName: "person.2")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text("\(thread.participants.count)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Text(TimeAgo.format(from: thread.updatedAt))
                    .font(.caption)
                    .foregroundColor(.secondary)
                if thread.messages.count > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "message")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("\(thread.messages.count)")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }

            if !thread.participants.isEmpty {
                HStack(spacing: 4) {
                    ForEach(thread.participants.prefix(4)) { p in
                        Text("@\(p.agentName)")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(UIColor.tertiarySystemFill))
                            .cornerRadius(4)
                    }
                    if thread.participants.count > 4 {
                        Text("+\(thread.participants.count - 4)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Filter Chip

private struct FilterChip: View {
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(isActive ? Color.accentColor.opacity(0.15) : Color(UIColor.tertiarySystemFill))
                .foregroundColor(isActive ? .accentColor : .secondary)
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Status Badge

struct ThreadStatusBadge: View {
    let status: String

    private var config: (label: String, color: Color) {
        switch status {
        case "active": return ("Active", .green)
        case "completed": return ("Completed", .blue)
        case "stalled": return ("Stalled", .orange)
        default: return (status.capitalized, .gray)
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(config.color)
                .frame(width: 6, height: 6)
                .opacity(status == "active" ? 1 : 0.8)
            Text(config.label)
                .font(.caption2.weight(.medium))
                .foregroundColor(config.color)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(config.color.opacity(0.1))
        .cornerRadius(6)
    }
}
