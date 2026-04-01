#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.pids"

stop_process() {
  local name=$1
  local pid_file="$PID_DIR/$name.pid"

  if [ ! -f "$pid_file" ]; then
    echo "[v2] $name: not running (no PID file)"
    return
  fi

  local PID
  PID=$(cat "$pid_file")

  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "[v2] $name: stopped (PID=$PID)"
  else
    echo "[v2] $name: already stopped (PID=$PID stale)"
  fi

  rm -f "$pid_file"
}

stop_process "server-v2"
stop_process "app-v2"
