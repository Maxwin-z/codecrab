import SwiftUI

struct UserQuestionFormView: View {
    let toolId: String
    let questions: [Question]
    let onSubmit: ([String: Any]) -> Void
    let onCancel: () -> Void
    
    @State private var activeTab: Int = 0
    @State private var answers: [String: [String]] = [:]
    @State private var customTexts: [String: String] = [:]
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundColor(.blue)
                Text("Questions from Assistant")
                    .font(.headline)
            }
            
            if questions.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(0..<questions.count, id: \.self) { idx in
                            Button(action: { activeTab = idx }) {
                                HStack {
                                    if isAnswered(at: idx) {
                                        Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                                    }
                                    Text("Q\(idx + 1)")
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(activeTab == idx ? Color.blue.opacity(0.2) : Color(UIColor.tertiarySystemBackground))
                                .cornerRadius(16)
                            }
                            .foregroundColor(activeTab == idx ? .blue : .primary)
                        }
                    }
                }
            }
            
            if questions.indices.contains(activeTab) {
                let q = questions[activeTab]
                let key = String(activeTab + 1)
                
                VStack(alignment: .leading, spacing: 12) {
                    if let header = q.header {
                        Text(header.uppercased())
                            .font(.caption2).bold()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.blue.opacity(0.2))
                            .foregroundColor(.blue)
                            .cornerRadius(4)
                    }
                    
                    Text(q.question)
                        .font(.body).bold()
                    
                    if let options = q.options, !options.isEmpty {
                        ForEach(options, id: \.label) { opt in
                            Button(action: { toggleOption(opt.label, key: key, isMulti: q.multiSelect ?? false) }) {
                                HStack {
                                    Image(systemName: isSelected(opt.label, key: key) ? (q.multiSelect == true ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multiSelect == true ? "square" : "circle"))
                                        .foregroundColor(isSelected(opt.label, key: key) ? .blue : .gray)
                                    VStack(alignment: .leading) {
                                        Text(opt.label).foregroundColor(.primary)
                                        if let desc = opt.description {
                                            Text(desc).font(.caption).foregroundColor(.secondary)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    
                    if q.multiSelect != true {
                        // Radio option for free-text input in single-select mode
                        Button(action: {
                            answers[key] = [] // deselect radio options
                        }) {
                            HStack {
                                Image(systemName: (answers[key] ?? []).isEmpty ? "largecircle.fill.circle" : "circle")
                                    .foregroundColor((answers[key] ?? []).isEmpty ? .blue : .gray)
                                Text("Other (type below)").foregroundColor(.primary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    TextField(q.multiSelect == true ? "Or enter custom option..." : "Type an answer...", text: Binding(
                        get: { customTexts[key] ?? "" },
                        set: { customTexts[key] = $0 }
                    ))
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .disabled(q.multiSelect != true && !(answers[key] ?? []).isEmpty)
                }
            }
            
            HStack {
                Button("Cancel", action: onCancel)
                    .foregroundColor(.red)
                Spacer()
                let unanswered = questions.count - (0..<questions.count).filter { isAnswered(at: $0) }.count
                if unanswered > 0 {
                    Text("\(unanswered) left").font(.caption).foregroundColor(.secondary)
                }
                Button("Submit") {
                    onSubmit(buildFinalAnswers())
                }
                .disabled(!allAnswered)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(allAnswered ? Color.blue : Color.gray)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
        }
        .padding()
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(12)
    }
    
    private func isSelected(_ label: String, key: String) -> Bool {
        return (answers[key] ?? []).contains(label)
    }
    
    private func toggleOption(_ label: String, key: String, isMulti: Bool) {
        var current = answers[key] ?? []
        if isMulti {
            if current.contains(label) {
                current.removeAll { $0 == label }
            } else {
                current.append(label)
            }
        } else {
            current = [label]
            customTexts[key] = "" // clear custom text on single select
        }
        answers[key] = current
    }
    
    private func isAnswered(at index: Int) -> Bool {
        let key = String(index + 1)
        let custom = (customTexts[key] ?? "").trimmingCharacters(in: .whitespaces)
        return !(answers[key] ?? []).isEmpty || !custom.isEmpty
    }
    
    private var allAnswered: Bool {
        !questions.indices.contains { !isAnswered(at: $0) }
    }
    
    private func buildFinalAnswers() -> [String: Any] {
        var result: [String: Any] = [:]
        for (i, q) in questions.enumerated() {
            let key = String(i + 1)
            let custom = (customTexts[key] ?? "").trimmingCharacters(in: .whitespaces)
            if q.multiSelect == true {
                var arr = answers[key] ?? []
                if !custom.isEmpty { arr.append(custom) }
                result[key] = arr
            } else {
                result[key] = (answers[key] ?? []).first ?? custom
            }
        }
        return result
    }
}
