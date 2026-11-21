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

  if [[ -n "${AG_APP_BIN:-}" && -x "${AG_APP_BIN}" ]]; then
    echo "$AG_APP_BIN"
    return 0
  fi

  local candidates=(
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity"
    "$HOME/Applications/Antigravity.app/Contents/MacOS/Antigravity"
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done

  if [[ "$(uname -s)" == "Darwin" ]]; then
    local running
    running="$(ps -ax -o comm= 2>/dev/null | grep -m1 '/Antigravity\.app/Contents/MacOS/Antigravity$' || true)"
    if [[ -n "$running" && -x "$running" ]]; then
      echo "$running"
      return 0
    fi
    if command -v mdfind >/dev/null 2>&1; then
      local app
      while IFS= read -r app; do
        if [[ -x "$app/Contents/MacOS/Antigravity" ]]; then
          echo "$app/Contents/MacOS/Antigravity"
          return 0
        fi
      done < <(mdfind 'kMDItemFSName == "Antigravity.app"' 2>/dev/null || true)
    fi
  fi
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
  # Pass -e so process scanners (e.g. start-safe-plugins.sh is_agy_running)
  # distinguish this headless ELECTRON_RUN_AS_NODE bridge from the GUI app.
  ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME_BIN" -e 'require(process.argv[1])' "$SCRIPT_DIR/push-antigravity.js" "$@"
fi
