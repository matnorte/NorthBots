#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
compose_up
pnpm --filter @northbot/server test -- test/m11.test.ts
pnpm --filter @northbot/web exec playwright test security.spec.ts
log "M11 PASS"
