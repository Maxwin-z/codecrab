import SwiftUI

// MARK: - Inline SDK Event View

struct SdkEventInlineView: View {
    let event: SdkEvent
    @State private var contentExpanded = true

    /// Whether this event carries full content (text, thinking, tool input/result)
    private var hasFullContent: Bool {
        guard let data = event.data else { return false }
        switch event.type {
        case "text", "thinking":
            if case .string(let c) = data["content"], !c.isEmpty { return true }
            return false
        case "tool_use":
            if case .string(let c) = data["input"], !c.isEmpty { return true }
            return false
        case "tool_result":
            if case .string(let c) = data["content"], !c.isEmpty { return true }
            return false
        default:
            return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Main header line: icon + type + inline info
            HStack(spacing: 0) {
                Text(iconForType)
                    .font(.system(size: 10))
                    .frame(width: 18)

                Text(event.type)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(colorForType)

                if let info = inlineInfo {
                    Text("  \(info)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 4)

                // Expand/collapse toggle for content events
                if hasFullContent {
                    Button(action: { withAnimation(.easeInOut(duration: 0.15)) { contentExpanded.toggle() } }) {
                        Image(systemName: contentExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(PlainButtonStyle())
                }
            }

            // Metadata detail lines (init, usage, tokens, etc.)
            if let lines = metadataLines {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 0) {
                        Color.clear.frame(width: 18)
                        Text(line)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                            .truncationMode(.tail)
                    }
                }
            }

            // Full content block (collapsible)
            if contentExpanded, let content = fullContent {
                Text(content)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(contentColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                    .padding(.leading, 18)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(bgForType)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    // MARK: - Full content body

    private var fullContent: String? {
        guard let data = event.data else { return nil }
        switch event.type {
        case "text":
            if case .string(let c) = data["content"], !c.isEmpty { return c }
        case "thinking":
            if case .string(let c) = data["content"], !c.isEmpty { return c }
        case "tool_use":
            if case .string(let c) = data["input"], !c.isEmpty { return c }
        case "tool_result":
            if case .string(let c) = data["content"], !c.isEmpty { return c }
        default:
            break
        }
        return nil
    }

    private var contentColor: Color {
        switch event.type {
        case "thinking":   return .sdkThinking
        case "text":       return .primary
        case "tool_use":   return .secondary
        case "tool_result":
            if let data = event.data, case .bool(let isErr) = data["isError"], isErr {
                return .sdkError
            }
            return .secondary
        default:           return .secondary
        }
    }

    // MARK: - Icon per type

    private var iconForType: String {
        switch event.type {
        case "query_start":            return "▶"
        case "sdk_init", "sdk_spawn":  return "⚡"
        case "thinking":               return "💭"
        case "text":                   return "📝"
        case "tool_use":               return "🔧"
        case "tool_result":            return "◀"
        case "result":                 return "✅"
        case "error":                  return "❌"
        case "permission_request":     return "🔐"
        case "usage":                  return "📊"
        case "message_start":          return "▶"
        case "message_done":           return "■"
        case "content_block_start":    return "▷"
        case "content_block_stop":     return "◁"
        case "rate_limit":             return "⏱"
        case "assistant":              return "◀"
        default:                       return "·"
        }
    }

    // MARK: - Color per type

    private var colorForType: Color {
        switch event.type {
        case "query_start":            return .sdkQueryStart
        case "sdk_init", "sdk_spawn":  return .sdkInit
        case "thinking":               return .sdkThinking
        case "tool_use":               return .sdkToolUse
        case "tool_result":            return .sdkToolResult
        case "text":                   return .sdkText
        case "result":                 return .sdkResult
        case "error":                  return .sdkError
        case "permission_request":     return .sdkPermission
        case "usage":                  return .sdkUsage
        case "message_start":          return .sdkQueryStart
        case "message_done":           return .sdkQueryStart
        case "content_block_start":    return .sdkToolUse
        case "content_block_stop":     return .sdkToolResult
        case "rate_limit":             return .sdkPermission
        case "assistant":              return .sdkInit
        default:                       return .secondary
        }
    }

    // MARK: - Background per type

    private var bgForType: Color {
        switch event.type {
        case "error":      return Color.sdkError.opacity(0.08)
        case "result":     return Color.sdkResult.opacity(0.06)
        case "sdk_init":   return Color.sdkInit.opacity(0.06)
        case "rate_limit": return Color.sdkPermission.opacity(0.06)
        case "text":       return Color.sdkText.opacity(0.04)
        case "thinking":   return Color.sdkThinking.opacity(0.04)
        default:           return Color.sdkTimelineBg.opacity(0.5)
        }
    }

    // MARK: - Inline info (shown on the same line as type label)

    private var inlineInfo: String? {
        guard let data = event.data else { return event.detail }

        switch event.type {
        case "query_start":
            return event.detail.map { String($0.prefix(80)) }

        case "sdk_init":
            if case .string(let model) = data["model"] { return model }
            return nil

        case "tool_use":
            if case .string(let name) = data["toolName"] {
                if case .string(let tid) = data["toolId"] {
                    return "\(name)  id=\(String(tid.suffix(8)))"
                }
                return name
            }
            return event.detail

        case "tool_result":
            // Show error flag + length
            var parts: [String] = []
            if case .bool(let isErr) = data["isError"], isErr { parts.append("ERROR") }
            if case .string(let tid) = data["toolUseId"] { parts.append("tool_use_id=\(String(tid.suffix(8)))") }
            if case .number(let len) = data["length"] { parts.append("\(Int(len)) chars") }
            return parts.isEmpty ? nil : parts.joined(separator: "  ")

        case "text":
            if case .number(let len) = data["length"] { return "\(Int(len)) chars" }
            return nil

        case "thinking":
            if case .number(let len) = data["length"] { return "\(Int(len)) chars" }
            return nil

        case "result":
            var parts: [String] = []
            if case .string(let sub) = data["subtype"] { parts.append(sub) }
            if case .number(let cost) = data["costUsd"] { parts.append("$\(String(format: "%.4f", cost))") }
            if case .number(let dur) = data["durationMs"] { parts.append("\(String(format: "%.1f", dur / 1000))s") }
            if case .bool(let isErr) = data["isError"], isErr { parts.append("ERROR") }
            return parts.isEmpty ? event.detail : parts.joined(separator: " · ")

        case "message_start":
            var parts: [String] = []
            if case .string(let mid) = data["messageId"] { parts.append("id=\(String(mid.suffix(12)))") }
            if case .string(let model) = data["model"] { parts.append("model=\(model)") }
            return parts.isEmpty ? event.detail : parts.joined(separator: "  ")

        case "message_done":
            var parts: [String] = []
            if case .string(let stop) = data["stopReason"] { parts.append("stop=\(stop)") }
            if case .number(let out) = data["outputTokens"] { parts.append("out_tokens=\(Int(out))") }
            if case .number(let edits) = data["contextEdits"], edits > 0 { parts.append("context_edits=\(Int(edits))") }
            return parts.isEmpty ? event.detail : parts.joined(separator: "  ")

        case "content_block_start":
            if case .string(let bt) = data["blockType"] {
                if bt == "tool_use", case .string(let name) = data["toolName"] {
                    var s = "tool_use: \(name)"
                    if case .string(let tid) = data["toolId"] { s += "  id=\(String(tid.suffix(8)))" }
                    if case .string(let caller) = data["caller"] { s += "  caller=\(caller)" }
                    return s
                }
                return bt
            }
            return event.detail

        case "content_block_stop":
            return event.detail

        case "rate_limit":
            var parts: [String] = []
            if case .string(let status) = data["status"] {
                parts.append(status == "allowed" ? "✓ allowed" : "✗ \(status)")
            }
            if case .string(let rlt) = data["rateLimitType"] { parts.append("type=\(rlt)") }
            if case .number(let resets) = data["resetsAt"] {
                let date = Date(timeIntervalSince1970: resets)
                let fmt = DateFormatter()
                fmt.dateFormat = "HH:mm:ss"
                parts.append("resets=\(fmt.string(from: date))")
            }
            if case .bool(let overage) = data["isUsingOverage"], overage { parts.append("overage=on") }
            return parts.isEmpty ? event.detail : parts.joined(separator: "  ")

        case "assistant":
            if case .string(let blocks) = data["blocks"] { return blocks }
            return event.detail

        case "error":
            return event.detail

        case "permission_request":
            return event.detail

        default:
            return event.detail
        }
    }

    // MARK: - Metadata lines (shown below header, for init/usage/tokens)

    private var metadataLines: [String]? {
        guard let data = event.data else { return nil }

        switch event.type {
        case "sdk_init":
            var lines: [String] = []
            if case .string(let session) = data["session"] { lines.append("session:    \(session)") }
            if case .string(let perm) = data["permission"] { lines.append("permission: \(perm)") }
            if case .number(let tc) = data["toolCount"] {
                var toolLine = "tools (\(Int(tc))):"
                if case .string(let tools) = data["tools"] { toolLine += " \(tools)" }
                lines.append(toolLine)
            }
            if case .string(let mcps) = data["mcps"], !mcps.isEmpty { lines.append("mcps:       \(mcps)") }
            if case .string(let skills) = data["skills"], !skills.isEmpty { lines.append("skills:     \(skills)") }
            if case .string(let agents) = data["agents"], !agents.isEmpty { lines.append("agents:     \(agents)") }
            if case .string(let plugins) = data["plugins"], !plugins.isEmpty { lines.append("plugins:    \(plugins)") }
            if case .string(let version) = data["version"] { lines.append("version:    \(version)") }
            return lines.isEmpty ? nil : lines

        case "message_start":
            var parts: [String] = []
            if case .number(let i) = data["inputTokens"] { parts.append("in=\(Int(i))") }
            if case .number(let o) = data["outputTokens"] { parts.append("out=\(Int(o))") }
            if case .number(let cr) = data["cacheReadTokens"] { parts.append("cache_read=\(Int(cr))") }
            if case .number(let cc) = data["cacheCreateTokens"] { parts.append("cache_create=\(Int(cc))") }
            guard !parts.isEmpty else { return nil }
            var lines = ["tokens: \(parts.joined(separator: "  "))"]
            if case .string(let tier) = data["serviceTier"] { lines.append("tier=\(tier)") }
            return lines

        case "usage":
            var parts: [String] = []
            if case .number(let i) = data["inputTokens"] { parts.append("in:\(Int(i))") }
            if case .number(let o) = data["outputTokens"] { parts.append("out:\(Int(o))") }
            if case .number(let cr) = data["cacheReadTokens"], cr > 0 { parts.append("cache_read:\(Int(cr))") }
            if case .number(let cc) = data["cacheCreationTokens"], cc > 0 { parts.append("cache_create:\(Int(cc))") }
            return parts.isEmpty ? nil : [parts.joined(separator: "  ")]

        case "assistant":
            var parts: [String] = []
            if case .number(let i) = data["inputTokens"] { parts.append("in=\(Int(i))") }
            if case .number(let o) = data["outputTokens"] { parts.append("out=\(Int(o))") }
            if case .number(let cr) = data["cacheReadTokens"] { parts.append("cache_read=\(Int(cr))") }
            if case .number(let cc) = data["cacheCreateTokens"] { parts.append("cache_create=\(Int(cc))") }
            return parts.isEmpty ? nil : ["tokens: \(parts.joined(separator: "  "))"]

        default:
            return nil
        }
    }
}
