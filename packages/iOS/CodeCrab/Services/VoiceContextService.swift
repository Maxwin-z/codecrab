import Foundation

/// Manages automatic generation of voice context (short-term snapshots and long-term profiles)
/// by analyzing accumulated transcription text via LLM text completion.
@MainActor
class VoiceContextService {
    static let shared = VoiceContextService()

    private let voiceService = MultimodalVoiceService()
    private var recentTexts: [String] = []

    /// Threshold to trigger short-term snapshot generation
    private let utteranceThreshold = 10
    private let charThreshold = 500

    /// Record a completed utterance for context accumulation.
    /// Automatically triggers snapshot generation when thresholds are met.
    func recordUtterance(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        recentTexts.append(trimmed)

        let store = VoiceContextStore.shared
        store.utteranceCount += 1
        store.charCount += trimmed.count

        // Check if thresholds are met for snapshot generation
        if store.utteranceCount >= utteranceThreshold || store.charCount >= charThreshold {
            Task {
                await generateShortTermSnapshot()
            }
        }
    }

    /// Generate a short-term snapshot by analyzing recent transcription texts.
    func generateShortTermSnapshot() async {
        let store = VoiceContextStore.shared
        let configStore = VoiceModelConfigStore.shared
        guard configStore.isConfigured else { return }
        guard !recentTexts.isEmpty else { return }

        let combined = recentTexts.suffix(20).joined(separator: "\n")

        let systemPrompt = """
        Analyze the following transcribed speech texts and extract structured tags. \
        Return a JSON object with these fields:
        - recentWorkspace: array of file names, features, or areas being worked on
        - commonVocabulary: array of frequently used technical terms or jargon
        - entityTags: array of named entities (people, tools, services, libraries)

        Return ONLY valid JSON, no explanation. Keep each array to at most 10 items. \
        If a category has no relevant items, use an empty array.
        """

        do {
            let result = try await voiceService.completeText(
                message: combined,
                systemPrompt: systemPrompt,
                config: configStore.config
            )
            if let data = result.data(using: .utf8),
               let snapshot = try? JSONDecoder().decode(VoiceShortTermSnapshot.self, from: data) {
                store.shortTermSnapshot = snapshot
                store.saveSnapshot()
                store.resetCounters()
                recentTexts.removeAll()
            }
        } catch {
            print("VoiceContextService: snapshot generation failed: \(error)")
        }
    }

    /// Generate or update the long-term profile from accumulated context.
    /// Intended to run daily or on-demand.
    func generateLongTermProfile() async {
        let store = VoiceContextStore.shared
        let configStore = VoiceModelConfigStore.shared
        guard configStore.isConfigured else { return }

        var inputParts: [String] = []

        // Include existing profile for incremental update
        let existing = store.longTermProfile
        if !existing.isEmpty {
            if let identity = existing.identity, !identity.isEmpty {
                inputParts.append("Current identity: \(identity)")
            }
            if let domains = existing.primaryDomains, !domains.isEmpty {
                inputParts.append("Current domains: \(domains.joined(separator: ", "))")
            }
            if let habits = existing.languageHabits, !habits.isEmpty {
                inputParts.append("Current language habits: \(habits)")
            }
            if let entities = existing.fixedEntities, !entities.isEmpty {
                inputParts.append("Current fixed entities: \(entities.joined(separator: ", "))")
            }
        }

        // Include short-term snapshot
        let snapshot = store.shortTermSnapshot
        if !snapshot.isEmpty {
            if let ws = snapshot.recentWorkspace, !ws.isEmpty {
                inputParts.append("Recent workspace: \(ws.joined(separator: ", "))")
            }
            if let vocab = snapshot.commonVocabulary, !vocab.isEmpty {
                inputParts.append("Common vocabulary: \(vocab.joined(separator: ", "))")
            }
            if let entities = snapshot.entityTags, !entities.isEmpty {
                inputParts.append("Recent entities: \(entities.joined(separator: ", "))")
            }
        }

        // Include custom vocabulary
        let customVocab = store.customVocabulary
        if !customVocab.isEmpty {
            inputParts.append("User vocabulary tags: \(customVocab.joined(separator: ", "))")
        }

        // Include learned vocabulary
        let learned = VocabularyStore.shared.customPhrases
        if !learned.isEmpty {
            inputParts.append("Learned corrections: \(learned.prefix(30).joined(separator: ", "))")
        }

        guard !inputParts.isEmpty else { return }

        let systemPrompt = """
        Based on the following accumulated user context, generate or update a user profile for \
        speech transcription optimization. Return a JSON object with these fields:
        - identity: string describing the user's role and work (1-2 sentences)
        - primaryDomains: array of their main work areas (max 5)
        - languageHabits: string describing their language usage patterns
        - fixedEntities: array of frequently mentioned proper nouns, tools, names (max 15)

        Return ONLY valid JSON, no explanation. Merge and deduplicate with existing data. \
        Keep descriptions concise.
        """

        do {
            let result = try await voiceService.completeText(
                message: inputParts.joined(separator: "\n"),
                systemPrompt: systemPrompt,
                config: configStore.config
            )
            if let data = result.data(using: .utf8),
               let profile = try? JSONDecoder().decode(VoiceLongTermProfile.self, from: data) {
                store.longTermProfile = profile
                store.saveProfile()
            }
        } catch {
            print("VoiceContextService: profile generation failed: \(error)")
        }
    }
}
