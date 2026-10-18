#!/usr/bin/env bash
# M1 acceptance: accounts, vault (values never returned), event log replay over WebSocket.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/acceptance/m1.mjs

# The canary value must not appear in server logs either.
canary_logs="$(docker compose logs --since "$since" server 2>&1 | grep -c 'sk-canary-' || true)"
[ "$canary_logs" = "0" ] || fail "secret canary found in server logs"

log "M1 PASS"
