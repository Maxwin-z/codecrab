import UIKit

struct MarkdownPDFExporter {

    static func generatePDF(markdown: String, title: String) -> URL? {
        let html = wrapInHTML(convertToHTML(markdown), title: title)

        let formatter = UIMarkupTextPrintFormatter(markupText: html)
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(formatter, startingAtPageAt: 0)

        let pageSize = CGSize(width: 595.2, height: 841.8) // A4
        let margin: CGFloat = 48
        let printableRect = CGRect(
            x: margin, y: margin,
            width: pageSize.width - 2 * margin,
            height: pageSize.height - 2 * margin
        )
        let paperRect = CGRect(origin: .zero, size: pageSize)

        renderer.setValue(NSValue(cgRect: paperRect), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: printableRect), forKey: "printableRect")

        let pdfData = NSMutableData()
        UIGraphicsBeginPDFContextToData(pdfData, paperRect, nil)
        for i in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(title).pdf")
        do {
            try pdfData.write(to: url)
            return url
        } catch {
            return nil
        }
    }

    // MARK: - HTML Wrapper

    private static func wrapInHTML(_ body: String, title: String) -> String {
        """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <title>\(escapeHTML(title))</title>
        <style>
        body { font-family: -apple-system, Helvetica Neue, sans-serif; font-size: 13px; line-height: 1.7; color: #1a1a1a; }
        h1 { font-size: 22px; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-top: 20px; }
        h2 { font-size: 18px; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; margin-top: 16px; }
        h3 { font-size: 15px; margin-top: 14px; }
        h4, h5, h6 { font-size: 13px; margin-top: 12px; }
        code { background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-family: Menlo, monospace; font-size: 12px; }
        pre { background: #f3f3f3; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
        pre code { background: none; padding: 0; font-size: 11px; }
        blockquote { border-left: 3px solid #d0d0d0; padding-left: 12px; color: #555; margin: 8px 0; }
        table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        th, td { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; font-size: 12px; }
        th { background: #f5f5f5; font-weight: 600; }
        hr { border: none; border-top: 1px solid #e0e0e0; margin: 16px 0; }
        a { color: #0066cc; }
        ul, ol { padding-left: 24px; }
        li { margin: 2px 0; }
        p { margin: 8px 0; }
        </style>
        </head><body>
        \(body)
        </body></html>
        """
    }

    // MARK: - Markdown → HTML Conversion

    private static func convertToHTML(_ markdown: String) -> String {
        let lines = markdown.components(separatedBy: "\n")
        var html = [String]()
        var i = 0
        var inCodeBlock = false
        var codeLines = [String]()
        var inTable = false
        var inList = false
        var listTag = ""

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code blocks
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    html.append("<pre><code>\(escapeHTML(codeLines.joined(separator: "\n")))</code></pre>")
                    codeLines = []
                    inCodeBlock = false
                } else {
                    closeList(&html, &inList, &listTag)
                    closeTable(&html, &inTable)
                    inCodeBlock = true
                }
                i += 1
                continue
            }
            if inCodeBlock {
                codeLines.append(line)
                i += 1
                continue
            }

            // Empty line
            if trimmed.isEmpty {
                closeList(&html, &inList, &listTag)
                closeTable(&html, &inTable)
                i += 1
                continue
            }

            // Headings
            if let match = trimmed.range(of: "^(#{1,6})\\s+", options: .regularExpression) {
                closeList(&html, &inList, &listTag)
                closeTable(&html, &inTable)
                let level = trimmed[match].filter { $0 == "#" }.count
                let text = String(trimmed[match.upperBound...])
                html.append("<h\(level)>\(processInline(text))</h\(level)>")
                i += 1
                continue
            }

            // Horizontal rule
            if !inTable && trimmed.range(of: "^[-*_]{3,}$", options: .regularExpression) != nil {
                closeList(&html, &inList, &listTag)
                html.append("<hr>")
                i += 1
                continue
            }

            // Blockquote
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                closeList(&html, &inList, &listTag)
                closeTable(&html, &inTable)
                let text = trimmed.hasPrefix("> ") ? String(trimmed.dropFirst(2)) : ""
                html.append("<blockquote><p>\(processInline(text))</p></blockquote>")
                i += 1
                continue
            }

            // Table
            if trimmed.contains("|") {
                if !inTable && i + 1 < lines.count {
                    let nextTrimmed = lines[i + 1].trimmingCharacters(in: .whitespaces)
                    if isTableSeparator(nextTrimmed) {
                        closeList(&html, &inList, &listTag)
                        inTable = true
                        let cells = parseTableRow(trimmed)
                        html.append("<table><thead><tr>")
                        for cell in cells { html.append("<th>\(processInline(cell))</th>") }
                        html.append("</tr></thead><tbody>")
                        i += 2
                        continue
                    }
                }
                if inTable {
                    let cells = parseTableRow(trimmed)
                    html.append("<tr>")
                    for cell in cells { html.append("<td>\(processInline(cell))</td>") }
                    html.append("</tr>")
                    i += 1
                    continue
                }
            }

            // Unordered list
            if trimmed.range(of: "^[-*+]\\s+", options: .regularExpression) != nil {
                closeTable(&html, &inTable)
                if !inList || listTag != "ul" {
                    closeList(&html, &inList, &listTag)
                    html.append("<ul>")
                    inList = true
                    listTag = "ul"
                }
                let text = trimmed.replacingOccurrences(of: "^[-*+]\\s+", with: "", options: .regularExpression)
                html.append("<li>\(processInline(text))</li>")
                i += 1
                continue
            }

            // Ordered list
            if trimmed.range(of: "^\\d+\\.\\s+", options: .regularExpression) != nil {
                closeTable(&html, &inTable)
                if !inList || listTag != "ol" {
                    closeList(&html, &inList, &listTag)
                    html.append("<ol>")
                    inList = true
                    listTag = "ol"
                }
                let text = trimmed.replacingOccurrences(of: "^\\d+\\.\\s+", with: "", options: .regularExpression)
                html.append("<li>\(processInline(text))</li>")
                i += 1
                continue
            }

            // Paragraph
            closeList(&html, &inList, &listTag)
            closeTable(&html, &inTable)
            html.append("<p>\(processInline(trimmed))</p>")
            i += 1
        }

        // Close any open blocks
        if inCodeBlock {
            html.append("<pre><code>\(escapeHTML(codeLines.joined(separator: "\n")))</code></pre>")
        }
        closeList(&html, &inList, &listTag)
        closeTable(&html, &inTable)

        return html.joined(separator: "\n")
    }

    // MARK: - Inline Processing

    private static func processInline(_ text: String) -> String {
        var result = escapeHTML(text)
        // Images (before links)
        result = result.replacingOccurrences(
            of: "!\\[([^\\]]*)\\]\\(([^)]+)\\)",
            with: "<img src=\"$2\" alt=\"$1\" style=\"max-width:100%\">",
            options: .regularExpression
        )
        // Links
        result = result.replacingOccurrences(
            of: "\\[([^\\]]+)\\]\\(([^)]+)\\)",
            with: "<a href=\"$2\">$1</a>",
            options: .regularExpression
        )
        // Bold
        result = result.replacingOccurrences(
            of: "\\*\\*(.+?)\\*\\*",
            with: "<strong>$1</strong>",
            options: .regularExpression
        )
        // Italic
        result = result.replacingOccurrences(
            of: "(?<!\\*)\\*(?!\\*)(.+?)(?<!\\*)\\*(?!\\*)",
            with: "<em>$1</em>",
            options: .regularExpression
        )
        // Strikethrough
        result = result.replacingOccurrences(
            of: "~~(.+?)~~",
            with: "<del>$1</del>",
            options: .regularExpression
        )
        // Inline code
        result = result.replacingOccurrences(
            of: "`([^`]+)`",
            with: "<code>$1</code>",
            options: .regularExpression
        )
        return result
    }

    // MARK: - Helpers

    private static func closeList(_ html: inout [String], _ inList: inout Bool, _ listTag: inout String) {
        if inList {
            html.append("</\(listTag)>")
            inList = false
            listTag = ""
        }
    }

    private static func closeTable(_ html: inout [String], _ inTable: inout Bool) {
        if inTable {
            html.append("</tbody></table>")
            inTable = false
        }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cleaned = line.replacingOccurrences(of: "[|\\-:\\s]", with: "", options: .regularExpression)
        return cleaned.isEmpty && line.contains("-") && line.contains("|")
    }

    private static func parseTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed = String(trimmed.dropFirst()) }
        if trimmed.hasSuffix("|") { trimmed = String(trimmed.dropLast()) }
        return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func escapeHTML(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
