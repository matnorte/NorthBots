#!/usr/bin/env bash
# M2 acceptance: LLM router and the OpenAI-compatible endpoint, with fake providers.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
node scripts/acceptance/m2.mjs
log "M2 PASS"
