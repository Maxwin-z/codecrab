import Foundation
import Combine
import UIKit
import UserNotifications

struct PushDeepLink: Equatable {
    let projectId: String
    let sessionId: String
    let title: String
    let body: String
}

@MainActor
class PushNotificationService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationService()

    @Published var deviceToken: String?
    @Published var isRegistered: Bool = false

    /// Published when user taps a notification (background) or notification arrives (foreground)
    @Published var pendingDeepLink: PushDeepLink? = nil

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - Parse Deep Link from Notification

    private nonisolated func parseDeepLink(from content: UNNotificationContent) -> PushDeepLink? {
        let userInfo = content.userInfo
        guard let projectId = userInfo["projectId"] as? String,
              let sessionId = userInfo["sessionId"] as? String else {
            return nil
        }
        return PushDeepLink(
            projectId: projectId,
            sessionId: sessionId,
            title: content.title,
            body: content.body
        )
    }

    // MARK: - Foreground Notification Display

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let content = notification.request.content
        print("[Push] Received in foreground — title: \(content.title), body: \(content.body), userInfo: \(content.userInfo)")

        if let deepLink = parseDeepLink(from: content) {
            // Show custom toast instead of system banner
            Task { @MainActor in
                self.pendingDeepLink = deepLink
            }
            completionHandler([.sound])
        } else {
            // No deep link data — show system banner
            completionHandler([.banner, .sound, .badge])
        }
    }

    // MARK: - Notification Tap (Background/Foreground)

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        print("[Push] User tapped notification — title: \(content.title), body: \(content.body), userInfo: \(content.userInfo)")

        if let deepLink = parseDeepLink(from: content) {
            Task { @MainActor in
                self.pendingDeepLink = deepLink
            }
        }

        completionHandler()
    }

    // MARK: - Consume Deep Link

    func consumeDeepLink() {
        pendingDeepLink = nil
    }

    // MARK: - Request Permission & Register

    func requestPermissionAndRegister() {
        print("[Push] requestPermissionAndRegister called")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[Push] Authorization error: \(error.localizedDescription)")
                return
            }
            print("[Push] Authorization granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    print("[Push] Calling registerForRemoteNotifications...")
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - Token Handling

    func didRegisterForRemoteNotifications(deviceToken token: Data) {
        let tokenString = token.map { String(format: "%02x", $0) }.joined()
        print("[Push] Device token received: \(tokenString)")
        self.deviceToken = tokenString
        Task {
            await uploadToken(tokenString)
        }
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("[Push] Failed to register for remote notifications: \(error.localizedDescription)")
    }

    // MARK: - Server Registration

    private func uploadToken(_ token: String) async {
        struct RegisterBody: Encodable {
            let token: String
            let label: String
        }
        struct RegisterResponse: Decodable {
            let ok: Bool
        }

        let label = UIDevice.current.name
        print("[Push] Uploading token to server (label: \(label))...")

        do {
            let _: RegisterResponse = try await APIClient.shared.fetch(
                path: "/api/push/register",
                method: "POST",
                body: RegisterBody(token: token, label: label)
            )
            print("[Push] Token registered with server successfully")
            self.isRegistered = true
        } catch {
            print("[Push] Failed to register token with server: \(error)")
        }
    }

    func unregisterToken() async {
        guard let token = deviceToken else { return }

        struct UnregisterBody: Encodable {
            let token: String
        }
        struct UnregisterResponse: Decodable {
            let ok: Bool
            let removed: Bool
        }

        do {
            let _: UnregisterResponse = try await APIClient.shared.fetch(
                path: "/api/push/unregister",
                method: "POST",
                body: UnregisterBody(token: token)
            )
            print("[Push] Token unregistered from server")
            self.isRegistered = false
            self.deviceToken = nil
        } catch {
            print("[Push] Failed to unregister token: \(error.localizedDescription)")
        }
    }
}
