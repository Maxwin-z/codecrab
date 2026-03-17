#!/bin/bash

PORTS=(4200 5730 5731)

echo "=== CodeCrab Dev ==="

for port in "${PORTS[@]}"; do
  pid=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "Killing process on port $port (PID: $pid)"
    kill -9 $pid 2>/dev/null
  fi
done

echo "Starting services..."
echo "  server  → http://localhost:4200"
echo "  app     → http://localhost:5730"
echo "  web     → http://localhost:5731"
echo ""

pnpm dev
