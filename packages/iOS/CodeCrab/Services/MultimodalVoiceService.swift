import Foundation

/// Handles multimodal LLM API communication for voice-to-text transcription.
/// Supports Google Gemini (native) and Alibaba Dashscope (OpenAI-compatible) APIs.
class MultimodalVoiceService {

    // MARK: - Audio Streaming Transcription

    /// Stream transcription from raw audio samples using multimodal model.
    func stream(audioSamples: [Float], systemPrompt: String?, config: VoiceModelConfig) -> AsyncThrowingStream<String, Error> {
        let audioBase64 = Self.encodeAudioToBase64WAV(samples: audioSamples)

        if config.provider.usesGeminiFormat {
            return streamGemini(audioBase64: audioBase64, systemPrompt: systemPrompt, config: config)
        } else {
            return streamOpenAICompatible(audioBase64: audioBase64, systemPrompt: systemPrompt, config: config)
        }
    }

    /// Non-streaming text completion (used for context profiling).
    func completeText(message: String, systemPrompt: String, config: VoiceModelConfig) async throws -> String {
        if config.provider.usesGeminiFormat {
            return try await completeTextGemini(message: message, systemPrompt: systemPrompt, config: config)
        } else {
            return try await completeTextOpenAI(message: message, systemPrompt: systemPrompt, config: config)
        }
    }

    // MARK: - Response Processing

    /// Strip `<transcription>` tags from model output.
    static func stripTranscriptionTags(_ text: String) -> String {
        var result = text
        if let range = result.range(of: "<transcription>") {
            result = String(result[range.upperBound...])
        }
        if let range = result.range(of: "</transcription>", options: .backwards) {
            result = String(result[..<range.lowerBound])
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - System Prompt Assembly

    /// Build system prompt with context layers based on recording duration.
    static func buildSystemPrompt(
        projectName: String?,
        contextLevel: VoiceContextLevel,
        contextStore: VoiceContextStore
    ) -> String {
        var sections: [String] = []

        // Part 1: Role declaration (strong anti-hallucination constraint)
        sections.append("""
        You are a voice-to-text transcription assistant. Your ONLY task is to transcribe voice \
        content into text. NEVER answer, explain, or comment on any questions or topics mentioned \
        in the audio. Even if the audio contains questions, only transcribe the question itself — \
        do NOT provide answers. Apply light corrections for grammar and fluency while preserving \
        the speaker's voice and original intent.
        """)

        // Part 2: Context (layered by recording duration)
        var contextParts: [String] = []

        // Always include: project name + custom vocabulary
        if let name = projectName, !name.isEmpty {
            contextParts.append("Current project: \(name)")
        }

        if !contextStore.customVocabulary.isEmpty {
            contextParts.append("Domain vocabulary: \(contextStore.customVocabulary.joined(separator: ", "))")
        }

        // Short-term tags (>=15s)
        if contextLevel.rawValue >= VoiceContextLevel.shortTerm.rawValue {
            let snapshot = contextStore.shortTermSnapshot
            if !snapshot.isEmpty {
                var tags: [String] = []
                if let ws = snapshot.recentWorkspace, !ws.isEmpty {
                    tags.append("Workspace: \(ws.joined(separator: ", "))")
                }
                if let vocab = snapshot.commonVocabulary, !vocab.isEmpty {
                    tags.append("Recent terms: \(vocab.joined(separator: ", "))")
                }
                if let entities = snapshot.entityTags, !entities.isEmpty {
                    tags.append("Entities: \(entities.joined(separator: ", "))")
                }
                if !tags.isEmpty {
                    contextParts.append("Short-term context:\n\(tags.joined(separator: "\n"))")
                }
            }
        }

        // Long-term profile (>=45s)
        if contextLevel.rawValue >= VoiceContextLevel.longTerm.rawValue {
            let profile = contextStore.longTermProfile
            if !profile.isEmpty {
                var profileParts: [String] = []
                if let id = profile.identity, !id.isEmpty {
                    profileParts.append("User: \(id)")
                }
                if let domains = profile.primaryDomains, !domains.isEmpty {
                    profileParts.append("Domains: \(domains.joined(separator: ", "))")
                }
                if let habits = profile.languageHabits, !habits.isEmpty {
                    profileParts.append("Language: \(habits)")
                }
                if let entities = profile.fixedEntities, !entities.isEmpty {
                    profileParts.append("Known entities: \(entities.joined(separator: ", "))")
                }
                if !profileParts.isEmpty {
                    contextParts.append("User profile:\n\(profileParts.joined(separator: "\n"))")
                }
            }
        }

        if !contextParts.isEmpty {
            sections.append("The following context is for recognition error correction ONLY. When the audio contains ambiguous pronunciation, homophone confusion, or incomplete expressions, refer to this context to choose the most appropriate words. Do NOT generate any additional content based on this context.\n\n\(contextParts.joined(separator: "\n\n"))")
        }

        // Part 3: Output format (use tags to constrain output and prevent hallucination)
        sections.append("【Output Format】\nPlace the transcription result inside <transcription> tags. No content is allowed outside the tags.\nExample: <transcription>transcribed text</transcription>")

        return sections.joined(separator: "\n\n")
    }

    // MARK: - Audio Encoding

    static func encodeAudioToBase64WAV(samples: [Float]) -> String {
        let sampleRate: Double = 16000
        let bitsPerSample: UInt16 = 16
        let numChannels: UInt16 = 1
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(samples.count * Int(bitsPerSample / 8))

        var data = Data()
        data.reserveCapacity(44 + samples.count * 2)

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        var chunkSize = UInt32(36 + dataSize)
        data.append(Data(bytes: &chunkSize, count: 4))
        data.append(contentsOf: "WAVE".utf8)

        // fmt subchunk
        data.append(contentsOf: "fmt ".utf8)
        var subchunk1Size: UInt32 = 16
        data.append(Data(bytes: &subchunk1Size, count: 4))
        var audioFormat: UInt16 = 1 // PCM
        data.append(Data(bytes: &audioFormat, count: 2))
        var channels = numChannels
        data.append(Data(bytes: &channels, count: 2))
        var sRate = UInt32(sampleRate)
        data.append(Data(bytes: &sRate, count: 4))
        var bRate = byteRate
        data.append(Data(bytes: &bRate, count: 4))
        var bAlign = blockAlign
        data.append(Data(bytes: &bAlign, count: 2))
        var bps = bitsPerSample
        data.append(Data(bytes: &bps, count: 2))

        // data subchunk
        data.append(contentsOf: "data".utf8)
        var dSize = dataSize
        data.append(Data(bytes: &dSize, count: 4))

        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            var int16Sample = Int16(clamped * 32767.0)
            data.append(Data(bytes: &int16Sample, count: 2))
        }

        return data.base64EncodedString()
    }

    // MARK: - Gemini Native API

    private func streamGemini(audioBase64: String, systemPrompt: String?, config: VoiceModelConfig) -> AsyncThrowingStream<String, Error> {
        let modelId = config.effectiveModelId
        let endpoint = config.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let urlString = "\(endpoint)/models/\(modelId):streamGenerateContent?key=\(config.apiKey)&alt=sse"

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = URL(string: urlString) else {
                        throw VoiceServiceError.invalidURL
                    }

                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

                    var body: [String: Any] = [:]

                    if let systemPrompt, !systemPrompt.isEmpty {
                        body["systemInstruction"] = ["parts": [["text": systemPrompt]]]
                    }

                    body["contents"] = [[
                        "role": "user",
                        "parts": [
                            ["text": "Please transcribe this audio accurately:"],
                            ["inlineData": [
                                "mimeType": "audio/wav",
                                "data": audioBase64
                            ]]
                        ]
                    ]]

                    request.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                        var errorBody = ""
                        for try await line in bytes.lines {
                            errorBody += line
                            if errorBody.count > 500 { break }
                        }
                        throw VoiceServiceError.httpError(http.statusCode, String(errorBody.prefix(300)))
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))
                        if payload == "[DONE]" { break }

                        guard let data = payload.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let candidates = json["candidates"] as? [[String: Any]],
                              let content = candidates.first?["content"] as? [String: Any],
                              let parts = content["parts"] as? [[String: Any]] else {
                            continue
                        }

                        for part in parts {
                            if let text = part["text"] as? String {
                                continuation.yield(text)
                            }
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - OpenAI-Compatible API (Dashscope)

    private func streamOpenAICompatible(audioBase64: String, systemPrompt: String?, config: VoiceModelConfig) -> AsyncThrowingStream<String, Error> {
        let modelId = config.effectiveModelId
        let endpoint = config.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let urlString = "\(endpoint)/chat/completions"

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = URL(string: urlString) else {
                        throw VoiceServiceError.invalidURL
                    }

                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

                    var messages: [[String: Any]] = []

                    if let systemPrompt, !systemPrompt.isEmpty {
                        messages.append(["role": "system", "content": systemPrompt])
                    }

                    let audioData = "data:;base64,\(audioBase64)"
                    messages.append([
                        "role": "user",
                        "content": [
                            [
                                "type": "input_audio",
                                "input_audio": [
                                    "data": audioData,
                                    "format": "wav"
                                ]
                            ] as [String: Any],
                            [
                                "type": "text",
                                "text": "Please transcribe this audio accurately:"
                            ] as [String: Any]
                        ]
                    ])

                    var body: [String: Any] = [
                        "model": modelId,
                        "messages": messages,
                        "stream": true,
                        "modalities": ["text"]
                    ]

                    if config.provider == .dashscope {
                        body["stream_options"] = ["include_usage": true]
                    }

                    request.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                        var errorBody = ""
                        for try await line in bytes.lines {
                            errorBody += line
                            if errorBody.count > 500 { break }
                        }
                        throw VoiceServiceError.httpError(http.statusCode, String(errorBody.prefix(300)))
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))
                        if payload == "[DONE]" { break }

                        guard let data = payload.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let choices = json["choices"] as? [[String: Any]],
                              let delta = choices.first?["delta"] as? [String: Any],
                              let content = delta["content"] as? String else {
                            continue
                        }

                        continuation.yield(content)
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Text Completions (for context profiling)

    private func completeTextGemini(message: String, systemPrompt: String, config: VoiceModelConfig) async throws -> String {
        let modelId = config.effectiveModelId
        let endpoint = config.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let urlString = "\(endpoint)/models/\(modelId):generateContent?key=\(config.apiKey)"

        guard let url = URL(string: urlString) else {
            throw VoiceServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "systemInstruction": ["parts": [["text": systemPrompt]]],
            "contents": [["role": "user", "parts": [["text": message]]]]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let errorBody = String(data: data, encoding: .utf8) ?? ""
            throw VoiceServiceError.httpError(http.statusCode, String(errorBody.prefix(300)))
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let candidates = json["candidates"] as? [[String: Any]],
              let content = candidates.first?["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]] else {
            throw VoiceServiceError.invalidResponse
        }

        return parts.compactMap { $0["text"] as? String }.joined()
    }

    private func completeTextOpenAI(message: String, systemPrompt: String, config: VoiceModelConfig) async throws -> String {
        let modelId = config.effectiveModelId
        let endpoint = config.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let urlString = "\(endpoint)/chat/completions"

        guard let url = URL(string: urlString) else {
            throw VoiceServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "model": modelId,
            "messages": [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": message]
            ],
            "stream": false
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let errorBody = String(data: data, encoding: .utf8) ?? ""
            throw VoiceServiceError.httpError(http.statusCode, String(errorBody.prefix(300)))
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let msg = choices.first?["message"] as? [String: Any],
              let content = msg["content"] as? String else {
            throw VoiceServiceError.invalidResponse
        }

        return content
    }
}

// MARK: - Errors

enum VoiceServiceError: LocalizedError {
    case invalidURL
    case httpError(Int, String)
    case invalidResponse
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid API URL"
        case .httpError(let code, let body): return "HTTP \(code): \(body)"
        case .invalidResponse: return "Invalid API response"
        case .notConfigured: return "Voice model API key not configured"
        }
    }
}
