#!/usr/bin/env bash
# M0 acceptance: compose stack boots, /health is ok (server and through the web proxy), tests pass.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

compose_up
wait_for_url "http://localhost:8080/api/health" 60

body="$(curl -fsS "$API/health")"
echo "$body" | grep -q '"status":"ok"' || fail "/health not ok: $body"

log "pnpm test"
pnpm test

log "M0 PASS"
