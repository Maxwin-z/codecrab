import SwiftUI

struct QueryQueueBarView: View {
    let items: [QueueItem]
    let currentSessionId: String
    let onAbort: () -> Void
    let onDequeue: (String) -> Void
    let isAborting: Bool

    var body: some View {
        VStack(spacing: 6) {
            ForEach(items) { item in
                let isRunning = item.status == "running"
                let isCron = item.queryType == "cron"
                let isOtherSession = item.sessionId != nil && item.sessionId != currentSessionId

                HStack(spacing: 8) {
                    // Status indicator
                    Circle()
                        .fill(isRunning ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 6, height: 6)
                        .opacity(isRunning ? 1.0 : 0.6)

                    // Label
                    Text(isCron
                        ? "Cron: \(item.cronJobName ?? "task")"
                        : item.prompt.count > 60
                            ? String(item.prompt.prefix(57)) + "..."
                            : item.prompt
                    )
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.primary.opacity(0.8))

                    Spacer()

                    // Session badge for cross-session items
                    if isOtherSession, let sid = item.sessionId {
                        Text(String(sid.suffix(6)))
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(UIColor.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                            .foregroundStyle(.secondary)
                    }

                    // Action button
                    if isRunning {
                        Button(action: onAbort) {
                            Text(isAborting ? "Stopping..." : "Stop")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.red.opacity(0.1))
                                .foregroundColor(.red)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        .disabled(isAborting)
                        .buttonStyle(PlainButtonStyle())
                    } else {
                        Button(action: { onDequeue(item.queryId) }) {
                            Text("Remove")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color(UIColor.secondarySystemBackground))
                                .foregroundColor(.secondary)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(isRunning
                            ? Color.accentColor.opacity(0.05)
                            : Color(UIColor.secondarySystemBackground).opacity(0.5)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(isRunning ? Color.accentColor.opacity(0.2) : Color(UIColor.separator).opacity(0.3), lineWidth: 1)
                        )
                )
            }
        }
    }
}
