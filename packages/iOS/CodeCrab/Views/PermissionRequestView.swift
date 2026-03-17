import SwiftUI

struct PermissionRequestView: View {
    let permission: PendingPermission
    let onAllow: () -> Void
    let onDeny: () -> Void
    
    @State private var expandInput = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.orange)
                Text("Permission Request")
                    .font(.headline)
            }
            
            HStack {
                Text("Tool:")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text(permission.toolName)
                    .fontDesign(.monospaced)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.2))
                    .cornerRadius(4)
            }
            
            Text(permission.reason)
                .font(.body)
            
            DisclosureGroup("Input Details", isExpanded: $expandInput) {
                ScrollView {
                    Text(jsonString(from: permission.input))
                        .fontDesign(.monospaced)
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 150)
                .padding(8)
                .background(Color(UIColor.tertiarySystemBackground))
                .cornerRadius(8)
            }
            
            HStack(spacing: 16) {
                Button(action: onDeny) {
                    Text("Deny")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.red)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                
                Button(action: onAllow) {
                    Text("Allow")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.green)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
            }
        }
        .padding()
        .background(Color(UIColor.secondarySystemBackground).overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.orange, lineWidth: 2)))
        .cornerRadius(12)
    }
    
    private func jsonString(from val: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        if let data = try? encoder.encode(val), let str = String(data: data, encoding: .utf8) {
            return str
        }
        return "{}"
    }
}
