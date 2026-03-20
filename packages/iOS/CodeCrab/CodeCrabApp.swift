import SwiftUI
import UIKit
import Combine

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushNotificationService.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            PushNotificationService.shared.didFailToRegisterForRemoteNotifications(error: error)
        }
    }
}

/// Tracks pending share data from the Share Extension
class ShareHandler: ObservableObject {
    @Published var pendingProjectId: String?
    @Published var pendingSessionId: String?
    @Published var pendingAttachments: [ImageAttachment] = []

    func handleURL(_ url: URL) {
        guard url.scheme == "codecrab", url.host == "share" else { return }
        consumeShare()
    }

    func checkOnActivation() {
        // Also check when app becomes active (fallback if URL scheme didn't fire)
        if pendingProjectId == nil {
            consumeShare()
        }
    }

    private func consumeShare() {
        guard let result = SharedDataManager.shared.consumePendingShare() else { return }
        pendingProjectId = result.projectId
        pendingSessionId = result.sessionId
        pendingAttachments = result.attachments
    }

    func clear() {
        pendingProjectId = nil
        pendingSessionId = nil
        pendingAttachments = []
    }
}

@main
struct CodeCrabApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject var authService = AuthService()
    @StateObject var webSocketService = WebSocketService()
    @StateObject var shareHandler = ShareHandler()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authService)
                .environmentObject(webSocketService)
                .environmentObject(shareHandler)
                .onOpenURL { url in
                    shareHandler.handleURL(url)
                }
                .task {
                    await authService.checkAuth()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        shareHandler.checkOnActivation()
                        webSocketService.onForegroundReturn()
                        Task {
                            await authService.checkAuth()
                        }
                        // Clean up stale Live Activities if nothing is running
                        // Uses endAllActivities() to also clear activities from previous launches
                        // where currentActivity is nil but system activities persist
                        if webSocketService.runningProjectIds.isEmpty {
                            LiveActivityService.shared.endAllActivities()
                        }
                        endLiveActivityBackgroundTask()
                    } else if phase == .background {
                        // Flush any pending Live Activity update before suspension
                        LiveActivityService.shared.flushPendingUpdate()
                        // Request background execution time to keep WebSocket alive
                        // so Live Activity continues updating on the Lock Screen
                        if LiveActivityService.shared.isActive {
                            beginLiveActivityBackgroundTask()
                        }
                    }
                }
        }
    }
}

// Background task ID for keeping WebSocket alive while Live Activity is visible
private var liveActivityBgTaskId: UIBackgroundTaskIdentifier = .invalid

private func beginLiveActivityBackgroundTask() {
    guard liveActivityBgTaskId == .invalid else { return }
    liveActivityBgTaskId = UIApplication.shared.beginBackgroundTask {
        endLiveActivityBackgroundTask()
    }
}

private func endLiveActivityBackgroundTask() {
    guard liveActivityBgTaskId != .invalid else { return }
    UIApplication.shared.endBackgroundTask(liveActivityBgTaskId)
    liveActivityBgTaskId = .invalid
}

struct RootView: View {
    @EnvironmentObject var auth: AuthService

    var body: some View {
        if auth.isLoading {
            LaunchScreen()
        } else if !auth.isAuthenticated {
            LoginView()
        } else {
            HomeView()
                .onAppear {
                    PushNotificationService.shared.requestPermissionAndRegister()
                }
        }
    }
}

struct LaunchScreen: View {
    @State private var lobsterScale: CGFloat = 0.6
    @State private var lobsterRotation: Double = -10
    @State private var textOpacity: Double = 0
    @State private var progressOpacity: Double = 0
    @State private var waveOffset: CGFloat = 0

    var body: some View {
        ZStack {
            // Gradient background
            LinearGradient(
                colors: [
                    Color(red: 0.98, green: 0.95, blue: 0.92),
                    Color(red: 0.95, green: 0.90, blue: 0.85)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            // Decorative bubbles
            BubblesView()

            VStack(spacing: 32) {
                Spacer()

                // Animated logo
                ZStack {
                    // Glow effect
                    Circle()
                        .fill(Color.orange.opacity(0.15))
                        .frame(width: 180, height: 180)
                        .scaleEffect(lobsterScale * 1.2)

                    Text("🦀")
                        .font(.system(size: 100))
                        .scaleEffect(lobsterScale)
                        .rotationEffect(.degrees(lobsterRotation))
                }

                // App name
                VStack(spacing: 8) {
                    Text("CodeCrab")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundColor(Color(red: 0.35, green: 0.25, blue: 0.20))

                    Text("AI-Powered Coding")
                        .font(.system(size: 16, weight: .medium, design: .rounded))
                        .foregroundColor(Color(red: 0.55, green: 0.40, blue: 0.30))
                        .opacity(textOpacity)
                }

                Spacer()

                // Loading indicator
                VStack(spacing: 16) {
                    ProgressView()
                        .scaleEffect(1.2)
                        .tint(Color(red: 0.85, green: 0.45, blue: 0.25))

                    Text("Loading...")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundColor(Color(red: 0.60, green: 0.45, blue: 0.35))
                }
                .opacity(progressOpacity)

                Spacer().frame(height: 60)
            }
        }
        .onAppear {
            // Entrance animations
            withAnimation(.spring(response: 0.6, dampingFraction: 0.6)) {
                lobsterScale = 1.0
            }

            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                lobsterRotation = 10
            }

            withAnimation(.easeOut(duration: 0.8).delay(0.3)) {
                textOpacity = 1
            }

            withAnimation(.easeOut(duration: 0.6).delay(0.5)) {
                progressOpacity = 1
            }
        }
    }
}

// Decorative floating bubbles
struct BubblesView: View {
    @State private var bubbles: [Bubble] = []

    struct Bubble: Identifiable {
        let id = UUID()
        var x: CGFloat
        var y: CGFloat
        var size: CGFloat
        var opacity: Double
        var speed: Double
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.016, paused: false)) { _ in
            Canvas { context, size in
                for bubble in bubbles {
                    let rect = CGRect(
                        x: bubble.x,
                        y: bubble.y,
                        width: bubble.size,
                        height: bubble.size
                    )
                    let path = Circle().path(in: rect)
                    context.fill(path, with: .color(Color.orange.opacity(bubble.opacity * 0.15)))
                }
            }
        }
        .onAppear {
            // Create random bubbles
            bubbles = (0..<8).map { _ in
                Bubble(
                    x: CGFloat.random(in: 0...400),
                    y: CGFloat.random(in: 0...900),
                    size: CGFloat.random(in: 20...60),
                    opacity: Double.random(in: 0.3...0.7),
                    speed: Double.random(in: 0.3...0.8)
                )
            }

            // Animate bubbles
            Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
                for index in bubbles.indices {
                    bubbles[index].y -= bubbles[index].speed
                    if bubbles[index].y < -100 {
                        bubbles[index].y = 900
                        bubbles[index].x = CGFloat.random(in: 0...400)
                    }
                }
            }
        }
    }
}
