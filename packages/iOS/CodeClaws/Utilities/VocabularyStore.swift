import Foundation
import NaturalLanguage

class VocabularyStore {
    static let shared = VocabularyStore()

    private let fileURL: URL
    private var phrases: Set<String>

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = docs.appendingPathComponent("speech_vocabulary.json")
        phrases = Self.load(from: fileURL)
    }

    var customPhrases: [String] {
        Array(phrases)
    }

    /// Compare original speech text with user-edited text,
    /// extract corrected words via NLTokenizer, and store them.
    /// Skips if the change is too large (likely intent change, not correction).
    func recordCorrection(original: String, edited: String) {
        let originalWords = tokenize(original)
        let editedWords = tokenize(edited)

        let originalSet = Set(originalWords.map { $0.lowercased() })
        let editedSet = Set(editedWords.map { $0.lowercased() })

        let added = editedSet.subtracting(originalSet)
        let removed = originalSet.subtracting(editedSet)

        let totalUnique = originalSet.union(editedSet).count
        guard totalUnique > 0 else { return }

        let changeRatio = Double(added.count + removed.count) / Double(totalUnique)
        guard changeRatio <= 0.5 else { return }

        guard !added.isEmpty else { return }

        for word in added where word.count >= 2 {
            phrases.insert(word)
        }

        save()
    }

    private func tokenize(_ text: String) -> [String] {
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = text
        var words: [String] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            words.append(String(text[range]))
            return true
        }
        return words
    }

    private func save() {
        do {
            let data = try JSONEncoder().encode(Array(phrases))
            try data.write(to: fileURL, options: .atomic)
        } catch {
            print("VocabularyStore save error: \(error)")
        }
    }

    private static func load(from url: URL) -> Set<String> {
        guard let data = try? Data(contentsOf: url),
              let array = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return Set(array)
    }
}
