// @codecrab/relay — Public network relay server
//
// Architecture:
//   [User Browser] ←WSS→ [Relay Server] ←WSS→ [User's LAN Server]
//
// Responsibilities:
//   1. Accept tunnel connections from LAN servers (authenticated by Token)
//   2. Accept browser connections and route to the correct tunnel
//   3. Transparent message forwarding (no data persistence)
//   4. Public address allocation (subdomain or path-based)
//   5. Heartbeat and connection lifecycle management
//   6. TLS termination
//   7. Rate limiting and abuse prevention
