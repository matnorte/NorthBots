#!/usr/bin/env bash
# M4 acceptance: agent runtime, approvals, injection shield, kill switch, idempotency.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
node scripts/acceptance/m4.mjs
log "M4 PASS"
