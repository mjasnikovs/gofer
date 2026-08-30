#!/usr/bin/env bash
set -euo pipefail
export GOFER_LIVE_CONNECTION=openrouter
export GOFER_LIVE_MODEL="${GOFER_LIVE_MODEL:-z-ai/glm-5.3-flash}"
exec "$(dirname "$0")/live-turn.sh" "$@"
