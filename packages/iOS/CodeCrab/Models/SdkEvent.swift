import Foundation

struct SdkEvent: Identifiable, Equatable {
    let id: UUID = UUID()
    let ts: Double
    let type: String
    let detail: String?
    let data: [String: JSONValue]?

    static func == (lhs: SdkEvent, rhs: SdkEvent) -> Bool {
        lhs.id == rhs.id
    }
}
