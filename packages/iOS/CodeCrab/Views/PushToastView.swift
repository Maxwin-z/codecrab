import SwiftUI

struct PushToastData: Equatable {
    let projectId: String
    let sessionId: String
    let title: String
    let body: String
}

struct PushToastView: View {
    let data: PushToastData
    let onTap: () -> Void
    let onDismiss: () -> Void

    @State private var offset: CGFloat = -120
    @State private var opacity: Double = 0

    var body: some View {
        VStack {
            Button(action: onTap) {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(data.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                        Text(data.body)
                            .font(.system(size: 13))
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.top, 4)

            Spacer()
        }
        .offset(y: offset)
        .opacity(opacity)
        .onAppear {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                offset = 0
                opacity = 1
            }
            // Auto-dismiss after 4 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                dismiss()
            }
        }
        .gesture(
            DragGesture()
                .onEnded { value in
                    if value.translation.height < -20 {
                        dismiss()
                    }
                }
        )
    }

    private func dismiss() {
        withAnimation(.easeIn(duration: 0.25)) {
            offset = -120
            opacity = 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            onDismiss()
        }
    }
}
