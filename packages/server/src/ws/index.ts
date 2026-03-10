// WebSocket module — connection management and message routing
//
// Responsibilities:
//   1. Handle WebSocket upgrade from Express server
//   2. Client state management (clientId, projectId, sessionId)
//   3. Message dispatching based on WsMessage type
//   4. Streaming relay: engine StreamEvents → ws messages
//   5. Multi-client broadcasting per project
//   6. Reconnection handling with message buffering
//   7. Auth validation on connection
