#!/usr/bin/env bash
# Start the hub with ONLY its own settings (from .env next to server.js). Nothing leaks in from the shell:
# not other projects' keys, not stray *_OPEN flags, not the machine's timezone.
set -euo pipefail
cd "$(dirname "$0")/.."
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$PWD" NODE_ENV=production TZ=UTC node server.js
