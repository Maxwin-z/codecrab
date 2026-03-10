// Auth module — Token-based authentication
//
// Responsibilities:
//   1. Generate secure tokens (crypto.randomBytes + optional user salt)
//   2. Validate tokens on HTTP and WebSocket connections
//   3. Express middleware: validateToken()
//   4. WebSocket upgrade hook: authenticateWs()
//   5. Token persistence in ~/.codeclaws/config.json
//   6. Token rotation and revocation
