import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct LoginView: View {
    @EnvironmentObject var auth: AuthService
    @StateObject private var scanner = LANScanner()

    @State private var port: String = "4200"
    @State private var selectedServer: DiscoveredServer? = nil
    @State private var manualURL: String = ""
    @State private var showManualInput: Bool = false
    @State private var token: String = ""
    @State private var showToken: Bool = false
    @State private var isLoading: Bool = false
    @State private var errorMsg: String? = nil
    @State private var isChangingServer: Bool = false
    /// nil = not checked yet, true = reachable, false = unreachable
    @State private var serverReachable: Bool? = nil
    @State private var isCheckingServer: Bool = false
    @State private var showQRScanner: Bool = false

    private var cachedServerURL: String? {
        auth.getServerURL()
    }

    private var showScanUI: Bool {
        isChangingServer || cachedServerURL == nil || cachedServerURL == ""
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Header
                Image("CodeCrabLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 80, height: 80)
                    .padding(.top, 60)
                    .padding(.bottom, 20)

                Text("CodeCrab")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .padding(.bottom, 8)

                Text("Connect to your server")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding(.bottom, 32)

                // === Server Discovery Section ===
                VStack(alignment: .leading, spacing: 12) {
                    Label("Server", systemImage: "server.rack")
                        .font(.headline)
                        .foregroundColor(.primary)

                    // Show cached server if available
                    if let cached = cachedServerURL, !cached.isEmpty, !isChangingServer {
                        HStack(spacing: 10) {
                            // Reachability indicator
                            Group {
                                if isCheckingServer {
                                    ProgressView()
                                        .scaleEffect(0.7)
                                } else if serverReachable == true {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.green)
                                } else if serverReachable == false {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundColor(.red)
                                } else {
                                    Image(systemName: "circle")
                                        .foregroundColor(.secondary)
                                }
                            }
                            .frame(width: 20)

                            Text(cached)
                                .font(.system(.subheadline, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)

                            Spacer()

                            Button {
                                isChangingServer = true
                                serverReachable = nil
                            } label: {
                                Text("Change")
                                    .font(.caption)
                                    .foregroundColor(.accentColor)
                            }
                        }
                        .padding(12)
                        .background(Color(.systemGray6))
                        .cornerRadius(10)

                        // Unreachable hint
                        if serverReachable == false {
                            HStack(spacing: 6) {
                                Image(systemName: "exclamationmark.triangle")
                                    .font(.caption2)
                                Text("Server is unreachable. Check the address or scan for a new server.")
                                    .font(.caption2)
                            }
                            .foregroundColor(.orange)
                        }
                    }

                    // Show scan UI when no cached server or user wants to change
                    if showScanUI {
                        // Port input + Scan button
                        HStack(spacing: 12) {
                            HStack(spacing: 0) {
                                Image(systemName: "number")
                                    .foregroundColor(.secondary)
                                    .frame(width: 30)
                                TextField("Port", text: $port)
                                    .keyboardType(.numberPad)
                                    .frame(width: 70)
                            }
                            .padding(10)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)

                            Button(action: startScan) {
                                HStack(spacing: 6) {
                                    if scanner.isScanning {
                                        ProgressView()
                                            .scaleEffect(0.8)
                                    } else {
                                        Image(systemName: "antenna.radiowaves.left.and.right")
                                    }
                                    Text(scanner.isScanning ? "Scanning..." : "Scan LAN")
                                        .fontWeight(.medium)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(scanner.isScanning || port.isEmpty)

                            if scanner.isScanning {
                                Button {
                                    scanner.cancel()
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundColor(.secondary)
                                }
                            }
                        }

                        // Scan progress
                        if scanner.isScanning {
                            ProgressView(value: scanner.progress)
                                .tint(.accentColor)
                        }

                        // Discovered servers list
                        if !scanner.discoveredServers.isEmpty {
                            VStack(spacing: 8) {
                                ForEach(scanner.discoveredServers) { server in
                                    Button {
                                        selectServer(server)
                                    } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: selectedServer?.id == server.id ? "checkmark.circle.fill" : "circle")
                                                .foregroundColor(selectedServer?.id == server.id ? .green : .secondary)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(server.ip)
                                                    .font(.system(.body, design: .monospaced))
                                                    .foregroundColor(.primary)
                                                Text("v\(server.version)")
                                                    .font(.caption)
                                                    .foregroundColor(.secondary)
                                            }
                                            Spacer()
                                            Text(":\(server.port)")
                                                .font(.system(.caption, design: .monospaced))
                                                .foregroundColor(.secondary)
                                        }
                                        .padding(10)
                                        .background(
                                            RoundedRectangle(cornerRadius: 8)
                                                .fill(selectedServer?.id == server.id
                                                      ? Color.accentColor.opacity(0.08)
                                                      : Color(.systemGray6))
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 8)
                                                .stroke(selectedServer?.id == server.id
                                                        ? Color.accentColor.opacity(0.3)
                                                        : Color.clear, lineWidth: 1)
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        // No results after scan
                        if !scanner.isScanning && scanner.progress >= 1 && scanner.discoveredServers.isEmpty {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle")
                                    .foregroundColor(.orange)
                                Text("No servers found on port \(port)")
                                    .font(.footnote)
                                    .foregroundColor(.secondary)
                            }
                            .padding(10)
                        }

                        // Recent servers history
                        if !serverHistory.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Recent Servers")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .textCase(.uppercase)

                                ForEach(serverHistory, id: \.self) { url in
                                    HStack(spacing: 10) {
                                        Image(systemName: "clock.arrow.circlepath")
                                            .foregroundColor(.secondary)
                                            .frame(width: 20)
                                        Text(url)
                                            .font(.system(.subheadline, design: .monospaced))
                                            .foregroundColor(.primary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        Spacer()
                                    }
                                    .padding(.leading, 10)
                                    .padding(.vertical, 6)
                                    .background(Color(.systemGray6))
                                    .cornerRadius(8)
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        auth.setServerURL(url)
                                        selectedServer = nil
                                        isChangingServer = false
                                        checkServerReachability()
                                    }
                                }
                            }
                        }

                        // Manual input toggle
                        Button {
                            showManualInput.toggle()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: showManualInput ? "chevron.up" : "keyboard")
                                Text(showManualInput ? "Hide manual input" : "Enter address manually")
                                    .font(.footnote)
                            }
                            .foregroundColor(.accentColor)
                        }
                        .padding(.top, 4)

                        if showManualInput {
                            HStack(spacing: 0) {
                                Image(systemName: "link")
                                    .foregroundColor(.secondary)
                                    .frame(width: 30)
                                TextField("http://192.168.1.x:4200", text: $manualURL)
                                    .autocapitalization(.none)
                                    .disableAutocorrection(true)
                                if !manualURL.isEmpty {
                                    Button {
                                        auth.setServerURL(manualURL)
                                        selectedServer = nil
                                        isChangingServer = false
                                        checkServerReachability()
                                    } label: {
                                        Text("Use")
                                            .fontWeight(.medium)
                                            .foregroundColor(.accentColor)
                                    }
                                    .padding(.trailing, 4)
                                }
                            }
                            .padding(10)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                        }
                    }
                }
                .frame(maxWidth: 360)
                .padding(.bottom, 28)

                // Divider
                Rectangle()
                    .fill(Color(.separator))
                    .frame(height: 0.5)
                    .frame(maxWidth: 360)
                    .padding(.bottom, 28)

                // === Token Section ===
                VStack(alignment: .leading, spacing: 12) {
                    Label("Access Token", systemImage: "key")
                        .font(.headline)
                        .foregroundColor(.primary)

                    HStack(spacing: 0) {
                        Group {
                            if showToken {
                                TextField("Paste your token", text: $token)
                            } else {
                                SecureField("Paste your token", text: $token)
                            }
                        }
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                        Button {
                            showToken.toggle()
                        } label: {
                            Image(systemName: showToken ? "eye.slash" : "eye")
                                .foregroundColor(.secondary)
                                .frame(width: 32)
                        }
                        .buttonStyle(.plain)

                        Button {
                            #if canImport(UIKit)
                            if let clipboardString = UIPasteboard.general.string {
                                token = clipboardString.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                            #elseif canImport(AppKit)
                            if let clipboardString = NSPasteboard.general.string(forType: .string) {
                                token = clipboardString.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                            #endif
                        } label: {
                            Image(systemName: "doc.on.clipboard")
                                .foregroundColor(.accentColor)
                                .frame(width: 32)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(12)
                    .background(Color(.systemGray6))
                    .cornerRadius(10)

                    // QR Code scan button
                    #if canImport(UIKit) && !os(macOS)
                    Button {
                        showQRScanner = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.body)
                            Text("Scan QR Code")
                                .fontWeight(.medium)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                    .sheet(isPresented: $showQRScanner) {
                        QRScannerView { scannedCode in
                            handleQRCode(scannedCode)
                        }
                    }
                    #endif
                }
                .frame(maxWidth: 360)

                // Error message
                if let errorMsg = errorMsg {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(errorMsg)
                            .font(.footnote)
                    }
                    .foregroundColor(.red)
                    .padding(.top, 12)
                    .frame(maxWidth: 360)
                }

                // Login button
                Button(action: login) {
                    Group {
                        if isLoading {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        } else {
                            Text("Log In")
                                .fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 22)
                }
                .frame(maxWidth: 360)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(isLoginDisabled ? Color.accentColor.opacity(0.4) : Color.accentColor)
                )
                .foregroundColor(.white)
                .disabled(isLoginDisabled)
                .padding(.top, 24)

                Spacer().frame(height: 60)
            }
            .padding(.horizontal, 24)
        }
        .onAppear {
            if let savedToken = auth.getToken(), !savedToken.isEmpty {
                token = savedToken
            }
            if cachedServerURL != nil && cachedServerURL != "" {
                checkServerReachability()
            }
        }
        .onChange(of: scanner.isScanning) {
            if !scanner.isScanning && !scanner.discoveredServers.isEmpty {
                // Auto-select the first discovered server
                selectServer(scanner.discoveredServers[0])
            }
        }
    }

    private var serverHistory: [String] {
        let history = auth.getServerHistory()
        let current = cachedServerURL ?? ""
        return history.filter { $0 != current }
    }

    private var hasServerConfigured: Bool {
        if selectedServer != nil { return true }
        if let cached = cachedServerURL, !cached.isEmpty { return true }
        return false
    }

    private var isLoginDisabled: Bool {
        isLoading || token.isEmpty || !hasServerConfigured
    }

    private func selectServer(_ server: DiscoveredServer) {
        selectedServer = server
        auth.setServerURL(server.url)
        isChangingServer = false
        serverReachable = true
    }

    private func startScan() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
        guard let portNum = Int(port), portNum > 0, portNum <= 65535 else { return }
        scanner.scan(port: portNum)
    }

    private func checkServerReachability() {
        guard let serverURL = cachedServerURL, !serverURL.isEmpty else { return }
        guard let url = URL(string: "\(serverURL)/api/discovery") else {
            serverReachable = false
            return
        }

        isCheckingServer = true
        serverReachable = nil

        var request = URLRequest(url: url)
        request.timeoutInterval = 3

        Task {
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    serverReachable = true
                } else {
                    serverReachable = false
                }
            } catch {
                serverReachable = false
            }
            isCheckingServer = false
        }
    }

    private func handleQRCode(_ code: String) {
        // Parse codecrab://login?server=http://IP:PORT&token=TOKEN
        guard let url = URL(string: code),
              url.scheme == "codecrab",
              url.host == "login" || url.host() == "login",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            errorMsg = "Invalid QR code. Please scan the QR code shown in the server terminal."
            return
        }

        let serverURL = queryItems.first(where: { $0.name == "server" })?.value
        let scannedToken = queryItems.first(where: { $0.name == "token" })?.value

        if let serverURL, !serverURL.isEmpty {
            auth.setServerURL(serverURL)
            selectedServer = nil
            isChangingServer = false
            serverReachable = nil
            checkServerReachability()
        }

        if let scannedToken, !scannedToken.isEmpty {
            token = scannedToken
        }

        // Auto-login if both server and token were provided
        if serverURL != nil && scannedToken != nil {
            login()
        }
    }

    private func login() {
        isLoading = true
        errorMsg = nil

        Task {
            do {
                let success = try await auth.verifyToken(token)
                if !success {
                    errorMsg = "Invalid token. Please check and try again."
                }
            } catch {
                errorMsg = error.localizedDescription
            }
            isLoading = false
        }
    }
}
