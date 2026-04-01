#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.pids"
LOG_DIR="$ROOT_DIR/.logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

# Check if already running
if [ -f "$PID_DIR/server-v2.pid" ]; then
  PID=$(cat "$PID_DIR/server-v2.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "[v2] Already running (server-v2 PID=$PID). Run 'pnpm stop:v2' first."
    exit 1
  fi
fi

echo "[v2] Building shared..."
cd "$ROOT_DIR/packages/shared" && pnpm build

echo "[v2] Building server-v2..."
cd "$ROOT_DIR/packages/server-v2" && pnpm build

echo "[v2] Building app-v2..."
cd "$ROOT_DIR/packages/app-v2" && pnpm build

SERVER_LOG="$LOG_DIR/server-v2.log"
APP_LOG="$LOG_DIR/app-v2.log"

echo "[v2] Starting server-v2 in background..."
cd "$ROOT_DIR/packages/server-v2"
> "$SERVER_LOG"
nohup node dist/index.js >> "$SERVER_LOG" 2>&1 &
echo $! > "$PID_DIR/server-v2.pid"

echo "[v2] Starting app-v2 preview in background..."
cd "$ROOT_DIR/packages/app-v2"
> "$APP_LOG"
nohup pnpm preview >> "$APP_LOG" 2>&1 &
echo $! > "$PID_DIR/app-v2.pid"

# Wait for server to boot and show QR code from log
echo ""
echo "[v2] Waiting for server to start..."
for i in $(seq 1 20); do
  if grep -q "Scan QR code" "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

echo ""
echo "════════════════════════════════════════"
# Print everything from server log up to and including the QR code block
awk '/Scan QR code/,0' "$SERVER_LOG" | head -30
echo "════════════════════════════════════════"
echo ""
echo "  Web UI  → http://localhost:5740"
echo "  API     → http://localhost:4200"
echo ""
echo "  Logs: .logs/server-v2.log  |  .logs/app-v2.log"
echo "  Run 'pnpm stop:v2' to stop"
