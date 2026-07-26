#!/usr/bin/env bash
# check.sh — type-check todo-footer.ts against the installed Pi runtime.
#
# Resolves the Pi package globally (npm root -g) and maps its sub-deps via a
# temporary tsconfig. Exits non-zero on any TypeScript error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/todo-footer.ts"

if [[ ! -f "$SRC" ]]; then
	echo "✗ source not found: $SRC" >&2
	exit 1
fi

PI="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"
if [[ ! -d "$PI" ]]; then
	echo "✗ Pi package not found at $PI" >&2
	echo "  is @earendil-works/pi-coding-agent installed globally?" >&2
	exit 1
fi

TS_BIN="$(npx --no-install tsc 2>/dev/null && echo npx_tsc || true)"
TSCFG="$(mktemp --suffix=.json)"
trap 'rm -f "$TSCFG"' EXIT

cat > "$TSCFG" <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "moduleResolution": "bundler",
    "module": "ESNext", "target": "ES2022", "lib": ["ES2022"],
    "types": [], "skipLibCheck": true,
    "paths": {
      "@earendil-works/pi-coding-agent": ["$PI/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["$PI/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["$PI/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
      "typebox": ["$PI/node_modules/typebox/build/index.d.mts"]
    },
    "baseUrl": "$SCRIPT_DIR"
  },
  "files": ["$SRC"]
}
EOF

echo "▸ tsc --strict against $PI"
npx -p typescript@5 tsc -p "$TSCFG"
echo "✓ type-check passed"
