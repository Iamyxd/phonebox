#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node_bin() {
  if command -v node >/dev/null 2>&1; then
    if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
      echo "node"
      return 0
    fi
  fi

  local candidates=(
    "/Volumes/Mydisk/Applications/AppPorts.noindex/Antigravity.app/Contents/MacOS/Antigravity"
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity"
    "$HOME/Applications/Antigravity.app/Contents/MacOS/Antigravity"
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

RUNTIME_BIN="$(find_node_bin || true)"
if [[ -z "$RUNTIME_BIN" ]]; then
  echo "Requires Node >= 22 or Antigravity executable (with ELECTRON_RUN_AS_NODE=1)." >&2
  exit 1
fi

if [[ "$RUNTIME_BIN" == "node" ]]; then
  exec node "$SCRIPT_DIR/push-antigravity.js" "$@"
else
  ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME_BIN" "$SCRIPT_DIR/push-antigravity.js" "$@"
fi
