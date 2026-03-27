import Foundation

extension Notification.Name {
    static let apiUnauthorized = Notification.Name("APIClient.unauthorized")
}

class APIClient {
    static let shared = APIClient()
    private let session: URLSession
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }
    
    enum APIError: Error, LocalizedError {
        case noServerURL
        case invalidURL
        case unauthorized
        case httpError(Int)
        case decodingError(Error)
        case other(Error)
        
        var errorDescription: String? {
            switch self {
            case .noServerURL: return "Server URL is not configured."
            case .invalidURL: return "Invalid URL."
            case .unauthorized: return "Unauthorized. Please log in again."
            case .httpError(let code): return "Server returned error code: \(code)"
            case .decodingError(let err): return "Failed to decode response: \(err.localizedDescription)"
            case .other(let err): return err.localizedDescription
            }
        }
    }
    
    private func makeRequest(path: String, method: String = "GET", body: Data? = nil, isPublic: Bool = false) throws -> URLRequest {
        guard let serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url") else {
            throw APIError.noServerURL
        }
        guard let url = URL(string: "\(serverURL)\(path)") else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if !isPublic {
            if let token = KeychainHelper.shared.getToken() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        }
        if let body = body {
            request.httpBody = body
        }
        return request
    }
    
    func fetch<T: Decodable>(path: String, method: String = "GET", body: Encodable? = nil, isPublic: Bool = false) async throws -> T {
        var bodyData: Data? = nil
        if let body = body {
            bodyData = try JSONEncoder().encode(body)
        }
        let request = try makeRequest(path: path, method: method, body: bodyData, isPublic: isPublic)
        
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidURL
        }
        if httpResponse.statusCode == 401 {
            NotificationCenter.default.post(name: .apiUnauthorized, object: nil)
            throw APIError.unauthorized
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(httpResponse.statusCode)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }
    
    func fetchData(path: String) async throws -> Data {
        let request = try makeRequest(path: path)
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidURL
        }
        if httpResponse.statusCode == 401 {
            NotificationCenter.default.post(name: .apiUnauthorized, object: nil)
            throw APIError.unauthorized
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(httpResponse.statusCode)
        }
        return data
    }

    func buildURL(path: String) -> URL? {
        guard let serverURL = UserDefaults.standard.string(forKey: "codecrab_server_url") else { return nil }
        var urlString = "\(serverURL)\(path)"
        if let token = KeychainHelper.shared.getToken() {
            urlString += (urlString.contains("?") ? "&" : "?") + "token=\(token)"
        }
        return URL(string: urlString)
    }

    func request(path: String, method: String = "GET", body: Encodable? = nil, isPublic: Bool = false) async throws {
        var bodyData: Data? = nil
        if let body = body {
            bodyData = try JSONEncoder().encode(body)
        }
        let request = try makeRequest(path: path, method: method, body: bodyData, isPublic: isPublic)
        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidURL
        }
        if httpResponse.statusCode == 401 {
            NotificationCenter.default.post(name: .apiUnauthorized, object: nil)
            throw APIError.unauthorized
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(httpResponse.statusCode)
        }
    }
}
