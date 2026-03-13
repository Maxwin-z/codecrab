#!/bin/bash

# Kill any existing process on port 5730
lsof -t -i:5730 | xargs kill 2>/dev/null
sleep 0.5

# Run vite directly (not via pnpm) to avoid pnpm wrapping exit codes
cd "$(dirname "$0")/packages/app"

# Forward signals to vite for clean shutdown
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

npx vite &
PID=$!
wait $PID
