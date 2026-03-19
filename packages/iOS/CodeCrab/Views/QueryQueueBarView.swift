import SwiftUI

struct QueryQueueBarView: View {
    let items: [QueueItem]
    let currentSessionId: String
    let onAbort: (String?) -> Void
    let onDequeue: (String) -> Void
    let onExecuteNow: (String) -> Void
    let isAborting: Bool
    @State private var showStopConfirm = false
    @State private var stopQueryId: String? = nil
    @State private var showExecConfirm: String? = nil

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

                    // Action buttons
                    if isRunning {
                        Button(action: {
                            stopQueryId = isOtherSession ? item.queryId : nil
                            showStopConfirm = true
                        }) {
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
                        HStack(spacing: 4) {
                            Button(action: { showExecConfirm = item.queryId }) {
                                Text("Run Now")
                                    .font(.caption2)
                                    .fontWeight(.medium)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.accentColor.opacity(0.1))
                                    .foregroundColor(.accentColor)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            .buttonStyle(PlainButtonStyle())

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
        .alert("Stop running query?", isPresented: $showStopConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Stop", role: .destructive) { onAbort(stopQueryId) }
        } message: {
            Text("This will abort the currently running query. Any queued queries will remain in the queue.")
        }
        .alert("Execute in new session?", isPresented: showExecConfirmBinding) {
            Button("Cancel", role: .cancel) { showExecConfirm = nil }
            Button("Run Now") {
                if let qid = showExecConfirm {
                    onExecuteNow(qid)
                }
                showExecConfirm = nil
            }
        } message: {
            Text("This query will be removed from the queue and executed immediately in a new parallel session. Permission requests will be auto-approved.")
        }
    }

    private var showExecConfirmBinding: Binding<Bool> {
        Binding(
            get: { showExecConfirm != nil },
            set: { if !$0 { showExecConfirm = nil } }
        )
    }
}
