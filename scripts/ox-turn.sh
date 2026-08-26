#!/usr/bin/env bash
# One live turn against OpenRouter. `scripts/live-turn.sh` with the connection already chosen,
# kept because the recorded batches name it and their runs have to stay re-runnable unchanged.
set -euo pipefail
export GOFER_LIVE_CONNECTION=openrouter
export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-stealth/ox-alpha}"
exec "$(dirname "$0")/live-turn.sh" "$@"
