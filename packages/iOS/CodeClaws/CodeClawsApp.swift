import SwiftUI

@main
struct CodeClawsApp: App {
    @StateObject var authService = AuthService()
    @StateObject var webSocketService = WebSocketService()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authService)
                .environmentObject(webSocketService)
                .task {
                    await authService.checkAuth()
                }
        }
    }
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

                // Animated lobster
                ZStack {
                    // Glow effect
                    Circle()
                        .fill(Color.orange.opacity(0.15))
                        .frame(width: 180, height: 180)
                        .scaleEffect(lobsterScale * 1.2)

                    Text("🦞")
                        .font(.system(size: 100))
                        .scaleEffect(lobsterScale)
                        .rotationEffect(.degrees(lobsterRotation))
                }

                // App name
                VStack(spacing: 8) {
                    Text("CodeClaws")
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
