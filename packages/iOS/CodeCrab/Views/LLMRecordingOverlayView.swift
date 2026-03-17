import SwiftUI

/// Overlay shown during LLM voice recording with waveform bars and duration display.
struct LLMRecordingOverlayView: View {
    let audioLevels: [Float]
    let duration: TimeInterval

    @State private var pulse = false

    private let barCount = 28
    private let barWidth: CGFloat = 3
    private let barSpacing: CGFloat = 2
    private let minBarHeight: CGFloat = 4
    private let maxBarHeight: CGFloat = 28

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

    /// Map audio levels to bar heights with aggressive non-linear amplification
    private var barHeights: [CGFloat] {
        let levels = audioLevels

        var sampled: [Float]
        if levels.count >= barCount {
            sampled = Array(levels.suffix(barCount))
        } else if levels.isEmpty {
            sampled = Array(repeating: Float(0), count: barCount)
        } else {
            sampled = Array(repeating: Float(0), count: barCount - levels.count) + levels
        }

        return sampled.map { level in
            // RMS from mic is typically 0.001-0.1 for normal speech.
            // Use sqrt to expand the low range: sqrt(0.01) = 0.1, sqrt(0.05) = 0.22, sqrt(0.1) = 0.32
            let expanded = sqrt(max(CGFloat(level), 0))
            // Scale up aggressively so quiet speech is still visible
            let normalized = min(expanded * 3.0, 1.0)
            return minBarHeight + normalized * (maxBarHeight - minBarHeight)
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            // Pulsing red dot
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
                .scaleEffect(pulse ? 1.3 : 1.0)

            // Waveform bars
            HStack(alignment: .center, spacing: barSpacing) {
                let heights = barHeights
                ForEach(0..<barCount, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.red.opacity(0.65))
                        .frame(width: barWidth, height: heights[i])
                        .animation(.linear(duration: 0.08), value: heights[i])
                }
            }
            .frame(height: maxBarHeight)

            Spacer(minLength: 4)

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
