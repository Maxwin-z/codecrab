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
            ProgressView("Starting CodeClaws...")
        } else if !auth.isAuthenticated {
            LoginView()
        } else {
            NavigationStack {
                HomeView()
            }
        }
    }
}
