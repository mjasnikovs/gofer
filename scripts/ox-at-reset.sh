#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/oxloop
dump="$PWD/logs/oxloop/catalog.json"
prompt="$PWD/logs/oxloop/prompt.txt"
GOFER_DUMP_CATALOG="$dump" GOFER_DUMP_PROMPT="$prompt" \
  cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
  -- dump_catalog_and_prompt --test-threads=1 > /dev/null 2>&1

export GOFER_BENCH_CATALOG="$dump"
export GOFER_BENCH_PROMPT="$prompt"
export GOFER_BENCH_ENDPOINT="https://openrouter.ai/api/v1/chat/completions"
export OPENROUTER_API_KEY="$(secret-tool lookup service com.gofer.desktop username ai-openrouter)"
export GOFER_BENCH_MODEL="z-ai/glm-5.3-flash"

echo "=== where save lives (iteration 35) ==="
node scripts/bench-where-save-lives.mjs "${1:-12}" 2>&1 | tail -6
echo "=== search or ask ==="
node scripts/bench-search-or-ask.mjs "${1:-12}" 2>&1 | tail -6
echo "=== the four verification turns ==="
./scripts/ox-batch10.sh
