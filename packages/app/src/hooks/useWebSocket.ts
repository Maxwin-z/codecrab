// WebSocket hook — client-side connection and state management
//
// State:
//   connected, isRunning, messages, cwd, streamingText, streamingThinking,
//   pendingQuestion, pendingPermission, currentModel, sessionId, latestSummary
//
// Methods:
//   sendPrompt(text)            — send user message
//   sendCommand(cmd)            — send slash command (/clear, /model, etc.)
//   setProjectId(id, path)      — switch project
//   respondQuestion(toolId, choice)
//   respondPermission(requestId, allow)
//   resumeSession(sessionId)
//
// Features:
//   - Auto-reconnect with 2s delay
//   - Offline message buffering
//   - Token-based auth on connect
//   - Cron task execution handling
