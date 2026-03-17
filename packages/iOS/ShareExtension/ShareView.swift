import SwiftUI
import UniformTypeIdentifiers

// MARK: - Models (self-contained for extension target)

private let appGroupId = "group.cn.byutech.codecrab"

private struct ShareProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
    let icon: String
    let createdAt: Double
    let updatedAt: Double

    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func == (lhs: ShareProject, rhs: ShareProject) -> Bool { lhs.id == rhs.id }
}

private struct ShareSession: Codable, Identifiable {
    var id: String { sessionId }
    let sessionId: String
    let summary: String
    let lastModified: Double
    let firstPrompt: String?
    let cwd: String?
    let status: String?
    let isActive: Bool?
    let cronJobName: String?
}

private struct PendingShareMetadata: Codable {
    let id: String
    let projectId: String
    let sessionId: String?
    let files: [SharedFileInfo]
}

private struct SharedFileInfo: Codable {
    let name: String
    let mimeType: String
}

// MARK: - App Group Data Manager (extension-side)

private class ShareDataManager {
    static let shared = ShareDataManager()

    private var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupId)
    }

    private var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    var serverURL: String? { sharedDefaults?.string(forKey: "serverURL") }
    var authToken: String? { sharedDefaults?.string(forKey: "authToken") }

    func savePendingShare(metadata: PendingShareMetadata, fileDataPairs: [(name: String, data: Data)]) {
        guard let container = containerURL else { return }
        let shareDir = container.appendingPathComponent("Shares").appendingPathComponent(metadata.id)
        try? FileManager.default.createDirectory(at: shareDir, withIntermediateDirectories: true)

        if let data = try? JSONEncoder().encode(metadata) {
            try? data.write(to: shareDir.appendingPathComponent("metadata.json"))
        }
        for file in fileDataPairs {
            try? file.data.write(to: shareDir.appendingPathComponent(file.name))
        }
    }
}

// MARK: - Image Compression (simplified for extension)

private func compressImageForShare(_ data: Data) -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    let maxDimension: CGFloat = 1568
    var size = image.size

    if max(size.width, size.height) > maxDimension {
        let ratio = maxDimension / max(size.width, size.height)
        size = CGSize(width: size.width * ratio, height: size.height * ratio)
    }

    UIGraphicsBeginImageContextWithOptions(size, false, 1.0)
    image.draw(in: CGRect(origin: .zero, size: size))
    let resized = UIGraphicsGetImageFromCurrentImageContext() ?? image
    UIGraphicsEndImageContext()

    var quality: CGFloat = 0.85
    while quality > 0.1 {
        if let compressed = resized.jpegData(compressionQuality: quality), compressed.count <= 5_000_000 {
            return compressed
        }
        quality -= 0.15
    }
    return resized.jpegData(compressionQuality: 0.1)
}

// MARK: - Main Navigation View

struct ShareNavigationView: View {
    let itemProviders: [NSItemProvider]
    let onComplete: () -> Void
    let onCancel: () -> Void
    let onOpenApp: (URL) -> Void

    @State private var projects: [ShareProject] = []
    @State private var sessions: [ShareSession] = []
    @State private var selectedProject: ShareProject?
    @State private var isLoadingProjects = true
    @State private var isLoadingSessions = false
    @State private var isSending = false
    @State private var showSuccess = false
    @State private var errorMessage: String?
    @State private var fileNames: [String] = []

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // File info banner
                if !fileNames.isEmpty {
                    HStack {
                        Image(systemName: "doc.fill")
                            .foregroundColor(.orange)
                        Text(fileNames.count == 1 ? fileNames[0] : "\(fileNames.count) files")
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.orange.opacity(0.08))
                }

                if showSuccess {
                    Spacer()
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 56))
                            .foregroundColor(.green)
                        Text("Shared successfully!")
                            .font(.headline)
                        Text("Switch to CodeCrab to continue")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                } else if isLoadingProjects {
                    Spacer()
                    ProgressView("Loading projects...")
                    Spacer()
                } else if let error = errorMessage {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundColor(.orange)
                        Text(error)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Retry") { loadProjects() }
                            .buttonStyle(.bordered)
                    }
                    .padding()
                    Spacer()
                } else if selectedProject == nil {
                    projectListView
                } else {
                    sessionListView
                }
            }
            .navigationTitle(selectedProject == nil ? "Select Project" : "Select Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if selectedProject != nil {
                        Button(action: {
                            selectedProject = nil
                            sessions = []
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 14, weight: .semibold))
                                Text("Back")
                                    .font(.subheadline)
                            }
                        }
                    } else {
                        Button("Cancel") { onCancel() }
                    }
                }
            }
            .overlay {
                if isSending {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        VStack(spacing: 12) {
                            ProgressView()
                                .scaleEffect(1.2)
                            Text("Preparing files...")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        .padding(24)
                        .background(.regularMaterial)
                        .cornerRadius(16)
                    }
                }
            }
        }
        .onAppear {
            loadProjects()
            loadFileNames()
        }
    }

    // MARK: - Project List

    private var projectListView: some View {
        List(projects) { project in
            Button {
                selectedProject = project
                loadSessions(projectId: project.id)
            } label: {
                HStack(spacing: 12) {
                    Text(project.icon)
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name)
                            .font(.body)
                            .fontWeight(.medium)
                            .foregroundColor(.primary)
                        Text(shortenPath(project.path))
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Session List

    private var sessionListView: some View {
        List {
            Button {
                prepareAndSend(sessionId: nil)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundColor(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("New Session")
                            .font(.body)
                            .fontWeight(.medium)
                            .foregroundColor(.primary)
                        Text("Start a fresh conversation")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isLoadingSessions {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else if !sessions.isEmpty {
                Section("Recent Sessions") {
                    ForEach(sessions.prefix(20)) { session in
                        Button {
                            prepareAndSend(sessionId: session.sessionId)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(sessionTitle(session))
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                    .foregroundColor(.primary)
                                    .lineLimit(2)
                                Text(formatRelativeDate(session.lastModified))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Data Loading

    private func loadFileNames() {
        Task {
            var names: [String] = []
            for provider in itemProviders {
                if let name = provider.suggestedName {
                    names.append(name)
                } else if let ext = provider.registeredTypeIdentifiers.first.flatMap({ UTType($0)?.preferredFilenameExtension }) {
                    names.append("file.\(ext)")
                }
            }
            fileNames = names.isEmpty ? ["Shared content"] : names
        }
    }

    private func loadProjects() {
        isLoadingProjects = true
        errorMessage = nil

        guard let serverURL = ShareDataManager.shared.serverURL,
              let token = ShareDataManager.shared.authToken else {
            errorMessage = "Not configured.\nOpen CodeCrab app first and log in."
            isLoadingProjects = false
            return
        }

        Task {
            do {
                guard let url = URL(string: "\(serverURL)/api/projects") else { throw URLError(.badURL) }
                var request = URLRequest(url: url)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.timeoutInterval = 10
                let (data, response) = try await URLSession.shared.data(for: request)

                guard let httpResponse = response as? HTTPURLResponse,
                      (200...299).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }

                projects = try JSONDecoder().decode([ShareProject].self, from: data)
                isLoadingProjects = false
            } catch {
                errorMessage = "Failed to load projects.\nCheck your connection."
                isLoadingProjects = false
            }
        }
    }

    private func loadSessions(projectId: String) {
        isLoadingSessions = true

        guard let serverURL = ShareDataManager.shared.serverURL,
              let token = ShareDataManager.shared.authToken else { return }

        Task {
            do {
                guard let url = URL(string: "\(serverURL)/api/sessions?projectId=\(projectId)") else { return }
                var request = URLRequest(url: url)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.timeoutInterval = 10
                let (data, _) = try await URLSession.shared.data(for: request)
                let decoded = try JSONDecoder().decode([ShareSession].self, from: data)
                sessions = decoded.sorted { $0.lastModified > $1.lastModified }
            } catch {
                sessions = []
            }
            isLoadingSessions = false
        }
    }

    // MARK: - File Processing & Send

    private func prepareAndSend(sessionId: String?) {
        guard let project = selectedProject else { return }
        isSending = true

        Task {
            let shareId = UUID().uuidString
            var fileInfos: [SharedFileInfo] = []
            var fileDataPairs: [(name: String, data: Data)] = []

            for (index, provider) in itemProviders.enumerated() {
                if let (name, data, mimeType) = await loadFileData(from: provider) {
                    let finalData: Data
                    let finalMimeType: String
                    let finalName: String

                    if mimeType.hasPrefix("image/"), let compressed = compressImageForShare(data) {
                        finalData = compressed
                        finalMimeType = "image/jpeg"
                        let base = nameWithoutExtension(name)
                        finalName = "\(base).jpg"
                    } else {
                        finalData = data
                        finalMimeType = mimeType
                        finalName = name
                    }

                    // Ensure unique filenames
                    let uniqueName = fileDataPairs.contains(where: { $0.name == finalName })
                        ? "\(index)_\(finalName)" : finalName

                    fileInfos.append(SharedFileInfo(name: uniqueName, mimeType: finalMimeType))
                    fileDataPairs.append((uniqueName, finalData))
                }
            }

            guard !fileInfos.isEmpty else {
                isSending = false
                return
            }

            let metadata = PendingShareMetadata(
                id: shareId,
                projectId: project.id,
                sessionId: sessionId,
                files: fileInfos
            )

            ShareDataManager.shared.savePendingShare(metadata: metadata, fileDataPairs: fileDataPairs)

            isSending = false

            if let url = URL(string: "codecrab://share?id=\(shareId)") {
                onOpenApp(url)
                // Give system time to open, then show fallback if still here
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                // If we're still here, open failed — show success and auto-dismiss
                showSuccess = true
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                onComplete()
            } else {
                onComplete()
            }
        }
    }

    private func loadFileData(from provider: NSItemProvider) async -> (name: String, data: Data, mimeType: String)? {
        for typeId in provider.registeredTypeIdentifiers {
            if let result = await loadItem(from: provider, typeIdentifier: typeId) {
                return result
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.item.identifier) {
            return await loadItem(from: provider, typeIdentifier: UTType.item.identifier)
        }
        return nil
    }

    private func loadItem(from provider: NSItemProvider, typeIdentifier: String) async -> (name: String, data: Data, mimeType: String)? {
        let suggestedName = provider.suggestedName
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL, let data = try? Data(contentsOf: url) {
                    let name = suggestedName ?? url.lastPathComponent
                    let mimeType = mimeTypeForExtension(url.pathExtension)
                    continuation.resume(returning: (name, data, mimeType))
                } else if let data = item as? Data {
                    let utType = UTType(typeIdentifier)
                    let ext = utType?.preferredFilenameExtension ?? "dat"
                    let name = suggestedName ?? "file.\(ext)"
                    let mimeType = utType?.preferredMIMEType ?? "application/octet-stream"
                    continuation.resume(returning: (name, data, mimeType))
                } else if let image = item as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
                    let name = suggestedName ?? "image.jpg"
                    continuation.resume(returning: (name, data, "image/jpeg"))
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    // MARK: - Helpers

    private func mimeTypeForExtension(_ ext: String) -> String {
        if let utType = UTType(filenameExtension: ext) {
            return utType.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }

    private func nameWithoutExtension(_ name: String) -> String {
        if let dotIndex = name.lastIndex(of: ".") {
            return String(name[name.startIndex..<dotIndex])
        }
        return name
    }

    private func sessionTitle(_ session: ShareSession) -> String {
        if !session.summary.isEmpty { return session.summary }
        if let prompt = session.firstPrompt, !prompt.isEmpty { return prompt }
        return "Untitled session"
    }

    private func shortenPath(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func formatRelativeDate(_ timestamp: Double) -> String {
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
