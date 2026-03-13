#!/bin/bash

# Start CodeClaws server with PM2
# Usage: ./start-server.sh [start|stop|restart|logs|status]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="codeclaws-server"
PORT="${PORT:-42001}"  # Production port, overrides .env

cd "$SCRIPT_DIR"

case "${1:-start}" in
  start)
    echo "Starting $APP_NAME on port $PORT ..."
    PORT=$PORT pm2 start packages/server/dist/index.js \
      --name "$APP_NAME" \
      --cwd "$SCRIPT_DIR" \
      --update-env
    pm2 save
    echo "$APP_NAME started. Use './start-server.sh logs' to view logs."
    ;;
  stop)
    pm2 stop "$APP_NAME"
    pm2 save
    ;;
  restart)
    PORT=$PORT pm2 restart "$APP_NAME" --update-env
    pm2 save
    ;;
  logs)
    pm2 logs "$APP_NAME"
    ;;
  status)
    pm2 describe "$APP_NAME"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|logs|status}"
    exit 1
    ;;
esac
