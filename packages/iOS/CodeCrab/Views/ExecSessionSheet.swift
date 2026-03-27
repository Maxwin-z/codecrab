import SwiftUI

/// Modal sheet that displays a cron exec session's full execution details.
/// Fetches messages + debug events from the server and renders them in-place.
struct ExecSessionSheet: View {
    let sessionId: String
    @Environment(\.dismiss) private var dismiss
    @State private var messages: [ChatMessage] = []
    @State private var debugEvents: [SdkEvent] = []
    @State private var isLoading = true
    @State private var error: String? = nil

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    VStack {
                        Spacer()
                        ProgressView()
                            .scaleEffect(1.2)
                        Text("Loading session...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                        Spacer()
                    }
                } else if let error = error {
                    VStack(spacing: 12) {
                        Spacer()
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                        Spacer()
                    }
                } else {
                    ScrollView {
                        MessageListView(
                            messages: messages,
                            streamingText: "",
                            streamingThinking: "",
                            isRunning: false,
                            sdkEvents: debugEvents
                        )
                        .padding()
                    }
                }
            }
            .navigationTitle("Execution Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .task { await loadSession() }
    }

    private func loadSession() async {
        do {
            let result: SessionHistoryResponse = try await APIClient.shared.fetch(
                path: "/api/sessions/\(sessionId)/history"
            )
            self.messages = result.messages
            self.debugEvents = []
            isLoading = false
        } catch {
            self.error = "Failed to load session: \(error.localizedDescription)"
            isLoading = false
        }
    }
}

// MARK: - Response model

private struct SessionHistoryResponse: Decodable {
    let sessionId: String
    let messages: [ChatMessage]
}

// Make SdkEvent Decodable for API responses
extension SdkEvent: Decodable {
    enum CodingKeys: String, CodingKey {
        case ts, type, detail, data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ts = try container.decode(Double.self, forKey: .ts)
        type = try container.decode(String.self, forKey: .type)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        // Decode data as [String: JSONValue]
        if let dataContainer = try? container.decode([String: JSONValue].self, forKey: .data) {
            data = dataContainer
        } else {
            data = nil
        }
    }
}
