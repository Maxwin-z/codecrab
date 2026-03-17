import SwiftUI

/// Overlay shown during LLM voice recording with audio level animation,
/// duration display, and stop button.
struct LLMRecordingOverlayView: View {
    let audioLevel: Float
    let duration: TimeInterval
    let onStop: () -> Void

    @State private var pulse = false

    private var durationText: String {
        let seconds = Int(duration)
        let mins = seconds / 60
        let secs = seconds % 60
        return String(format: "%d:%02d", mins, secs)
    }

    private var remainingText: String {
        let remaining = max(0, Int(LLMAudioRecorderService.maxDuration - duration))
        return remaining <= 10 ? "\(remaining)s left" : ""
    }

    var body: some View {
        HStack(spacing: 12) {
            // Audio level indicator
            ZStack {
                Circle()
                    .fill(Color.red.opacity(0.15))
                    .frame(width: 36, height: 36)
                    .scaleEffect(1.0 + CGFloat(audioLevel) * 0.5)

                Circle()
                    .fill(Color.red)
                    .frame(width: 10, height: 10)
                    .scaleEffect(pulse ? 1.2 : 1.0)
            }
            .animation(.easeInOut(duration: 0.1), value: audioLevel)

            // Duration
            VStack(alignment: .leading, spacing: 2) {
                Text("Recording...")
                    .font(.caption)
                    .foregroundColor(.secondary)
                HStack(spacing: 6) {
                    Text(durationText)
                        .font(.system(.subheadline, design: .monospaced))
                        .foregroundColor(.primary)
                    if !remainingText.isEmpty {
                        Text(remainingText)
                            .font(.caption2)
                            .foregroundColor(.red)
                    }
                }
            }

            Spacer()

            // Stop button
            Button(action: onStop) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(Color.red)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.06))
        .cornerRadius(12)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}
