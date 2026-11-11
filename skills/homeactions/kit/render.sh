#!/usr/bin/env bash
# Thin wrapper so the skill and docs can say `render.sh`; the renderer itself is zero-dependency Node (>= 18).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "render.sh: needs Node.js >= 18 on the machine running your coding agent (not on the runner host)" >&2; exit 2; }
exec node "$here/render.mjs" "$@"
