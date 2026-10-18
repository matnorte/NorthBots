#!/usr/bin/env bash
# M3 acceptance: agent computers (isolation, browser, hibernate/wake, egress logging).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
node scripts/acceptance/m3.mjs
log "M3 PASS"
