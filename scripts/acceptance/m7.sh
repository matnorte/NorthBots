#!/usr/bin/env bash
# M7 acceptance: letters routed by the mail agent (skill match; low confidence → coordinator),
# the idea bin and bin-picker, rooms, and a full Talk with a decision record and listener memory.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
node scripts/acceptance/m7.mjs
log "M7 PASS"
