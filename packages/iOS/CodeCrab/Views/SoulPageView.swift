import SwiftUI
import Combine

struct SoulPageView: View {
    @State private var soul: SoulDocument?
    @State private var status: SoulStatus?
    @State private var recentEvolution: [EvolutionEntry] = []
    @State private var isLoading = true
    @State private var isEditing = false
    @State private var editDraft = ""
    @State private var isSaving = false
    @ObservedObject private var soulSettings = SoulSettings.shared

    private var maxLength: Int { status?.maxLength ?? 4000 }
    private var overLimit: Bool { editDraft.count > maxLength }
    private var hasSoul: Bool { status?.hasSoul == true }

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if !isEditing {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Soul Evolution")
                                        .font(.subheadline.weight(.medium))
                                    Text(soulSettings.isEnabled ? "Profile evolves with each conversation" : "Evolution paused")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                Toggle("", isOn: $soulSettings.isEnabled)
                                    .labelsHidden()
                            }
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color(.systemGray6)))
                        }

                        if !hasSoul && !isEditing {
                            emptyState
                        }

                        if isEditing {
                            editorSection
                        }

                        if !isEditing && hasSoul, let soul = soul {
                            markdownSection(soul.content)
                            if let status = status {
                                Text("\(status.contentLength) / \(status.maxLength) characters")
                                    .font(.caption2)
                                    .foregroundColor(.secondary.opacity(0.5))
                                    .monospacedDigit()
                            }
                        }

                        if !isEditing && !recentEvolution.isEmpty {
                            evolutionTimeline
                        }
                    }
                    .padding()
                }
            }
        }
        .navigationTitle("SOUL Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Text("SOUL Profile")
                        .font(.headline)
                    if let status = status {
                        Text("v\(status.soulVersion)")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .monospacedDigit()
                    }
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if isEditing {
                    HStack(spacing: 8) {
                        Button("Cancel") {
                            isEditing = false
                            editDraft = ""
                        }
                        Button("Save") {
                            Task { await saveEdit() }
                        }
                        .fontWeight(.semibold)
                        .disabled(isSaving || overLimit)
                    }
                } else {
                    Button {
                        editDraft = soul?.content ?? ""
                        isEditing = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                }
            }
        }
        .task {
            await fetchSoulData()
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color.secondary.opacity(0.1))
                    .frame(width: 64, height: 64)
                Image(systemName: "brain")
                    .font(.system(size: 28))
                    .foregroundColor(.secondary)
            }

            Text("No SOUL Profile Yet")
                .font(.headline)

            Text("Your SOUL profile will be built automatically as we have conversations. It captures your preferences, expertise, and work style to provide better assistance over time.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            Button("Set Up Manually") {
                editDraft = ""
                isEditing = true
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 32)
    }

    // MARK: - Editor

    private var editorSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Content")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(editDraft.count) / \(maxLength)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundColor(overLimit ? .red : .secondary)
            }

            TextEditor(text: $editDraft)
                .font(.system(.footnote, design: .monospaced))
                .frame(minHeight: 400)
                .padding(8)
                .background(Color(UIColor.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 0.5)
                )

            if overLimit {
                Text("Content exceeds the \(maxLength) character limit. Please condense.")
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
    }

    // MARK: - Markdown Viewer

    @ViewBuilder
    private func markdownSection(_ content: String) -> some View {
        let lines = content.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.indices), id: \.self) { index in
                markdownLine(lines[index])
            }
        }
    }

    @ViewBuilder
    private func markdownLine(_ line: String) -> some View {
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("# ") {
            Text(String(trimmed.dropFirst(2)))
                .font(.title3.weight(.semibold))
                .padding(.top, 16)
                .padding(.bottom, 4)
        } else if trimmed.hasPrefix("## ") {
            Text(String(trimmed.dropFirst(3)))
                .font(.headline)
                .padding(.top, 12)
                .padding(.bottom, 2)
        } else if trimmed.hasPrefix("### ") {
            Text(String(trimmed.dropFirst(4)))
                .font(.subheadline.weight(.semibold))
                .padding(.top, 8)
                .padding(.bottom, 2)
        } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            HStack(alignment: .top, spacing: 6) {
                Text("\u{2022}")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                inlineMarkdown(String(trimmed.dropFirst(2)))
            }
            .padding(.leading, 12)
            .padding(.vertical, 1)
        } else if trimmed.isEmpty {
            Spacer().frame(height: 8)
        } else {
            inlineMarkdown(trimmed)
                .padding(.vertical, 1)
        }
    }

    @ViewBuilder
    private func inlineMarkdown(_ text: String) -> some View {
        // Strip **bold** markers for simple display
        let cleaned = text.replacingOccurrences(of: "**", with: "")
        Text(cleaned)
            .font(.subheadline)
            .foregroundColor(.primary)
    }

    // MARK: - Evolution Timeline

    private var evolutionTimeline: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Evolution Timeline")
                .font(.subheadline.weight(.medium))
                .foregroundColor(.secondary)

            ForEach(Array(recentEvolution.reversed())) { entry in
                HStack(alignment: .top, spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(Color.secondary.opacity(0.1))
                            .frame(width: 24, height: 24)
                        Image(systemName: "sparkles")
                            .font(.system(size: 10))
                            .foregroundColor(.orange)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.summary)
                            .font(.subheadline)
                        Text(entry.timeAgo)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - Network

    private func fetchSoulData() async {
        isLoading = true
        async let settingsSync: () = SoulSettings.shared.syncFromServer()
        async let soulTask: SoulDocument? = {
            do { return try await APIClient.shared.fetch(path: "/api/soul") }
            catch { return nil }
        }()
        async let statusTask: SoulStatus? = {
            do { return try await APIClient.shared.fetch(path: "/api/soul/status") }
            catch { return nil }
        }()
        async let logTask: [EvolutionEntry] = {
            do { return try await APIClient.shared.fetch(path: "/api/soul/log?limit=5") }
            catch { return [] }
        }()

        let (_, s, st, log) = await (settingsSync, soulTask, statusTask, logTask)
        self.soul = s
        self.status = st
        self.recentEvolution = log
        isLoading = false
    }

    private func saveEdit() async {
        isSaving = true
        defer { isSaving = false }

        struct UpdateBody: Encodable {
            let content: String
        }

        do {
            let updated: SoulDocument = try await APIClient.shared.fetch(
                path: "/api/soul",
                method: "PUT",
                body: UpdateBody(content: editDraft)
            )
            self.soul = updated
            self.isEditing = false
            self.editDraft = ""
            // Refresh status
            if let st: SoulStatus = try? await APIClient.shared.fetch(path: "/api/soul/status") {
                self.status = st
            }
        } catch {
            print("[SoulPage] Failed to save: \(error)")
        }
    }
}
