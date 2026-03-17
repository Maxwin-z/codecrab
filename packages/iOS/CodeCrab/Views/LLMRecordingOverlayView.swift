import SwiftUI

/// Overlay shown during LLM voice recording with duration display.
/// Tap the mic button below to stop recording.
struct LLMRecordingOverlayView: View {
    let audioLevel: Float
    let duration: TimeInterval

    @State private var pulse = false

    private var maxDuration: TimeInterval { LLMAudioRecorderService.maxDuration }

    private var durationText: String {
        let seconds = Int(duration)
        let mins = seconds / 60
        let secs = seconds % 60
        return String(format: "%d:%02d", mins, secs)
    }

    private var maxDurationText: String {
        let seconds = Int(maxDuration)
        let mins = seconds / 60
        let secs = seconds % 60
        return String(format: "%d:%02d", mins, secs)
    }

    private var remaining: Int {
        max(0, Int(maxDuration - duration))
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

            // Duration: current / max
            HStack(spacing: 4) {
                Text(durationText)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundColor(.primary)
                Text("/")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(maxDurationText)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                if remaining <= 10 {
                    Text("\(remaining)s")
                        .font(.caption2)
                        .foregroundColor(.red)
                        .fontWeight(.medium)
                }
            }

            Spacer()
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
