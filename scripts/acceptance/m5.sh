#!/usr/bin/env bash
# M5 acceptance: mood engine covers every row; hatching e2e ends with a self-named agent that
# finished its first task; renaming locks the name; duplicate names are rejected.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up

log "mood engine unit tests (one per row of the mood table)"
pnpm --filter @northbot/shared exec vitest run src/mood.test.ts

log "hatching end to end in a real browser"
pnpm --filter @northbot/web exec playwright install chromium >/dev/null
pnpm --filter @northbot/web exec playwright test

node scripts/acceptance/m5.mjs
log "M5 PASS"
