import SwiftUI
import PhotosUI

struct InputBarView: View {
    let onSend: (String, [ImageAttachment]?) -> Void
    let onAbort: () -> Void
    let onPermissionModeChange: (String) -> Void
    let isRunning: Bool
    let isAborting: Bool
    let currentModel: String
    let permissionMode: String
    
    @State private var text: String = ""
    @State private var attachments: [ImageAttachment] = []
    @State private var selectedItem: PhotosPickerItem? = nil
    
    var body: some View {
        VStack(spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(attachments.indices, id: \.self) { idx in
                            if let data = Data(base64Encoded: attachments[idx].data),
                               let uiImage = UIImage(data: data) {
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 64, height: 64)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    
                                    Button(action: { attachments.remove(at: idx) }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(.red)
                                            .background(Color.white.clipShape(Circle()))
                                    }
                                    .padding(-4)
                                }
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            }
            
            HStack(alignment: .bottom) {
                PhotosPicker(selection: $selectedItem, matching: .images) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 20))
                        .foregroundColor(.secondary)
                        .padding(.bottom, 8)
                }
                .onChange(of: selectedItem) { newItem in
                    Task {
                        if let data = try? await newItem?.loadTransferable(type: Data.self),
                           let image = UIImage(data: data),
                           let attachment = ImageCompressor.compressImage(image) {
                            attachments.append(attachment)
                        }
                    }
                }
                
                TextField(isRunning ? "Running..." : "Message...", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(10)
                    .background(Color(UIColor.secondarySystemBackground))
                    .cornerRadius(16)
                    .disabled(isRunning)
                
                if isRunning {
                    Button(action: onAbort) {
                        if isAborting {
                            ProgressView()
                                .frame(width: 36, height: 36)
                        } else {
                            Image(systemName: "stop.fill")
                                .frame(width: 36, height: 36)
                                .background(Color.red)
                                .foregroundColor(.white)
                                .clipShape(Circle())
                        }
                    }
                } else {
                    Button(action: {
                        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !msg.isEmpty || !attachments.isEmpty {
                            onSend(msg, attachments.isEmpty ? nil : attachments)
                            text = ""
                            attachments.removeAll()
                        }
                    }) {
                        Image(systemName: "arrow.up")
                            .frame(width: 36, height: 36)
                            .background(text.isEmpty && attachments.isEmpty ? Color.gray : Color.blue)
                            .foregroundColor(.white)
                            .clipShape(Circle())
                    }
                    .disabled(text.isEmpty && attachments.isEmpty)
                }
            }
            
            HStack {
                Text(currentModel)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Spacer()
                Button(action: {
                    onPermissionModeChange(permissionMode == "default" ? "bypassPermissions" : "default")
                }) {
                    Text(permissionMode == "default" ? "Safe" : "YOLO")
                        .font(.caption2).bold()
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(permissionMode == "default" ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                        .foregroundColor(permissionMode == "default" ? .green : .orange)
                        .cornerRadius(8)
                }
            }
        }
        .padding(8)
        .background(Color(UIColor.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.1), radius: 5, x: 0, y: -2)
    }
}
