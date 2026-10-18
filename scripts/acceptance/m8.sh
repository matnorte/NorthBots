#!/usr/bin/env bash
# M8: event-log parity, bubbles, letters, break-room entry, lift/pause/drop and list parity.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
compose_up
pnpm --filter @northbot/shared test
pnpm --filter @northbot/web test
pnpm --filter @northbot/web exec playwright test office.spec.ts
log "M8 PASS"
