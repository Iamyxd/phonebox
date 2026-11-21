#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.state"
PID_FILE="$STATE_DIR/bridge.pid"
LOG_FILE="$STATE_DIR/bridge.log"
AGENT_BIN="$HOME/Library/Application Support/PhoneBox/app/PhoneBoxAgent"
AGENT_URL="${PHONEBOX_URL:-http://127.0.0.1:8765}"

agent_up() {
  curl -fsS --max-time 1 "$AGENT_URL/api/info" >/dev/null 2>&1
}

bridge_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local p
    p="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
    if [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null; then
      echo "$p"
      return 0
    fi
  fi
  pgrep -f "antigravity-bridge/push-antigravity\.js" 2>/dev/null | head -n 1 || true
}

start_agent() {
  if agent_up; then
    echo "PhoneBoxAgent: already running ($AGENT_URL)"
    return 0
  fi
  if [[ ! -x "$AGENT_BIN" ]]; then
    echo "PhoneBoxAgent not found at: $AGENT_BIN" >&2
    return 1
  fi
  nohup "$AGENT_BIN" >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
  local i=0
  while (( i < 30 )); do
    if agent_up; then
      echo "PhoneBoxAgent: started ($AGENT_URL)"
      return 0
    fi
    sleep 0.3
    i=$((i + 1))
  done
  echo "PhoneBoxAgent started, waiting on $AGENT_URL (check ~/Library/Application Support/PhoneBox/agent.log)"
}

start_bridge_bg() {
  mkdir -p "$STATE_DIR"
  local p
  p="$(bridge_pid)"
  if [[ -n "$p" ]]; then
    echo "Antigravity bridge: already running (PID $p)"
    return 0
  fi
  nohup bash "$SCRIPT_DIR/run.sh" >"$LOG_FILE" 2>&1 </dev/null &
  local new_pid=$!
  disown 2>/dev/null || true
  echo "$new_pid" >"$PID_FILE"
  sleep 1
  if kill -0 "$new_pid" 2>/dev/null; then
    echo "Antigravity bridge: started in background (PID $new_pid, log: $LOG_FILE)"
  else
    echo "Antigravity bridge failed to stay up. Check $LOG_FILE" >&2
    return 1
  fi
}

cmd_status() {
  if agent_up; then
    echo "PhoneBoxAgent: running ($AGENT_URL)"
    curl -fsS --max-time 2 "$AGENT_URL/api/info" | python3 -c 'import sys, json; d = json.load(sys.stdin); print("Phone: connected=" + str(d.get("connected")) + " via=" + str(d.get("via")) + " devices=" + str(d.get("devices")))' 2>/dev/null || true
  else
    echo "PhoneBoxAgent: stopped"
  fi

  local p
  p="$(bridge_pid)"
  if [[ -n "$p" ]]; then
    echo "Antigravity bridge: running (PID $p)"
  else
    echo "Antigravity bridge: stopped"
  fi
}

cmd_stop() {
  local p
  p="$(bridge_pid)"
  if [[ -n "$p" ]]; then
    kill "$p" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Antigravity bridge: stopped (PID $p)"
  else
    rm -f "$PID_FILE"
    echo "Antigravity bridge: not running"
  fi
  if pkill -x PhoneBoxAgent 2>/dev/null; then
    echo "PhoneBoxAgent: stopped"
  else
    echo "PhoneBoxAgent: not running"
  fi
}

case "${1:-start}" in
  start)
    start_agent
    start_bridge_bg
    cmd_status
    ;;
  fg)
    start_agent
    exec bash "$SCRIPT_DIR/run.sh"
    ;;
  once)
    start_agent
    exec bash "$SCRIPT_DIR/run.sh" --once
    ;;
  setup)
    start_agent
    exec bash "$SCRIPT_DIR/run.sh" --setup-page
    ;;
  status)
    cmd_status
    ;;
  stop)
    cmd_stop
    ;;
  open)
    start_agent
    open "$AGENT_URL/"
    ;;
  *)
    echo "Usage: phonebox [start|fg|once|setup|status|stop|open]" >&2
    exit 1
    ;;
esac
