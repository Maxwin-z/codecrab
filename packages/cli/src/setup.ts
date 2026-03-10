// Setup wizard — interactive CLI configuration
//
// Flow:
//   1. Generate access token (crypto.randomBytes + optional user salt)
//   2. Select network mode (LAN only / public relay)
//   3. Scan local environment for existing Claude Code configs
//   4. Configure models (API keys, providers, base URLs)
//   5. Set default model
//   6. Create default workspace (~/.codeclaws/ and ~/codeclaws-workspace/)
//   7. Start server and open browser
//
// Persists config to ~/.codeclaws/config.json
