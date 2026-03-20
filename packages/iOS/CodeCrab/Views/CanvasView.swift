import SwiftUI
import PencilKit

struct CanvasView: View {
    let onDone: (UIImage) -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var canvasView = PKCanvasView()
    @State private var toolPicker = PKToolPicker()
    @State private var hasStrokes = false

    var body: some View {
        NavigationStack {
            CanvasRepresentable(canvasView: $canvasView, toolPicker: $toolPicker, hasStrokes: $hasStrokes, colorScheme: colorScheme)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Canvas")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { onCancel() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { exportAndDone() }
                            .fontWeight(.semibold)
                            .disabled(!hasStrokes)
                    }
                    ToolbarItem(placement: .secondaryAction) {
                        Button {
                            canvasView.drawing = PKDrawing()
                            hasStrokes = false
                        } label: {
                            Label("Clear", systemImage: "trash")
                        }
                        .disabled(!hasStrokes)
                    }
                }
        }
    }

    private func exportAndDone() {
        let drawing = canvasView.drawing
        guard !drawing.strokes.isEmpty else { return }

        let bounds = drawing.bounds
        let padding: CGFloat = 20
        let exportRect = bounds.insetBy(dx: -padding, dy: -padding)
        let scale = UIScreen.main.scale

        // Render with background color matching the current theme
        let renderer = UIGraphicsImageRenderer(size: CGSize(
            width: exportRect.width * scale,
            height: exportRect.height * scale
        ))
        let image = renderer.image { ctx in
            let bgColor: UIColor = colorScheme == .dark ? .black : .white
            bgColor.setFill()
            ctx.fill(CGRect(origin: .zero, size: renderer.format.bounds.size))
            let drawingImage = drawing.image(from: exportRect, scale: scale)
            drawingImage.draw(in: CGRect(origin: .zero, size: renderer.format.bounds.size))
        }
        onDone(image)
    }
}

private struct CanvasRepresentable: UIViewRepresentable {
    @Binding var canvasView: PKCanvasView
    @Binding var toolPicker: PKToolPicker
    @Binding var hasStrokes: Bool
    var colorScheme: ColorScheme

    func makeCoordinator() -> Coordinator {
        Coordinator(hasStrokes: $hasStrokes)
    }

    func makeUIView(context: Context) -> PKCanvasView {
        let isDark = colorScheme == .dark
        canvasView.backgroundColor = isDark ? .black : .white
        canvasView.isOpaque = true
        canvasView.drawingPolicy = .anyInput
        canvasView.overrideUserInterfaceStyle = isDark ? .dark : .light
        canvasView.tool = PKInkingTool(.pen, color: isDark ? .white : .black, width: 3)
        canvasView.delegate = context.coordinator

        toolPicker.setVisible(true, forFirstResponder: canvasView)
        toolPicker.addObserver(canvasView)
        toolPicker.colorUserInterfaceStyle = isDark ? .dark : .light
        canvasView.becomeFirstResponder()

        return canvasView
    }

    func updateUIView(_ uiView: PKCanvasView, context: Context) {
        let isDark = colorScheme == .dark
        uiView.backgroundColor = isDark ? .black : .white
        uiView.overrideUserInterfaceStyle = isDark ? .dark : .light
        toolPicker.colorUserInterfaceStyle = isDark ? .dark : .light
    }

    class Coordinator: NSObject, PKCanvasViewDelegate {
        @Binding var hasStrokes: Bool

        init(hasStrokes: Binding<Bool>) {
            _hasStrokes = hasStrokes
        }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            hasStrokes = !canvasView.drawing.strokes.isEmpty
        }
    }
}
