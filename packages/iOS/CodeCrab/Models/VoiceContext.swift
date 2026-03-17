import Combine
import Foundation

// MARK: - Context Level

enum VoiceContextLevel: Int, CaseIterable, Identifiable {
    case base = 0       // project name + vocabulary only
    case shortTerm = 1  // + short-term tags
    case longTerm = 2   // + long-term descriptive profile

    var id: Int { rawValue }

    /// Auto-select context level based on recording duration
    static func forDuration(_ duration: TimeInterval) -> VoiceContextLevel {
        if duration >= 45 { return .longTerm }
        if duration >= 15 { return .shortTerm }
        return .base
    }
}

// MARK: - Long-term Profile (descriptive)

struct VoiceLongTermProfile: Codable, Equatable {
    /// User identity description (e.g. "iOS developer at XYZ, working on fintech apps")
    var identity: String?
    /// Primary work domains (e.g. ["iOS development", "Swift", "financial technology"])
    var primaryDomains: [String]?
    /// Language habits (e.g. "混合中英文, technical terms in English")
    var languageHabits: String?
    /// Frequently mentioned entities (e.g. ["CodeCrab", "Xcode", "SwiftUI"])
    var fixedEntities: [String]?

    var isEmpty: Bool {
        (identity ?? "").isEmpty
            && (primaryDomains ?? []).isEmpty
            && (languageHabits ?? "").isEmpty
            && (fixedEntities ?? []).isEmpty
    }
}

// MARK: - Short-term Snapshot (tag-style)

struct VoiceShortTermSnapshot: Codable, Equatable {
    /// Recent workspace tags (e.g. ["ChatView.swift", "InputBarView", "voice feature"])
    var recentWorkspace: [String]?
    /// Common vocabulary tags (e.g. ["multimodal", "streaming", "SSE", "WAV encoding"])
    var commonVocabulary: [String]?
    /// Named entity tags (e.g. ["Gemini API", "Dashscope", "AVAudioEngine"])
    var entityTags: [String]?

    var isEmpty: Bool {
        (recentWorkspace ?? []).isEmpty
            && (commonVocabulary ?? []).isEmpty
            && (entityTags ?? []).isEmpty
    }
}

// MARK: - Voice Context Store (persistence)

@MainActor
class VoiceContextStore: ObservableObject {
    static let shared = VoiceContextStore()

    private static let profileKey = "voiceContext.longTermProfile"
    private static let snapshotKey = "voiceContext.shortTermSnapshot"
    private static let vocabularyKey = "voiceContext.customVocabulary"
    private static let snapshotDateKey = "voiceContext.snapshotDate"
    private static let profileDateKey = "voiceContext.profileDate"
    private static let utteranceCountKey = "voiceContext.utteranceCount"
    private static let charCountKey = "voiceContext.charCount"

    @Published var longTermProfile: VoiceLongTermProfile
    @Published var shortTermSnapshot: VoiceShortTermSnapshot
    /// User-edited proprietary vocabulary tags
    @Published var customVocabulary: [String] {
        didSet { saveVocabulary() }
    }

    var profileDate: Date? {
        get { UserDefaults.standard.object(forKey: Self.profileDateKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: Self.profileDateKey) }
    }

    var snapshotDate: Date? {
        get { UserDefaults.standard.object(forKey: Self.snapshotDateKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: Self.snapshotDateKey) }
    }

    var utteranceCount: Int {
        get { UserDefaults.standard.integer(forKey: Self.utteranceCountKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.utteranceCountKey) }
    }

    var charCount: Int {
        get { UserDefaults.standard.integer(forKey: Self.charCountKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.charCountKey) }
    }

    private init() {
        longTermProfile = Self.loadJSON(key: Self.profileKey) ?? VoiceLongTermProfile()
        shortTermSnapshot = Self.loadJSON(key: Self.snapshotKey) ?? VoiceShortTermSnapshot()
        customVocabulary = Self.loadJSON(key: Self.vocabularyKey) ?? []
    }

    // MARK: - Save

    func saveProfile() {
        Self.saveJSON(longTermProfile, key: Self.profileKey)
        profileDate = Date()
    }

    func saveSnapshot() {
        Self.saveJSON(shortTermSnapshot, key: Self.snapshotKey)
        snapshotDate = Date()
    }

    func resetCounters() {
        utteranceCount = 0
        charCount = 0
    }

    private func saveVocabulary() {
        Self.saveJSON(customVocabulary, key: Self.vocabularyKey)
    }

    // MARK: - JSON helpers

    private static func loadJSON<T: Decodable>(key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func saveJSON<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
