// Markdown → Telegram formatting + message splitting
//
// Telegram uses a subset of Markdown (MarkdownV2) or HTML.
// We use HTML mode for more predictable behavior.

const MAX_MESSAGE_LENGTH = 4000 // Telegram limit ~4096, leave margin

/** Convert Markdown-like text to Telegram HTML */
export function formatForTelegram(text: string): string {
  // Escape HTML entities first
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Convert code blocks (``` ... ```)
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre>${code}</pre>`
  })

  // Convert inline code (` ... `)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Convert bold (**text** or __text__)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Convert italic (*text* or _text_)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

  // Convert strikethrough (~~text~~)
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  return result
}

/** Split a long message into Telegram-safe chunks */
export function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at a paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)

    // Fall back to line boundary
    if (splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf('\n', maxLength)
    }

    // Fall back to space boundary
    if (splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', maxLength)
    }

    // Last resort: hard split
    if (splitIdx < maxLength * 0.3) {
      splitIdx = maxLength
    }

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
  }

  return chunks
}

/** Format a tool use notification for Telegram */
export function formatToolUse(toolName: string): string {
  // Map common tool names to icons
  const icons: Record<string, string> = {
    Read: '📖',
    Write: '✍️',
    Edit: '✏️',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    WebSearch: '🌐',
    WebFetch: '🌐',
    Agent: '🤖',
  }
  const icon = icons[toolName] || '🔧'
  return `${icon} <i>Using ${toolName}...</i>`
}

/** Format an error message for Telegram */
export function formatError(error: string): string {
  const preview = error.length > 500 ? error.slice(0, 500) + '...' : error
  return `❌ <b>Error:</b> <code>${preview}</code>`
}

/** Format a result summary */
export function formatResult(costUsd?: number, durationMs?: number): string {
  const parts: string[] = []
  if (durationMs !== undefined) {
    const seconds = (durationMs / 1000).toFixed(1)
    parts.push(`⏱ ${seconds}s`)
  }
  if (costUsd !== undefined) {
    parts.push(`💰 $${costUsd.toFixed(4)}`)
  }
  return parts.length > 0 ? `\n<i>${parts.join(' · ')}</i>` : ''
}
