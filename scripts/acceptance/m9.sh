#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
compose_up
pnpm --filter @northbot/scheduler test
pnpm --filter @northbot/server test -- test/m9.test.ts
pnpm --filter @northbot/web exec playwright test schedules.spec.ts
log "M9 PASS"
