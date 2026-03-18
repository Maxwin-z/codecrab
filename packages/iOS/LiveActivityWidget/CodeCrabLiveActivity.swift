import ActivityKit
import WidgetKit
import SwiftUI

struct CodeCrabLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CodeCrabActivityAttributes.self) { context in
            // Lock Screen / banner — large card
            lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Expanded: navigation-style card ──

                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Text(context.attributes.projectIcon)
                            .font(.title3)
                        Text(context.attributes.projectName)
                            .font(.headline)
                            .lineLimit(1)
                    }
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Text(formatElapsed(context.state.elapsedSeconds))
                        .font(.system(.callout, design: .monospaced))
                        .fontWeight(.medium)
                        .foregroundStyle(.white.opacity(0.7))
                }

                DynamicIslandExpandedRegion(.center) {
                    HStack(spacing: 10) {
                        // Colored status icon
                        ZStack {
                            Circle()
                                .fill(statusColor(context.state.activityType).opacity(0.25))
                                .frame(width: 32, height: 32)
                            Image(systemName: activityIcon(context.state.activityType))
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(statusColor(context.state.activityType))
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            // Content-first: show snippet as primary, status as fallback
                            if let snippet = context.state.contentSnippet {
                                Text(snippet)
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(2)
                                    .foregroundStyle(.white.opacity(0.85))
                            } else {
                                Text(activityLabel(context.state))
                                    .font(.subheadline)
                                    .fontWeight(.semibold)
                            }

                            // Tool name badge for tool_use
                            if context.state.activityType == "tool_use",
                               let toolName = context.state.toolName {
                                Text(toolName)
                                    .font(.caption2)
                                    .fontWeight(.medium)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(statusColor(context.state.activityType).opacity(0.2))
                                    .clipShape(Capsule())
                            }
                        }

                        Spacer()
                    }
                }

                DynamicIslandExpandedRegion(.bottom) {
                    EmptyView()
                }

            } compactLeading: {
                // ── Compact: pill-style ──
                ZStack {
                    Circle()
                        .fill(statusColor(context.state.activityType).opacity(0.3))
                        .frame(width: 20, height: 20)
                    Image(systemName: activityIcon(context.state.activityType))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(statusColor(context.state.activityType))
                }
            } compactTrailing: {
                Text(formatElapsed(context.state.elapsedSeconds))
                    .font(.system(.caption2, design: .monospaced))
                    .fontWeight(.medium)
            } minimal: {
                ZStack {
                    Circle()
                        .fill(statusColor(context.state.activityType).opacity(0.3))
                    Image(systemName: activityIcon(context.state.activityType))
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(statusColor(context.state.activityType))
                }
            }
        }
    }

    // MARK: - Lock Screen (large banner card)

    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<CodeCrabActivityAttributes>) -> some View {
        VStack(spacing: 0) {
            // Header row
            HStack {
                HStack(spacing: 8) {
                    Text(context.attributes.projectIcon)
                        .font(.title2)
                    Text(context.attributes.projectName)
                        .font(.headline)
                }
                Spacer()
                Text(formatElapsed(context.state.elapsedSeconds))
                    .font(.system(.callout, design: .monospaced))
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 12)

            // Status card
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(statusColor(context.state.activityType).opacity(0.15))
                        .frame(width: 44, height: 44)
                    Image(systemName: activityIcon(context.state.activityType))
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(statusColor(context.state.activityType))
                }

                VStack(alignment: .leading, spacing: 4) {
                    // Content-first: show snippet as primary, status label as fallback
                    if let snippet = context.state.contentSnippet {
                        Text(snippet)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                    } else {
                        Text(activityLabel(context.state))
                            .font(.subheadline)
                            .fontWeight(.semibold)
                    }

                    // Tool name badge for tool_use
                    if context.state.activityType == "tool_use",
                       let toolName = context.state.toolName {
                        Text(toolName)
                            .font(.caption)
                            .fontWeight(.medium)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(statusColor(context.state.activityType).opacity(0.15))
                            .clipShape(Capsule())
                    }
                }

                Spacer()
            }
        }
        .padding(16)
    }

    // MARK: - Helpers

    private func activityIcon(_ type: String) -> String {
        switch type {
        case "thinking": return "brain.head.profile"
        case "streaming": return "text.cursor"
        case "tool_use": return "wrench.and.screwdriver"
        case "paused": return "pause.circle"
        default: return "ellipsis.circle"
        }
    }

    private func statusColor(_ type: String) -> Color {
        switch type {
        case "thinking": return .purple
        case "streaming": return .cyan
        case "tool_use": return .orange
        case "paused": return .yellow
        default: return .gray
        }
    }

    private func activityLabel(_ state: CodeCrabActivityAttributes.ContentState) -> String {
        switch state.activityType {
        case "thinking": return "Thinking..."
        case "streaming": return "Streaming"
        case "tool_use": return "Tool: \(state.toolName ?? "working")"
        case "paused": return "Waiting for input"
        default: return "Working..."
        }
    }

    private func formatElapsed(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return "\(m):\(String(format: "%02d", s))"
    }
}
