import Foundation
import Combine
import Network

struct DiscoveredServer: Identifiable, Equatable {
    let id = UUID()
    let ip: String
    let port: Int
    let url: String
    let version: String
}

@MainActor
class LANScanner: ObservableObject {
    @Published var isScanning: Bool = false
    @Published var discoveredServers: [DiscoveredServer] = []
    @Published var progress: Double = 0

    private var scanTask: Task<Void, Never>?

    func scan(port: Int) {
        scanTask?.cancel()
        discoveredServers = []
        isScanning = true
        progress = 0

        scanTask = Task {
            let subnet = getLocalSubnet()
            guard let subnet = subnet else {
                isScanning = false
                return
            }

            let total = 254
            var completed = 0

            // Scan in batches of 30 concurrent requests
            let batchSize = 30
            for batchStart in stride(from: 1, through: total, by: batchSize) {
                if Task.isCancelled { break }

                let batchEnd = min(batchStart + batchSize - 1, total)
                await withTaskGroup(of: DiscoveredServer?.self) { group in
                    for i in batchStart...batchEnd {
                        let ip = "\(subnet).\(i)"
                        group.addTask { [weak self] in
                            guard self != nil else { return nil }
                            return await self?.probe(ip: ip, port: port)
                        }
                    }

                    for await result in group {
                        completed += 1
                        progress = Double(completed) / Double(total)
                        if let server = result {
                            discoveredServers.append(server)
                        }
                    }
                }
            }

            isScanning = false
            progress = 1
        }
    }

    func cancel() {
        scanTask?.cancel()
        isScanning = false
    }

    /// Probe a single IP:port for the /api/discovery endpoint
    private func probe(ip: String, port: Int) async -> DiscoveredServer? {
        let urlString = "http://\(ip):\(port)/api/discovery"
        guard let url = URL(string: urlString) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.httpMethod = "GET"

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return nil }

            struct DiscoveryResponse: Decodable {
                let service: String
                let version: String
            }

            let body = try JSONDecoder().decode(DiscoveryResponse.self, from: data)
            guard body.service == "CodeCrab" else { return nil }

            return DiscoveredServer(
                ip: ip,
                port: port,
                url: "http://\(ip):\(port)",
                version: body.version
            )
        } catch {
            return nil
        }
    }

    /// Get the local subnet prefix (e.g. "192.168.1")
    private func getLocalSubnet() -> String? {
        var addresses: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let sa = ptr.pointee.ifa_addr.pointee
            guard sa.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: ptr.pointee.ifa_name)
            // en0 = WiFi, en1 = Ethernet on some devices
            guard name == "en0" || name == "en1" else { continue }

            var addr = ptr.pointee.ifa_addr.pointee
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(&addr, socklen_t(addr.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
            let ip = String(cString: hostname)
            if !ip.isEmpty {
                addresses.append(ip)
            }
        }

        guard let localIP = addresses.first else { return nil }
        let parts = localIP.split(separator: ".")
        guard parts.count == 4 else { return nil }
        return "\(parts[0]).\(parts[1]).\(parts[2])"
    }
}
