import SwiftUI

#if canImport(UIKit) && !os(macOS)
import UIKit
import AVFoundation

struct QRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    let onScanned: (String) -> Void

    @State private var isTorchOn = false
    @State private var cameraPermissionDenied = false

    var body: some View {
        NavigationStack {
            ZStack {
                if cameraPermissionDenied {
                    VStack(spacing: 16) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary)
                        Text("Camera Access Required")
                            .font(.headline)
                        Text("Please enable camera access in Settings to scan QR codes.")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 40)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    QRCameraPreview(onScanned: { code in
                        onScanned(code)
                        dismiss()
                    }, isTorchOn: $isTorchOn)
                    .ignoresSafeArea()

                    // Scan overlay
                    VStack {
                        Spacer()

                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.white.opacity(0.8), lineWidth: 3)
                            .frame(width: 250, height: 250)
                            .background(Color.clear)

                        Spacer()

                        Text("Point camera at QR code")
                            .font(.subheadline)
                            .foregroundColor(.white)
                            .padding(12)
                            .background(.ultraThinMaterial)
                            .cornerRadius(8)
                            .padding(.bottom, 40)
                    }
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if !cameraPermissionDenied {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            isTorchOn.toggle()
                        } label: {
                            Image(systemName: isTorchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                        }
                    }
                }
            }
            .onAppear {
                checkCameraPermission()
            }
        }
    }

    private func checkCameraPermission() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraPermissionDenied = false
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    cameraPermissionDenied = !granted
                }
            }
        default:
            cameraPermissionDenied = true
        }
    }
}

// MARK: - Camera Preview UIViewRepresentable

private struct QRCameraPreview: UIViewRepresentable {
    let onScanned: (String) -> Void
    @Binding var isTorchOn: Bool

    func makeUIView(context: Context) -> QRCameraUIView {
        let view = QRCameraUIView(onScanned: onScanned)
        return view
    }

    func updateUIView(_ uiView: QRCameraUIView, context: Context) {
        uiView.setTorch(on: isTorchOn)
    }
}

private class QRCameraUIView: UIView {
    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let onScanned: (String) -> Void
    private var hasScanned = false
    private let metadataDelegate: MetadataDelegate

    init(onScanned: @escaping (String) -> Void) {
        self.onScanned = onScanned
        self.metadataDelegate = MetadataDelegate()
        super.init(frame: .zero)
        metadataDelegate.onScanned = { [weak self] code in
            guard let self, !self.hasScanned else { return }
            self.hasScanned = true
            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)
            self.onScanned(code)
        }
        setupCamera()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }

        if captureSession.canAddInput(input) {
            captureSession.addInput(input)
        }

        let output = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(output) {
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(metadataDelegate, queue: .main)
            output.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.videoGravity = .resizeAspectFill
        self.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    func setTorch(on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video),
              device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
    }

    deinit {
        captureSession.stopRunning()
    }
}

private class MetadataDelegate: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        onScanned?(value)
    }
}

#endif
