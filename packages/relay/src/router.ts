// Request router — maps browser requests to the correct tunnel
//
// Routing strategies:
//   - Subdomain: {token-prefix}.relay.codeclaws.dev → tunnel
//   - Path: relay.codeclaws.dev/{token-prefix} → tunnel
//
// Handles both HTTP upgrade (WebSocket) and REST proxying
