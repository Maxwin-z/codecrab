import SwiftUI

// MARK: - Context Ring (toolbar indicator)

struct ContextRingView: View {
    let ratio: Double

    private let size: CGFloat = 16
    private let lineWidth: CGFloat = 2.5

    private var color: Color {
        if ratio > 0.8 { return .red }
        if ratio > 0.5 { return .yellow }
        return .blue
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.secondary.opacity(0.2), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(ratio, 1.0))
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(Int(ratio * 100))")
                .font(.system(size: 6, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Session Detail Sheet

struct SessionDetailView: View {
    let usage: SessionUsage
    let sessionId: String
    @Environment(\.dismiss) private var dismiss

    private var contextRatio: Double {
        guard usage.contextWindowMax > 0 else { return 0 }
        return Double(usage.contextWindowUsed) / Double(usage.contextWindowMax)
    }

    private var contextColor: Color {
        if contextRatio > 0.8 { return .red }
        if contextRatio > 0.5 { return .yellow }
        return .blue
    }

    var body: some View {
        NavigationStack {
            List {
                // Context Window
                if usage.contextWindowMax > 0 {
                    Section("Context Window") {
                        VStack(spacing: 12) {
                            // Bar
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule()
                                        .fill(Color.secondary.opacity(0.15))
                                        .frame(height: 10)
                                    Capsule()
                                        .fill(contextColor)
                                        .frame(width: max(0, geo.size.width * contextRatio), height: 10)
                                }
                            }
                            .frame(height: 10)

                            HStack {
                                Text(formatTokens(usage.contextWindowUsed))
                                    .fontDesign(.monospaced)
                                Spacer()
                                Text("\(Int(contextRatio * 100))%")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(contextColor)
                                    .fontDesign(.monospaced)
                                Spacer()
                                Text(formatTokens(usage.contextWindowMax))
                                    .fontDesign(.monospaced)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Token Usage
                Section("Tokens") {
                    tokenRow("Input", value: usage.totalInputTokens, icon: "arrow.up.circle.fill", color: .blue)
                    tokenRow("Output", value: usage.totalOutputTokens, icon: "arrow.down.circle.fill", color: .green)
                    if usage.totalCacheReadTokens > 0 {
                        tokenRow("Cache Read", value: usage.totalCacheReadTokens, icon: "arrow.trianglehead.turn.up.right.diamond.fill", color: .orange)
                    }
                    if usage.totalCacheCreateTokens > 0 {
                        tokenRow("Cache Write", value: usage.totalCacheCreateTokens, icon: "arrow.trianglehead.turn.up.right.diamond", color: .purple)
                    }
                    tokenRow("Total", value: usage.totalInputTokens + usage.totalOutputTokens, icon: "sum", color: .primary)
                }

                // Session Stats
                Section("Session") {
                    HStack {
                        Label("Cost", systemImage: "dollarsign.circle.fill")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("$\(usage.totalCostUsd, specifier: "%.4f")")
                            .fontDesign(.monospaced)
                    }
                    HStack {
                        Label("Queries", systemImage: "number.circle.fill")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(usage.queryCount)")
                            .fontDesign(.monospaced)
                    }
                    HStack {
                        Label("Duration", systemImage: "clock.fill")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(formatDuration(usage.totalDurationMs))
                            .fontDesign(.monospaced)
                    }
                    HStack {
                        Label("Session", systemImage: "tag.fill")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(String(sessionId.suffix(8)))
                            .fontDesign(.monospaced)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Session Detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func tokenRow(_ label: String, value: Int, icon: String, color: Color) -> some View {
        HStack {
            Label(label, systemImage: icon)
                .foregroundStyle(color == .primary ? .secondary : color)
            Spacer()
            Text(formatTokens(value))
                .fontDesign(.monospaced)
        }
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fk", Double(count) / 1_000)
        }
        return "\(count)"
    }

    private func formatDuration(_ ms: Double) -> String {
        let totalSeconds = Int(ms / 1000)
        if totalSeconds >= 3600 {
            return "\(totalSeconds / 3600)h \((totalSeconds % 3600) / 60)m"
        } else if totalSeconds >= 60 {
            return "\(totalSeconds / 60)m \(totalSeconds % 60)s"
        }
        return "\(totalSeconds)s"
    }
}
