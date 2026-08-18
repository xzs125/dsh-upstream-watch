#!/bin/bash
# Build the client bundle with the dsh checkout's tsdown (or local install if present).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness" "/root/deepseek-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

if [ -x "$ROOT/node_modules/.bin/tsdown" ]; then
  TSDOWN="$ROOT/node_modules/.bin/tsdown"
elif [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/node_modules/.bin/tsdown" ]; then
  TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
else
  echo "build:client: tsdown not found" >&2
  exit 1
fi

echo "=== Building client bundle with $("$TSDOWN" --version 2>/dev/null || echo tsdown) ==="
"$TSDOWN"
echo "=== Client build complete ==="
ls -la lib/client.js 2>/dev/null
