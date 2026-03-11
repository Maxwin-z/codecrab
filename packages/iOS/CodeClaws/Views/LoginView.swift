import SwiftUI

struct LoginView: View {
    @EnvironmentObject var auth: AuthService
    
    @State private var serverURL: String = "http://192.168.1.35:4200"
    @State private var token: String = "8f871be9c9d0b2df492961876af247d51c29016ccd6b01ba672b835793ed2d66"
    @State private var isLoading: Bool = false
    @State private var errorMsg: String? = nil
    
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            
            Text("Welcome to CodeClaws")
                .font(.largeTitle)
                .fontWeight(.bold)
            
            Text("Enter your access token to continue")
                .foregroundColor(.secondary)
            
            if auth.getServerURL() == nil {
                TextField("Server URL (e.g. http://192.168.1.10:4200)", text: $serverURL)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }
            
            SecureField("Access Token", text: $token)
                .textFieldStyle(RoundedBorderTextFieldStyle())
            
            if let errorMsg = errorMsg {
                Text(errorMsg)
                    .foregroundColor(.white)
                    .padding()
                    .background(Color.red.cornerRadius(8))
            }
            
            Button(action: login) {
                if isLoading {
                    ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .white))
                } else {
                    Text("Log In")
                }
            }
            .frame(maxWidth: .infinity)
            .padding()
            .background(Color.accentColor)
            .foregroundColor(.white)
            .cornerRadius(8)
            .disabled(isLoading || token.isEmpty || (auth.getServerURL() == nil && serverURL.isEmpty))
            
            Spacer()
        }
        .padding()
        .onAppear {
            let existing = auth.getServerURL()
            print("[LoginView] onAppear, existing server URL: \(existing ?? "nil")")
            if existing == nil || existing == "" {
                 auth.setServerURL(serverURL)
            } else {
                 serverURL = existing!
            }
        }
    }
    
    private func login() {
        print("[LoginView] Login button pressed")
        if auth.getServerURL() == nil && !serverURL.isEmpty {
            print("[LoginView] Setting server URL: \(serverURL)")
            auth.setServerURL(serverURL)
        }
        
        isLoading = true
        errorMsg = nil
        
        Task {
            do {
                print("[LoginView] Calling verifyToken...")
                let success = try await auth.verifyToken(token)
                print("[LoginView] verifyToken result: \(success)")
                if !success {
                    errorMsg = "Invalid token. Please check and try again."
                }
            } catch {
                print("[LoginView] verifyToken error: \(error.localizedDescription)")
                errorMsg = error.localizedDescription
            }
            isLoading = false
            print("[LoginView] isLoading set to false")
        }
    }
}
