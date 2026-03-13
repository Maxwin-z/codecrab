import Foundation
import Combine
import UIKit
import UserNotifications

@MainActor
class PushNotificationService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationService()

    @Published var deviceToken: String?
    @Published var isRegistered: Bool = false

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - Foreground Notification Display

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let content = notification.request.content
        print("[Push] Received in foreground — title: \(content.title), body: \(content.body), userInfo: \(content.userInfo)")
        completionHandler([.banner, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        print("[Push] User tapped notification — title: \(content.title), body: \(content.body), userInfo: \(content.userInfo)")
        completionHandler()
    }

    // MARK: - Request Permission & Register

    func requestPermissionAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                print("[Push] Authorization error: \(error.localizedDescription)")
                return
            }
            print("[Push] Authorization granted: \(granted)")
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - Token Handling

    func didRegisterForRemoteNotifications(deviceToken token: Data) {
        let tokenString = token.map { String(format: "%02x", $0) }.joined()
        print("[Push] Device token: \(tokenString)")
        self.deviceToken = tokenString
        Task {
            await uploadToken(tokenString)
        }
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("[Push] Failed to register: \(error.localizedDescription)")
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

        do {
            let _: RegisterResponse = try await APIClient.shared.fetch(
                path: "/api/push/register",
                method: "POST",
                body: RegisterBody(token: token, label: label)
            )
            print("[Push] Token registered with server")
            self.isRegistered = true
        } catch {
            print("[Push] Failed to register token with server: \(error.localizedDescription)")
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
