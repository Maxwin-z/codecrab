import Combine
import Foundation
import Speech
import AVFoundation

@MainActor
class SpeechService: ObservableObject {
    @Published var isRecording = false
    @Published var transcribedText = ""
    @Published var selectedLocale: Locale
    @Published var authorizationStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined

    /// The original transcript from speech recognition (before user edits)
    private(set) var originalTranscript: String?

    /// Text that existed before this recording session started (for appending)
    private var textPrefix = ""

    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    private static let localeKey = "SpeechService.selectedLocale"

    var supportedLocales: [Locale] {
        SFSpeechRecognizer.supportedLocales()
            .sorted { $0.identifier < $1.identifier }
            .map { Locale(identifier: $0.identifier) }
    }

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.localeKey) {
            selectedLocale = Locale(identifier: saved)
        } else {
            selectedLocale = Locale.current
        }
        recognizer = SFSpeechRecognizer(locale: selectedLocale)

        // Check current authorization
        authorizationStatus = SFSpeechRecognizer.authorizationStatus()
    }

    func changeLocale(_ locale: Locale) {
        selectedLocale = locale
        recognizer = SFSpeechRecognizer(locale: locale)
        UserDefaults.standard.set(locale.identifier, forKey: Self.localeKey)
    }

    func requestAuthorization() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                self?.authorizationStatus = status
            }
        }
    }

    func startRecording(existingText: String = "") {
        guard let recognizer = recognizer, recognizer.isAvailable else { return }

        // Keep existing text as prefix so new speech appends to it
        textPrefix = existingText

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.contextualStrings = VocabularyStore.shared.customPhrases

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("Audio session setup failed: \(error)")
            return
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            print("Audio engine start failed: \(error)")
            return
        }

        recognitionRequest = request
        transcribedText = existingText

        let prefix = textPrefix
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self = self else { return }
                if let result = result {
                    let newPart = result.bestTranscription.formattedString
                    if prefix.isEmpty {
                        self.transcribedText = newPart
                    } else {
                        self.transcribedText = prefix + " " + newPart
                    }
                }
                if error != nil || (result?.isFinal == true) {
                    // Task finished naturally
                }
            }
        }

        isRecording = true
    }

    func stopRecording() {
        guard isRecording else { return }
        isRecording = false

        // Only store the newly recognized portion (excluding prefix) for vocabulary learning
        if textPrefix.isEmpty {
            originalTranscript = transcribedText
        } else if transcribedText.hasPrefix(textPrefix) {
            let newPart = String(transcribedText.dropFirst(textPrefix.count)).trimmingCharacters(in: .whitespaces)
            // Append to any previous original transcript
            if let prev = originalTranscript, !prev.isEmpty {
                originalTranscript = prev + " " + newPart
            } else {
                originalTranscript = newPart
            }
        } else {
            originalTranscript = transcribedText
        }

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
    }

    /// Call after user sends the (possibly edited) text to learn corrections
    func learnFromEdit(_ editedText: String) {
        guard let original = originalTranscript, !original.isEmpty else { return }
        VocabularyStore.shared.recordCorrection(original: original, edited: editedText)
        originalTranscript = nil
    }
}
