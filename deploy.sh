#!/usr/bin/env bash
# deploy.sh — copy the extension source into Pi's global extensions dir.
#
# Usage:
#   ./deploy.sh            # deploy + type-check first
#   ./deploy.sh --no-check # skip the type-check, just copy
#
# After deploying, run /reload in a live Pi session to pick up changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/todo-footer.ts"
DEST_DIR="$HOME/.pi/agent/extensions"
DEST="$DEST_DIR/todo-footer.ts"

if [[ ! -f "$SRC" ]]; then
	echo "✗ source not found: $SRC" >&2
	exit 1
fi

# Type-check first (unless skipped) so we never deploy a broken build.
if [[ "${1:-}" != "--no-check" ]]; then
	echo "▸ type-checking…"
	"$SCRIPT_DIR/check.sh" || { echo "✗ type-check failed, aborting deploy"; exit 1; }
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
echo "✓ deployed: $DEST"
echo "  run /reload in Pi to apply"
