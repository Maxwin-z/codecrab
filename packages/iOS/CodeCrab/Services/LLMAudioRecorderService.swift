import AVFoundation
import Foundation

/// Records microphone audio at 16kHz mono PCM Float32 for multimodal LLM transcription.
/// Thread-safe buffer accumulation with real-time audio level callback.
class LLMAudioRecorderService {
    private var audioEngine: AVAudioEngine?
    private let targetSampleRate: Double = 16000.0

    /// Called on audio tap thread with new samples
    var onAudioSamples: (([Float]) -> Void)?
    /// Called on audio tap thread with RMS audio level (0.0 - 1.0)
    var onAudioLevel: ((Float) -> Void)?

    /// Accumulated audio buffer (thread-safe)
    private(set) var audioBuffer: [Float] = []
    private let bufferLock = NSLock()

    /// Recording start time
    private(set) var startTime: Date?

    /// Current recording duration in seconds
    var duration: TimeInterval {
        guard let start = startTime else { return 0 }
        return Date().timeIntervalSince(start)
    }

    /// Maximum recording duration (120 seconds)
    static let maxDuration: TimeInterval = 120

    func startRecording() throws {
        audioBuffer = []
        startTime = Date()

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw LLMAudioError.formatError("Cannot create target audio format")
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw LLMAudioError.formatError(
                "Cannot create converter from \(inputFormat.sampleRate)Hz to \(targetSampleRate)Hz"
            )
        }

        #if os(iOS)
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self else { return }

            let frameCount = AVAudioFrameCount(
                Double(buffer.frameLength) * self.targetSampleRate / inputFormat.sampleRate
            )
            guard let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: frameCount
            ) else { return }

            var error: NSError?
            let status = converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }

            guard status != .error, error == nil else { return }

            if let channelData = convertedBuffer.floatChannelData {
                let frameLength = Int(convertedBuffer.frameLength)
                let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frameLength))

                // Accumulate in thread-safe buffer
                self.bufferLock.lock()
                self.audioBuffer.append(contentsOf: samples)
                self.bufferLock.unlock()

                self.onAudioSamples?(samples)

                // RMS level
                var sumOfSquares: Float = 0
                for i in 0..<frameLength {
                    let s = channelData[0][i]
                    sumOfSquares += s * s
                }
                let rms = sqrtf(sumOfSquares / Float(max(frameLength, 1)))
                self.onAudioLevel?(rms)
            }
        }

        engine.prepare()
        try engine.start()
    }

    func stopRecording() -> [Float] {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil

        bufferLock.lock()
        let samples = audioBuffer
        bufferLock.unlock()

        return samples
    }

    /// Get a thread-safe copy of the current buffer
    func currentSamples() -> [Float] {
        bufferLock.lock()
        let copy = audioBuffer
        bufferLock.unlock()
        return copy
    }
}

enum LLMAudioError: LocalizedError {
    case formatError(String)

    var errorDescription: String? {
        switch self {
        case .formatError(let msg): return msg
        }
    }
}
