#!/bin/bash
# ============================================================
# InstaHeadshot — Start both the API server and worker
# Runs both processes in the background. Use stop.sh to kill them.
# ============================================================

set -e

ML_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ML_DIR/.venv"
LOG_DIR="$ML_DIR/logs"
PID_DIR="$ML_DIR/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# Activate venv
if [ -d "$VENV_DIR" ]; then
    source "$VENV_DIR/bin/activate"
else
    echo "Virtual environment not found. Run setup.sh first."
    exit 1
fi

PY="$VENV_DIR/bin/python3"

# Check if already running
if [ -f "$PID_DIR/api.pid" ] && kill -0 "$(cat "$PID_DIR/api.pid")" 2>/dev/null; then
    echo "API server already running (PID $(cat "$PID_DIR/api.pid"))"
else
    echo "Starting API server on http://127.0.0.1:8420..."
    nohup "$PY" "$ML_DIR/job_runner/job_queue.py" api \
        > "$LOG_DIR/api.log" 2>&1 &
    echo $! > "$PID_DIR/api.pid"
    echo "API server started (PID $!)"
fi

if [ -f "$PID_DIR/worker.pid" ] && kill -0 "$(cat "$PID_DIR/worker.pid")" 2>/dev/null; then
    echo "Worker already running (PID $(cat "$PID_DIR/worker.pid"))"
else
    echo "Starting job worker..."
    nohup "$PY" "$ML_DIR/job_runner/job_queue.py" worker \
        > "$LOG_DIR/worker.log" 2>&1 &
    echo $! > "$PID_DIR/worker.pid"
    echo "Worker started (PID $!)"
fi

echo ""
echo "Both services running. Logs:"
echo "  API:    $LOG_DIR/api.log"
echo "  Worker: $LOG_DIR/worker.log"
echo ""
echo "To stop: ./scripts/stop.sh"
echo "To view logs: tail -f $LOG_DIR/worker.log"

# Wait for API health endpoint so callers don't race the startup.
echo ""
echo "Waiting for API health..."
for i in {1..30}; do
    if curl -sS "http://127.0.0.1:8420/api/health" >/dev/null 2>&1; then
        echo "API is healthy."
        break
    fi
    sleep 0.2
done

# Verify worker is still running (helps catch immediate exits).
if [ -f "$PID_DIR/worker.pid" ]; then
    WPID="$(cat "$PID_DIR/worker.pid")"
    if ! kill -0 "$WPID" 2>/dev/null; then
        echo "Worker exited immediately. Last log lines:"
        tail -n 40 "$LOG_DIR/worker.log" || true
        exit 1
    fi
fi
