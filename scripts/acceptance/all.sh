#!/usr/bin/env bash
# Runs every milestone acceptance script (m0.sh, m1.sh, ...) in numeric order.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

for n in $(seq 0 12); do
  script="$ROOT/scripts/acceptance/m$n.sh"
  [ -f "$script" ] || continue
  log "=== M$n ==="
  bash "$script"
done
log "ALL ACCEPTANCE PASSED"
