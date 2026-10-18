#!/usr/bin/env bash
# M6 acceptance: a task repeated 3 times drafts a skill; approving it makes the 4th run use it;
# a skill with a planted secret is rejected; memory export then import restores it exactly.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up

log "memory and skills unit tests (embedder, contradictions, archive formats, scanner, detector)"
pnpm --filter @northbot/memory test
pnpm --filter @northbot/skills test

node scripts/acceptance/m6.mjs
log "M6 PASS"
