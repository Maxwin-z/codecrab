// Tunnel manager — WebSocket tunnel between relay and LAN servers
//
// Responsibilities:
//   1. Authenticate incoming tunnel connections via Token
//   2. Maintain tunnel registry (token → ws connection)
//   3. Heartbeat ping/pong with configurable interval
//   4. Auto-cleanup on disconnect
//   5. Reconnection support (same token re-registers)
