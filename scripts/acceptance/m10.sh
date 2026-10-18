#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
compose_up
pnpm --filter @northbot/mcp test
pnpm --filter @northbot/server test -- test/m10.test.ts
pnpm --filter @northbot/web exec playwright test connections.spec.ts
log "M10 PASS"
