#!/bin/bash
# Stop the API server and worker

ML_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ML_DIR/.pids"

for service in api worker; do
    PID_FILE="$PID_DIR/$service.pid"
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping $service (PID $PID)..."
            kill "$PID"
            rm "$PID_FILE"
        else
            echo "$service not running (stale PID file)"
            rm "$PID_FILE"
        fi
    else
        echo "$service not running"
    fi
done

# Fallback: if something is still holding the port, stop it
PORT_PID=$(lsof -nP -iTCP:8420 -sTCP:LISTEN -t 2>/dev/null | head -n 1)
if [ -n "$PORT_PID" ]; then
    echo "Stopping process listening on :8420 (PID $PORT_PID)..."
    kill "$PORT_PID" 2>/dev/null || true
fi

echo "All services stopped."
