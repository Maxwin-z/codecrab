import SwiftUI
import Combine

struct SessionSidebarView: View {
    let projectId: String
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var wsService: WebSocketService
    
    @State private var sessions: [SessionInfo] = []
    @State private var isLoading = false
    @State private var now = Date()
    
    let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    let refreshTimer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                Button(action: {
                    wsService.newChat()
                    dismiss()
                }) {
                    Text("New Chat")
                        .fontWeight(.bold)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .padding()
                
                List {
                    if isLoading && sessions.isEmpty {
                        ProgressView().frame(maxWidth: .infinity, alignment: .center)
                    } else if sessions.isEmpty {
                        Text("No previous sessions")
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    } else {
                        ForEach(sessions) { session in
                            Button(action: {
                                wsService.resumeSession(session.sessionId)
                                dismiss()
                            }) {
                                HStack(spacing: 10) {
                                    if session.isCron {
                                        Image(systemName: "clock.arrow.2.circlepath")
                                            .font(.system(size: 16))
                                            .foregroundColor(.purple)
                                    }

                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack(spacing: 6) {
                                            if session.isCron {
                                                Text(session.cronJobName ?? "Scheduled")
                                                    .font(.caption2)
                                                    .fontWeight(.semibold)
                                                    .foregroundColor(.purple)
                                                    .padding(.horizontal, 6)
                                                    .padding(.vertical, 2)
                                                    .background(Color.purple.opacity(0.12))
                                                    .cornerRadius(4)
                                            }

                                            Text(session.summary.isEmpty ? (session.firstPrompt ?? "Untitled session") : session.summary)
                                                .font(.headline)
                                                .lineLimit(1)
                                                .foregroundColor(.primary)
                                        }

                                        HStack {
                                            Text(TimeAgo.format(from: session.lastModified, now: now))
                                            Text("•")
                                            Text(String(session.sessionId.suffix(6)))
                                                .fontDesign(.monospaced)
                                        }
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    }

                                    Spacer()

                                    if session.status == "processing" {
                                        Circle().fill(Color.orange).frame(width: 8, height: 8)
                                    } else if session.status == "error" {
                                        Circle().fill(Color.red).frame(width: 8, height: 8)
                                    } else {
                                        Circle().fill(session.isCron ? Color.purple.opacity(0.5) : Color.gray).frame(width: 8, height: 8)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
                .listStyle(PlainListStyle())
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Close") { dismiss() }
                }
            }
            .onAppear {
                fetchSessions()
            }
            .onReceive(timer) { _ in
                now = Date()
            }
            .onReceive(refreshTimer) { _ in
                fetchSessions(silent: true)
            }
        }
    }
    
    private func fetchSessions(silent: Bool = false) {
        if !silent { isLoading = true }
        Task {
            do {
                let fetched: [SessionInfo] = try await APIClient.shared.fetch(path: "/api/sessions?projectId=\(projectId)")
                self.sessions = fetched.sorted { $0.lastModified > $1.lastModified }
            } catch {
                print("Failed to fetch sessions: \(error)")
            }
            if !silent { isLoading = false }
        }
    }
}
