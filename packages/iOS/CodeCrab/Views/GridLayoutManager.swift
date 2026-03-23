import SwiftUI
import Combine

// MARK: - Grid Layout

enum GridLayout: String, CaseIterable, Identifiable {
    case single = "1×1"
    case twoColumns = "1×2"
    case threeColumns = "1×3"
    case twoRows = "2×1"
    case twoByTwo = "2×2"

    var id: String { rawValue }

    var rows: Int {
        switch self {
        case .single, .twoColumns, .threeColumns: return 1
        case .twoRows, .twoByTwo: return 2
        }
    }

    var cols: Int {
        switch self {
        case .single, .twoRows: return 1
        case .twoColumns, .twoByTwo: return 2
        case .threeColumns: return 3
        }
    }

    var cellCount: Int { rows * cols }

    var icon: String {
        switch self {
        case .single: return "square"
        case .twoColumns: return "rectangle.split.1x2"
        case .threeColumns: return "rectangle.split.3x1"
        case .twoRows: return "rectangle.split.2x1"
        case .twoByTwo: return "rectangle.split.2x2"
        }
    }
}

// MARK: - Cell State

/// Content that a grid cell displays
enum CellContent: Equatable {
    case empty
    case soul
    case cron
    case projectSessions(Project)
    case chat(ChatRoute)

    static func == (lhs: CellContent, rhs: CellContent) -> Bool {
        switch (lhs, rhs) {
        case (.empty, .empty): return true
        case (.soul, .soul): return true
        case (.cron, .cron): return true
        case (.projectSessions(let a), .projectSessions(let b)): return a.id == b.id
        case (.chat(let a), .chat(let b)): return a.project.id == b.project.id && a.sessionId == b.sessionId
        default: return false
        }
    }

    /// Convert from DetailDestination
    static func from(_ dest: DetailDestination) -> CellContent {
        switch dest {
        case .soul: return .soul
        case .cron: return .cron
        case .project(let p): return .projectSessions(p)
        }
    }

    /// Label for display
    var label: String {
        switch self {
        case .empty: return "Empty"
        case .soul: return "Soul"
        case .cron: return "Tasks"
        case .projectSessions(let p): return "\(p.icon) \(p.name)"
        case .chat(let r): return "\(r.project.icon) \(r.project.name)"
        }
    }
}

struct GridCellState: Identifiable {
    let id: Int
    var content: CellContent = .empty
}

// MARK: - Layout Manager

@MainActor
class GridLayoutManager: ObservableObject {
    @Published var layout: GridLayout = .single
    @Published var cells: [GridCellState] = [GridCellState(id: 0)]
    @Published var activeCellIndex: Int = 0
    @Published var expandedCellIndex: Int? = nil

    var isExpanded: Bool { expandedCellIndex != nil }

    var activeCell: GridCellState {
        guard activeCellIndex < cells.count else { return cells[0] }
        return cells[activeCellIndex]
    }

    var isSingleLayout: Bool {
        layout == .single
    }

    func setLayout(_ newLayout: GridLayout) {
        let oldCount = cells.count
        let newCount = newLayout.cellCount
        layout = newLayout

        if newCount > oldCount {
            for i in oldCount..<newCount {
                cells.append(GridCellState(id: i))
            }
        } else if newCount < oldCount {
            cells = Array(cells.prefix(newCount))
        }

        if activeCellIndex >= newCount {
            activeCellIndex = 0
        }
    }

    func activateCell(at index: Int) {
        guard index >= 0 && index < cells.count else { return }
        activeCellIndex = index
    }

    func setContent(_ content: CellContent, forCell index: Int) {
        guard index >= 0 && index < cells.count else { return }
        cells[index].content = content
    }

    func setContentForActiveCell(_ content: CellContent) {
        setContent(content, forCell: activeCellIndex)
    }

    func closeCell(at index: Int) {
        guard index >= 0 && index < cells.count else { return }
        cells[index].content = .empty
        // If closing the active cell, keep it active but empty
    }

    func navigateToChat(_ route: ChatRoute, inCell index: Int) {
        guard index >= 0 && index < cells.count else { return }
        cells[index].content = .chat(route)
    }

    func navigateBack(inCell index: Int) {
        guard index >= 0 && index < cells.count else { return }
        let cell = cells[index]
        // If in chat, go back to project sessions
        if case .chat(let route) = cell.content {
            cells[index].content = .projectSessions(route.project)
        }
    }

    func expandCell(at index: Int) {
        guard index >= 0 && index < cells.count else { return }
        expandedCellIndex = index
        activeCellIndex = index
    }

    func collapseCell() {
        expandedCellIndex = nil
    }
}
