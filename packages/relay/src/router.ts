// Request router — maps browser requests to the correct tunnel
//
// Routing strategies:
//   - Subdomain: {token-prefix}.relay.codecrab.dev → tunnel
//   - Path: relay.codecrab.dev/{token-prefix} → tunnel
//
// Handles both HTTP upgrade (WebSocket) and REST proxying
