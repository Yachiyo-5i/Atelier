#!/usr/bin/env bash
# Start Atelier image-generations server.
# Prefers packaged binary under dist/; falls back to node source.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
export PORT

pick_binary() {
  local candidates=(
    "$ROOT/dist/atelier"
    "$ROOT/dist/atelier.exe"
  )
  # any other built binary in dist/
  if [[ -d "$ROOT/dist" ]]; then
    while IFS= read -r f; do
      candidates+=("$f")
    done < <(find "$ROOT/dist" -maxdepth 1 -type f -perm -111 2>/dev/null | sort)
  fi

  for b in "${candidates[@]}"; do
    if [[ -f "$b" && -x "$b" ]]; then
      echo "$b"
      return 0
    fi
  done
  return 1
}

if BINARY="$(pick_binary)"; then
  echo "→ starting binary: $BINARY"
  echo "  PORT=$PORT"
  echo "  data dir: $(dirname "$BINARY")/data  (or \$ATELIER_HOME/data)"
  echo "  open: http://localhost:$PORT"
  echo
  # Run with cwd = binary dir so relative paths are predictable when needed
  cd "$(dirname "$BINARY")"
  exec "$BINARY"
fi

echo "→ binary not found, starting from source (node)"
if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "  installing dependencies..."
  npm install
fi
echo "  PORT=$PORT"
echo "  open: http://localhost:$PORT"
echo
exec node "$ROOT/server/index.js"
