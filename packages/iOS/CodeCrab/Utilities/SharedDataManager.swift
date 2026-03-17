import Foundation
import UIKit
import AVFoundation

struct PendingShareMetadata: Codable {
    let id: String
    let projectId: String
    let sessionId: String?
    let files: [SharedFileInfo]
}

struct SharedFileInfo: Codable {
    let name: String
    let mimeType: String
}

class SharedDataManager {
    static let shared = SharedDataManager()
    static let appGroupId = "group.cn.byutech.codecrab"

    private var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: Self.appGroupId)
    }

    private var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupId)
    }

    // MARK: - Auth Sharing (written by main app, read by extension)

    var serverURL: String? {
        get { sharedDefaults?.string(forKey: "serverURL") }
        set { sharedDefaults?.set(newValue, forKey: "serverURL") }
    }

    var authToken: String? {
        get { sharedDefaults?.string(forKey: "authToken") }
        set { sharedDefaults?.set(newValue, forKey: "authToken") }
    }

    /// Sync main app credentials to App Group for extension access
    func syncCredentials() {
        serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url")
        authToken = KeychainHelper.shared.getToken()
    }

    // MARK: - Pending Share (written by extension, read by main app)

    func loadPendingShare() -> (metadata: PendingShareMetadata, files: [(name: String, data: Data, mimeType: String)])? {
        guard let container = containerURL else { return nil }
        let sharesDir = container.appendingPathComponent("Shares")

        guard let contents = try? FileManager.default.contentsOfDirectory(at: sharesDir, includingPropertiesForKeys: nil),
              !contents.isEmpty else {
            return nil
        }

        for dir in contents {
            let metadataURL = dir.appendingPathComponent("metadata.json")
            guard let metadataData = try? Data(contentsOf: metadataURL),
                  let metadata = try? JSONDecoder().decode(PendingShareMetadata.self, from: metadataData) else {
                continue
            }

            var files: [(name: String, data: Data, mimeType: String)] = []
            for fileInfo in metadata.files {
                let fileURL = dir.appendingPathComponent(fileInfo.name)
                if let fileData = try? Data(contentsOf: fileURL) {
                    files.append((fileInfo.name, fileData, fileInfo.mimeType))
                }
            }

            return (metadata, files)
        }

        return nil
    }

    func clearPendingShare(id: String) {
        guard let container = containerURL else { return }
        let shareDir = container.appendingPathComponent("Shares").appendingPathComponent(id)
        try? FileManager.default.removeItem(at: shareDir)
    }

    func clearAllPendingShares() {
        guard let container = containerURL else { return }
        let sharesDir = container.appendingPathComponent("Shares")
        try? FileManager.default.removeItem(at: sharesDir)
    }

    /// Load pending share and convert files to ImageAttachment array
    func consumePendingShare() -> (projectId: String, sessionId: String?, attachments: [ImageAttachment])? {
        guard let (metadata, files) = loadPendingShare() else { return nil }

        var attachments: [ImageAttachment] = []
        for file in files {
            if file.mimeType.hasPrefix("image/") {
                // Compress images
                if let image = UIImage(data: file.data),
                   let compressed = ImageCompressor.compressImage(image) {
                    attachments.append(ImageAttachment(
                        data: compressed.data,
                        mediaType: compressed.mediaType,
                        name: file.name
                    ))
                } else {
                    let base64 = file.data.base64EncodedString()
                    attachments.append(ImageAttachment(data: base64, mediaType: file.mimeType, name: file.name))
                }
            } else if file.mimeType.hasPrefix("video/") {
                // Extract thumbnail from video
                if let thumbnail = extractVideoThumbnail(from: file.data),
                   let compressed = ImageCompressor.compressImage(thumbnail) {
                    attachments.append(ImageAttachment(
                        data: compressed.data,
                        mediaType: compressed.mediaType,
                        name: (file.name as NSString).deletingPathExtension + "_thumbnail.jpg"
                    ))
                }
            }
            // Skip other non-image file types (not supported by Claude API)
        }

        clearPendingShare(id: metadata.id)
        return (metadata.projectId, metadata.sessionId, attachments)
    }

    /// Extract a thumbnail frame from video data
    private func extractVideoThumbnail(from videoData: Data) -> UIImage? {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: tempURL) }

        do {
            try videoData.write(to: tempURL)
            let asset = AVURLAsset(url: tempURL)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1568, height: 1568)
            var cgImage: CGImage?
            let semaphore = DispatchSemaphore(value: 0)
            generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: .zero)]) { _, image, _, _, _ in
                cgImage = image
                semaphore.signal()
            }
            semaphore.wait()
            if let cgImage {
                return UIImage(cgImage: cgImage)
            }
            return nil
        } catch {
            return nil
        }
    }
}
