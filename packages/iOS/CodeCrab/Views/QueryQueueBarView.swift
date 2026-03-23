import SwiftUI

struct QueryQueueBarView: View {
    let items: [QueueItem]
    let currentSessionId: String
    let onAbort: (String?) -> Void
    let onDequeue: (String) -> Void
    let onExecuteNow: (String) -> Void
    let isAborting: Bool
    @State private var showSheet = false
    @State private var showStopConfirm = false
    @State private var stopQueryId: String? = nil
    @State private var showExecConfirm: String? = nil

    private var runningCount: Int { items.filter { $0.status == "running" }.count }
    private var queuedCount: Int { items.count - runningCount }

    var body: some View {
        if !items.isEmpty {
            // Floating pill button
            Button(action: { showSheet = true }) {
                HStack(spacing: 6) {
                    if runningCount > 0 {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 6, height: 6)
                            .opacity(0.9)
                    }
                    Text(buttonLabel)
                        .font(.caption)
                        .fontWeight(.medium)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(
                    Capsule()
                        .fill(Color(UIColor.secondarySystemBackground))
                        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
                )
                .foregroundColor(.primary)
                .overlay(
                    Capsule()
                        .stroke(Color(UIColor.separator).opacity(0.3), lineWidth: 1)
                )
            }
            .buttonStyle(PlainButtonStyle())
            .padding(.trailing, 16)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .sheet(isPresented: $showSheet) {
                queueSheet
            }
        }
    }

    private var buttonLabel: String {
        var parts: [String] = []
        if runningCount > 0 { parts.append("\(runningCount) running") }
        if queuedCount > 0 { parts.append("\(queuedCount) queued") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Queue Sheet

    private var queueSheet: some View {
        NavigationStack {
            List {
                ForEach(items) { item in
                    queueItemRow(item)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Query Queue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { showSheet = false }
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
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func queueItemRow(_ item: QueueItem) -> some View {
        let isRunning = item.status == "running"
        let isCron = item.queryType == "cron"
        let isOtherSession = item.sessionId != nil && item.sessionId != currentSessionId

        HStack(spacing: 10) {
            // Status indicator
            Circle()
                .fill(isRunning ? Color.green : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)

            // Content
            VStack(alignment: .leading, spacing: 2) {
                Text(isCron
                    ? "Cron: \(item.cronJobName ?? "task")"
                    : item.prompt.count > 80
                        ? String(item.prompt.prefix(77)) + "..."
                        : item.prompt
                )
                .font(.subheadline)
                .lineLimit(2)

                HStack(spacing: 6) {
                    Text(isRunning ? "Running" : "Queued")
                        .font(.caption2)
                        .foregroundStyle(isRunning ? .green : .secondary)

                    if isOtherSession, let sid = item.sessionId {
                        Text(String(sid.suffix(6)))
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            // Actions
            if isRunning {
                Button(action: {
                    stopQueryId = isOtherSession ? item.queryId : nil
                    showStopConfirm = true
                }) {
                    Text(isAborting ? "Stopping..." : "Stop")
                        .font(.caption)
                        .fontWeight(.medium)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.red.opacity(0.1))
                        .foregroundColor(.red)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .disabled(isAborting)
                .buttonStyle(PlainButtonStyle())
            } else {
                HStack(spacing: 6) {
                    Button(action: { showExecConfirm = item.queryId }) {
                        Text("Run Now")
                            .font(.caption)
                            .fontWeight(.medium)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Color.accentColor.opacity(0.1))
                            .foregroundColor(.accentColor)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(PlainButtonStyle())

                    Button(action: { onDequeue(item.queryId) }) {
                        Image(systemName: "xmark")
                            .font(.caption)
                            .fontWeight(.medium)
                            .padding(5)
                            .background(Color(UIColor.secondarySystemBackground))
                            .foregroundColor(.secondary)
                            .clipShape(Circle())
                    }
                    .buttonStyle(PlainButtonStyle())
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var showExecConfirmBinding: Binding<Bool> {
        Binding(
            get: { showExecConfirm != nil },
            set: { if !$0 { showExecConfirm = nil } }
        )
    }
}
