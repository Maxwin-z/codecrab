import SwiftUI

/// Overlay shown during LLM voice recording with Siri-like fluid waveform and duration display.
struct LLMRecordingOverlayView: View {
    let audioLevels: [Float]
    let duration: TimeInterval
    let maxDuration: TimeInterval
    var onCancel: (() -> Void)? = nil

    @State private var pulse = false
    @State private var displayLevel: CGFloat = 0

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

    /// Current audio level from the latest sample
    private var currentLevel: CGFloat {
        CGFloat(audioLevels.last ?? 0)
    }

    var body: some View {
        HStack(spacing: 10) {
            // Cancel button (left side)
            if let onCancel {
                Button(action: onCancel) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            // Pulsing red dot
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
                .scaleEffect(pulse ? 1.3 : 1.0)

            // Fluid waveform
            SiriWaveformView(level: currentLevel, displayLevel: $displayLevel)
                .frame(height: 36)

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

// MARK: - Siri-like Fluid Waveform

private struct SiriWaveformView: View {
    let level: CGFloat
    @Binding var displayLevel: CGFloat

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate

            Canvas { ctx, size in
                drawWaveform(in: ctx, size: size, time: time)
            }
            .onChange(of: timeline.date) { _, _ in
                // Normalize: RMS is typically 0.001-0.1, map to 0-1
                let normalizedTarget = min(max(level / 0.015, 0), 1)
                // Asymmetric smoothing: fast attack, slow decay
                let factor: CGFloat = normalizedTarget > displayLevel ? 0.3 : 0.12
                displayLevel += (normalizedTarget - displayLevel) * factor
            }
        }
    }

    private func waveGradient(width: CGFloat, midY: CGFloat, time: Double, opacity: Double) -> GraphicsContext.Shading {
        let shift = time * 0.3
        let colors: [Color] = [
            Color(hue: fmod(0.55 + shift, 1.0), saturation: 0.85, brightness: 1.0).opacity(opacity),
            Color(hue: fmod(0.72 + shift, 1.0), saturation: 0.80, brightness: 1.0).opacity(opacity),
            Color(hue: fmod(0.88 + shift, 1.0), saturation: 0.85, brightness: 1.0).opacity(opacity),
            Color(hue: fmod(0.05 + shift, 1.0), saturation: 0.90, brightness: 1.0).opacity(opacity),
            Color(hue: fmod(0.15 + shift, 1.0), saturation: 0.85, brightness: 1.0).opacity(opacity),
            Color(hue: fmod(0.55 + shift, 1.0), saturation: 0.85, brightness: 1.0).opacity(opacity),
        ]
        return .linearGradient(
            Gradient(colors: colors),
            startPoint: CGPoint(x: 0, y: midY),
            endPoint: CGPoint(x: width, y: midY)
        )
    }

    private func drawWaveform(in ctx: GraphicsContext, size: CGSize, time: Double) {
        let midY = size.height / 2
        let width = size.width
        let maxAmplitude = midY * 0.95

        // Subtle idle breathing so the waveform is never fully static
        let idleBreath = 0.05 + 0.03 * sin(time * 1.5)
        let effectiveLevel = max(Double(displayLevel), idleBreath)

        // Wave layers: (speed, frequency, amplitude scale, opacity)
        let layers: [(Double, Double, Double, Double)] = [
            (1.8, 1.2, 1.0, 0.7),
            (2.5, 1.7, 0.7, 0.5),
            (3.2, 2.3, 0.45, 0.3),
        ]

        // Glow layer behind the main wave
        if let first = layers.first {
            let (speed, freq, ampScale, _) = first
            let path = wavePath(width: width, midY: midY,
                                amplitude: effectiveLevel * maxAmplitude * ampScale,
                                frequency: freq, phase: time * speed)
            ctx.drawLayer { glowCtx in
                glowCtx.addFilter(.blur(radius: 6))
                let glowFill = waveGradient(width: width, midY: midY, time: time,
                                            opacity: 0.4 * effectiveLevel)
                glowCtx.fill(path, with: glowFill)
            }
        }

        // Draw each wave layer
        for (i, (speed, freq, ampScale, opacity)) in layers.enumerated() {
            let amp = effectiveLevel * maxAmplitude * ampScale
            let path = wavePath(width: width, midY: midY,
                                amplitude: amp, frequency: freq, phase: time * speed)
            let fill = waveGradient(width: width, midY: midY,
                                    time: time + Double(i) * 0.4, opacity: opacity)
            ctx.fill(path, with: fill)
        }
    }

    private func wavePath(width: CGFloat, midY: CGFloat,
                          amplitude: CGFloat, frequency: Double, phase: Double) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: midY))

        // Upper contour
        for x in stride(from: CGFloat(0), through: width, by: 1) {
            let t = Double(x / width)
            let envelope = pow(sin(t * .pi), 1.5)
            let s1 = sin(t * frequency * .pi * 2 + phase)
            let s2 = sin(t * frequency * 1.6 * .pi * 2 + phase * 1.3) * 0.35
            let s3 = sin(t * frequency * 0.6 * .pi * 2 + phase * 0.7) * 0.15
            let composite = abs(s1 + s2 + s3) / 1.5
            let y = midY - composite * amplitude * envelope
            path.addLine(to: CGPoint(x: x, y: y))
        }

        // Lower contour (symmetric mirror)
        for x in stride(from: width, through: CGFloat(0), by: -1) {
            let t = Double(x / width)
            let envelope = pow(sin(t * .pi), 1.5)
            let s1 = sin(t * frequency * .pi * 2 + phase)
            let s2 = sin(t * frequency * 1.6 * .pi * 2 + phase * 1.3) * 0.35
            let s3 = sin(t * frequency * 0.6 * .pi * 2 + phase * 0.7) * 0.15
            let composite = abs(s1 + s2 + s3) / 1.5
            let y = midY + composite * amplitude * envelope
            path.addLine(to: CGPoint(x: x, y: y))
        }

        path.closeSubpath()
        return path
    }
}
