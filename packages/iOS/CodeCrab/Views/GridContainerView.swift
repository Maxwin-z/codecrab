import SwiftUI

/// Container that renders grid cells according to the current layout.
/// Only shown on iPad when layout is not single.
struct GridContainerView: View {
    @ObservedObject var gridManager: GridLayoutManager
    @Binding var shareAttachments: [ImageAttachment]
    @Binding var shareSessionId: String?

    var body: some View {
        let rows = gridManager.layout.rows
        let cols = gridManager.layout.cols

        VStack(spacing: 2) {
            ForEach(0..<rows, id: \.self) { row in
                HStack(spacing: 2) {
                    ForEach(0..<cols, id: \.self) { col in
                        let index = row * cols + col
                        if index < gridManager.cells.count {
                            GridCellView(
                                cellIndex: index,
                                gridManager: gridManager,
                                shareAttachments: $shareAttachments,
                                shareSessionId: $shareSessionId
                            )
                        }
                    }
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
    }
}

// MARK: - Layout Picker

struct GridLayoutPicker: View {
    @ObservedObject var gridManager: GridLayoutManager

    var body: some View {
        Menu {
            ForEach(GridLayout.allCases) { layout in
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        gridManager.setLayout(layout)
                    }
                } label: {
                    HStack {
                        Image(systemName: layout.icon)
                        Text(layout.rawValue)
                        if gridManager.layout == layout {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: gridManager.isSingleLayout ? "rectangle.split.2x2" : "rectangle.split.2x2.fill")
                .font(.system(size: 16))
        }
    }
}
