import ActivityKit
import Foundation

class LiveActivityService {
    static let shared = LiveActivityService()

    private var currentActivity: Activity<CodeCrabActivityAttributes>?
    private var lastUpdateTime: Date = .distantPast
    private var pendingUpdateTask: Task<Void, Never>?
    private var pendingState: CodeCrabActivityAttributes.ContentState?
    private let throttleInterval: TimeInterval = 1.5
    /// Track last activity type to detect state transitions
    private var lastActivityType: String?

    nonisolated private init() {}

    /// Whether a Live Activity is currently running
    var isActive: Bool { currentActivity != nil }

    func startActivity(projectName: String, projectIcon: String) {
        endActivity()

        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let attributes = CodeCrabActivityAttributes(
            projectName: projectName,
            projectIcon: projectIcon
        )
        let initialState = CodeCrabActivityAttributes.ContentState(
            activityType: "working",
            elapsedSeconds: 0
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: initialState, staleDate: Date().addingTimeInterval(15)),
                pushType: nil
            )
            currentActivity = activity
            lastUpdateTime = Date()
            lastActivityType = "working"
        } catch {
            print("[LiveActivity] Failed to start: \(error)")
        }
    }

    func updateActivity(state: CodeCrabActivityAttributes.ContentState) {
        guard currentActivity != nil else { return }

        let now = Date()
        let elapsed = now.timeIntervalSince(lastUpdateTime)

        // Detect state transitions (e.g., streaming → tool_use) and bypass throttle
        let isStateTransition = state.activityType != lastActivityType

        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        pendingState = state

        if elapsed >= throttleInterval || isStateTransition {
            performUpdate(state: state)
        } else {
            let delay = throttleInterval - elapsed
            pendingUpdateTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self.performUpdate(state: state)
            }
        }
    }

    /// Immediately flush any pending update (e.g., before entering background)
    func flushPendingUpdate() {
        guard let state = pendingState else { return }
        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        pendingState = nil
        performUpdate(state: state)
    }

    func endActivity() {
        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        pendingState = nil
        lastActivityType = nil

        guard let activity = currentActivity else { return }

        let finalState = CodeCrabActivityAttributes.ContentState(
            activityType: "working",
            elapsedSeconds: 0
        )

        Task {
            await activity.end(
                .init(state: finalState, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }

        currentActivity = nil
    }

    /// End all stale activities (e.g. from previous app launches)
    func endAllActivities() {
        Task {
            for activity in Activity<CodeCrabActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        currentActivity = nil
    }

    private func performUpdate(state: CodeCrabActivityAttributes.ContentState) {
        guard let activity = currentActivity else { return }

        Task {
            await activity.update(.init(state: state, staleDate: Date().addingTimeInterval(15)))
        }

        lastUpdateTime = Date()
        lastActivityType = state.activityType
        pendingState = nil
    }
}
