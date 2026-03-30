import SwiftUI

struct AgentActivityBannerView: View {
    @EnvironmentObject var wsService: WebSocketService

    var body: some View {
        if !wsService.autoResumeBanners.isEmpty {
            VStack(spacing: 4) {
                ForEach(wsService.autoResumeBanners) { banner in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 6, height: 6)

                        HStack(spacing: 0) {
                            Text("@\(banner.triggeredBy.agentName)")
                                .fontWeight(.medium)
                            Text(" woke up ")
                            Text("@\(banner.agentName)")
                                .fontWeight(.medium)
                            Text(" in ")
                            Text(banner.threadTitle)
                                .fontWeight(.medium)
                        }
                        .font(.caption)
                        .foregroundColor(.blue)
                        .lineLimit(1)

                        Spacer()

                        Button {
                            withAnimation {
                                wsService.dismissAutoResumeBanner(banner.id)
                            }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption2)
                                .foregroundColor(.blue.opacity(0.7))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.blue.opacity(0.08))
                    .cornerRadius(8)
                    .transition(.asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity),
                        removal: .opacity
                    ))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .animation(.easeInOut(duration: 0.3), value: wsService.autoResumeBanners.count)
        }
    }
}
