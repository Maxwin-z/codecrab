import SwiftUI

struct VoiceContextSettingsView: View {
    @StateObject private var contextStore = VoiceContextStore.shared
    @StateObject private var configStore = VoiceModelConfigStore.shared
    @State private var isGeneratingProfile = false
    @State private var isGeneratingSnapshot = false
    @State private var newTag = ""

    var body: some View {
        Form {
            // Custom vocabulary tags
            Section(header: Text("Custom Vocabulary")) {
                Text("Add domain-specific terms to improve transcription accuracy.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                // Tag display
                if !contextStore.customVocabulary.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(contextStore.customVocabulary, id: \.self) { tag in
                            TagView(text: tag) {
                                contextStore.customVocabulary.removeAll { $0 == tag }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }

                // Add tag input
                HStack {
                    TextField("Add term...", text: $newTag)
                        .autocapitalization(.none)
                        .onSubmit { addTag() }
                    Button(action: addTag) {
                        Image(systemName: "plus.circle.fill")
                            .foregroundColor(.accentColor)
                    }
                    .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            // Long-term profile
            Section(header: Text("Long-term Profile")) {
                if contextStore.longTermProfile.isEmpty {
                    Text("No profile generated yet. Use voice input regularly to build your profile, or generate one manually.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    let profile = contextStore.longTermProfile

                    if let identity = profile.identity, !identity.isEmpty {
                        ProfileRow(label: "Identity", value: identity)
                    }
                    if let domains = profile.primaryDomains, !domains.isEmpty {
                        ProfileRow(label: "Domains", value: domains.joined(separator: ", "))
                    }
                    if let habits = profile.languageHabits, !habits.isEmpty {
                        ProfileRow(label: "Language", value: habits)
                    }
                    if let entities = profile.fixedEntities, !entities.isEmpty {
                        ProfileRow(label: "Entities", value: entities.joined(separator: ", "))
                    }

                    if let date = contextStore.profileDate {
                        Text("Last updated: \(date.formatted(.relative(presentation: .named)))")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                HStack {
                    Button(action: generateProfile) {
                        HStack {
                            Text("Generate Profile")
                            if isGeneratingProfile { ProgressView().scaleEffect(0.7) }
                        }
                    }
                    .disabled(isGeneratingProfile || !configStore.isConfigured)

                    Spacer()

                    if !contextStore.longTermProfile.isEmpty {
                        Button("Clear", role: .destructive) {
                            contextStore.longTermProfile = VoiceLongTermProfile()
                            contextStore.saveProfile()
                        }
                        .font(.caption)
                    }
                }
            }

            // Short-term snapshot
            Section(header: Text("Short-term Snapshot")) {
                if contextStore.shortTermSnapshot.isEmpty {
                    Text("Automatically generated after \(10) voice inputs or \(500) characters of transcription.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    let snapshot = contextStore.shortTermSnapshot

                    if let ws = snapshot.recentWorkspace, !ws.isEmpty {
                        SnapshotTagRow(label: "Workspace", tags: ws)
                    }
                    if let vocab = snapshot.commonVocabulary, !vocab.isEmpty {
                        SnapshotTagRow(label: "Terms", tags: vocab)
                    }
                    if let entities = snapshot.entityTags, !entities.isEmpty {
                        SnapshotTagRow(label: "Entities", tags: entities)
                    }

                    if let date = contextStore.snapshotDate {
                        Text("Last updated: \(date.formatted(.relative(presentation: .named)))")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                HStack {
                    Text("Utterances: \(contextStore.utteranceCount)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Chars: \(contextStore.charCount)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                    if !contextStore.shortTermSnapshot.isEmpty {
                        Button("Clear", role: .destructive) {
                            contextStore.shortTermSnapshot = VoiceShortTermSnapshot()
                            contextStore.saveSnapshot()
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .navigationTitle("Voice Context")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func addTag() {
        let tag = newTag.trimmingCharacters(in: .whitespaces)
        guard !tag.isEmpty, !contextStore.customVocabulary.contains(tag) else { return }
        contextStore.customVocabulary.append(tag)
        newTag = ""
    }

    private func generateProfile() {
        isGeneratingProfile = true
        Task {
            await VoiceContextService.shared.generateLongTermProfile()
            isGeneratingProfile = false
        }
    }
}

// MARK: - Helper Views

private struct ProfileRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.subheadline)
        }
        .padding(.vertical, 2)
    }
}

private struct SnapshotTagRow: View {
    let label: String
    let tags: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            FlowLayout(spacing: 4) {
                ForEach(tags, id: \.self) { tag in
                    Text(tag)
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.1))
                        .foregroundColor(.accentColor)
                        .cornerRadius(6)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

private struct TagView: View {
    let text: String
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(text)
                .font(.caption)
            Button(action: onDelete) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.orange.opacity(0.12))
        .foregroundColor(.orange)
        .cornerRadius(8)
    }
}

/// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (positions: [CGPoint], size: CGSize) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            maxX = max(maxX, x)
        }

        return (positions, CGSize(width: maxX, height: y + rowHeight))
    }
}
