import Foundation
import Combine
import SwiftUI

@MainActor
class AuthService: ObservableObject {
    @Published var isAuthenticated: Bool = false
    @Published var isLoading: Bool = true

    private let serverURLKey = "codecrab_server_url"
    private let serverHistoryKey = "codecrab_server_history"
    private let maxHistoryCount = 10
    private var unauthorizedObserver: Any?

    init() {
        unauthorizedObserver = NotificationCenter.default.addObserver(
            forName: .apiUnauthorized,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.isAuthenticated = false
            }
        }
    }

    deinit {
        if let observer = unauthorizedObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
    
    func getToken() -> String? {
        return KeychainHelper.shared.getToken()
    }
    
    func setToken(_ token: String) {
        KeychainHelper.shared.saveToken(token)
        SharedDataManager.shared.syncCredentials()
    }
    
    func clearToken() {
        KeychainHelper.shared.deleteToken()
    }
    
    func getServerURL() -> String? {
        return UserDefaults.standard.string(forKey: serverURLKey)
    }
    
    func setServerURL(_ url: String) {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalUrl = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        UserDefaults.standard.set(finalUrl, forKey: serverURLKey)
        addToServerHistory(finalUrl)
        SharedDataManager.shared.syncCredentials()
    }

    func clearServerURL() {
        UserDefaults.standard.removeObject(forKey: serverURLKey)
    }

    func getServerHistory() -> [String] {
        return UserDefaults.standard.stringArray(forKey: serverHistoryKey) ?? []
    }

    private func addToServerHistory(_ url: String) {
        var history = getServerHistory()
        history.removeAll { $0 == url }
        history.insert(url, at: 0)
        if history.count > maxHistoryCount {
            history = Array(history.prefix(maxHistoryCount))
        }
        UserDefaults.standard.set(history, forKey: serverHistoryKey)
    }

    func removeFromServerHistory(_ url: String) {
        var history = getServerHistory()
        history.removeAll { $0 == url }
        UserDefaults.standard.set(history, forKey: serverHistoryKey)
    }
    
    func verifyToken(_ token: String) async throws -> Bool {
        print("[AuthService] Starting verifyToken")
        guard let serverURL = getServerURL() else {
            print("[AuthService] No server URL found")
            throw URLError(.badURL)
        }
        
        let urlString = "\(serverURL)/api/auth/verify"
        print("[AuthService] Requesting URL: \(urlString)")
        
        guard let url = URL(string: urlString) else {
            print("[AuthService] Invalid URL: \(urlString)")
            throw URLError(.badURL)
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["token": token]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        print("[AuthService] Sending request with token: \(token.prefix(4))...")
        
        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let httpResponse = response as? HTTPURLResponse {
                print("[AuthService] Status code: \(httpResponse.statusCode)")

                if httpResponse.statusCode == 200,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   json["valid"] as? Bool == true {
                    print("[AuthService] Login successful")
                    setToken(token)
                    isAuthenticated = true
                    return true
                } else {
                    let bodyString = String(data: data, encoding: .utf8) ?? "no body"
                    print("[AuthService] Login failed with body: \(bodyString)")
                }
            } else {
                print("[AuthService] Invalid response type")
            }
        } catch {
            print("[AuthService] Network error: \(error.localizedDescription)")
            throw error
        }
        
        return false
    }
    
    func checkAuth() async {
        print("[AuthService] Starting checkAuth")
        defer { 
            isLoading = false 
            print("[AuthService] checkAuth finished, isLoading = false")
        }
        
        guard let token = getToken() else {
            print("[AuthService] No token found in keychain")
            isAuthenticated = false
            return
        }
        
        guard let serverURL = getServerURL() else {
            print("[AuthService] No server URL found in UserDefaults")
            isAuthenticated = false
            return
        }
        
        let urlString = "\(serverURL)/api/auth/status"
        print("[AuthService] Checking status at: \(urlString)")
        
        guard let url = URL(string: urlString) else {
            print("[AuthService] Invalid status URL: \(urlString)")
            isAuthenticated = false
            return
        }
        
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        
        do {
            print("[AuthService] Sending status request...")
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                print("[AuthService] Status check response: \(httpResponse.statusCode)")
                if httpResponse.statusCode == 200 {
                    print("[AuthService] Session valid")
                    isAuthenticated = true
                    SharedDataManager.shared.syncCredentials()
                } else {
                    let body = String(data: data, encoding: .utf8) ?? "no body"
                    print("[AuthService] Session invalid, body: \(body)")
                    isAuthenticated = false
                }
            } else {
                print("[AuthService] Invalid response type for status check")
                isAuthenticated = false
            }
        } catch {
            print("[AuthService] Status check error: \(error.localizedDescription)")
            isAuthenticated = false
        }
    }
    
    func logout() {
        clearToken()
        isAuthenticated = false
    }
}
