import SwiftUI

struct SoulCardView: View {
    var refreshID = UUID()
    var onTap: () -> Void = {}
    @ObservedObject private var soulSettings = SoulSettings.shared
    @State private var soul: SoulDocument?
    @State private var status: SoulStatus?
    @State private var recentEvolution: [EvolutionEntry] = []

    var body: some View {
        cardContent
            .contentShape(Rectangle())
            .onTapGesture { onTap() }
            .task(id: refreshID) {
                await fetchSoulData()
            }
    }

    @ViewBuilder
    private var cardContent: some View {
        let hasSoul = status?.hasSoul == true

        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(soulSettings.isEnabled ? Color.purple.opacity(0.15) : Color.secondary.opacity(0.1))
                        .frame(width: 32, height: 32)
                    Image(systemName: hasSoul ? "person.fill" : "brain")
                        .font(.system(size: 14))
                        .foregroundColor(soulSettings.isEnabled ? (hasSoul ? .purple : .secondary) : .secondary.opacity(0.5))
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("SOUL")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.primary)
                    if hasSoul, let soul = soul {
                        Text(extractSummary(soul.content))
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    } else {
                        Text("Personal Profile")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                if hasSoul, let status = status {
                    Text("v\(status.soulVersion)")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.6))
                        .monospacedDigit()
                }

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundColor(.secondary.opacity(0.3))
            }

            // Tags
            if hasSoul, let soul = soul {
                let tags = extractTags(soul.content)
                if !tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(tags, id: \.self) { tag in
                            Text(tag)
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }

            // Latest evolution
            if !soulSettings.isEnabled {
                HStack(spacing: 4) {
                    Image(systemName: "pause.circle")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                    Text("Evolution paused")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                }
            } else if let latest = recentEvolution.last {
                HStack(spacing: 4) {
                    Image(systemName: "sparkles")
                        .font(.caption2)
                        .foregroundColor(.orange)
                    Text(latest.summary)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    Text(latest.timeAgo)
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                }
            } else if !(status?.hasSoul == true) {
                HStack(spacing: 4) {
                    Image(systemName: "sparkles")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                    Text("Evolves automatically")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                }
            }

            // Footer stats
            if hasSoul, let status = status, status.evolutionCount > 0 {
                Divider()
                HStack {
                    Text("\(status.evolutionCount) evolutions")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.5))
                    Spacer()
                    if status.insightCount > 0 {
                        Text("\(status.insightCount) insights")
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.5))
                    }
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

    private func extractSummary(_ content: String) -> String {
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            var clean = trimmed
                .replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "*", with: "")
            if clean.hasPrefix("- ") { clean = String(clean.dropFirst(2)) }
            if !clean.isEmpty {
                return clean.count > 60 ? String(clean.prefix(60)) + "..." : clean
            }
        }
        return ""
    }

    private func extractTags(_ content: String) -> [String] {
        var tags: [String] = []
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            guard line.range(of: #"^\s*-\s*\*\*[^*]+:\*\*\s*(.+)"#, options: .regularExpression) != nil else { continue }
            // Extract the value after "**Label:**"
            if let colonEnd = line.range(of: ":**")?.upperBound {
                let value = String(line[colonEnd...]).trimmingCharacters(in: .whitespaces)
                if value.contains(",") {
                    tags.append(contentsOf: value.split(separator: ",").prefix(2).map { $0.trimmingCharacters(in: .whitespaces) })
                } else if value.count < 30 {
                    tags.append(value)
                }
            }
            if tags.count >= 4 { break }
        }
        return Array(tags.prefix(4))
    }

    private func fetchSoulData() async {
        async let settingsSync: () = SoulSettings.shared.syncFromServer()
        async let soulTask: SoulDocument? = {
            do { return try await APIClient.shared.fetch(path: "/api/soul") }
            catch { return nil }
        }()
        async let statusTask: SoulStatus? = {
            do { return try await APIClient.shared.fetch(path: "/api/soul/status") }
            catch { return nil }
        }()
        async let logTask: [EvolutionEntry] = {
            do { return try await APIClient.shared.fetch(path: "/api/soul/log?limit=5") }
            catch { return [] }
        }()

        let (_, s, st, log) = await (settingsSync, soulTask, statusTask, logTask)
        self.soul = s
        self.status = st
        self.recentEvolution = log
    }
}
