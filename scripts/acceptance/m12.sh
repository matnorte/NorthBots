#!/usr/bin/env bash
# M12 acceptance: install.sh end to end in a clean Ubuntu container; backup then restore into a
# fresh database; a failing update rolls back; the Windows companion pairs (mock tunnel in Go
# tests, then the real binary against the server) and runs a click-and-type script on the fake
# driver; the store pack runs a simulated day into a profit report.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
export PATH="$PATH:/usr/local/go/bin:/c/Program Files/Go/bin"

log "installer Docker dependency regressions"
bash scripts/acceptance/installer-deps.sh

compose_up

log "deployment CLI failure and archive regressions"
bash scripts/acceptance/deploy-cli.sh

log "companion: Go tests (mock tunnel server, fake desktop)"
(cd companion && go vet ./... && go test -count=1 ./...)

log "store pack: adapter, profit and simulated-day tests"
pnpm --filter @northbot/pack-store-operator test

log "server: companion, operations and pack integration tests"
pnpm --filter @northbot/server exec vitest run test/companion.test.ts test/ops.test.ts test/packs.test.ts

ROOT="$ROOT" node scripts/acceptance/m12.mjs

log "install.sh in a clean Ubuntu 24.04 container (Docker inside, HTTPS, first account)"
# Docker Desktop on Windows needs Windows paths for bind mounts.
hostpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
mkdir -p test-results
IMAGES_TAR="$ROOT/test-results/m12-images.tar"
docker pull -q caddy:2.8.4 >/dev/null
docker save -o "$IMAGES_TAR" northbot/server:latest northbot/web:latest northbot/egress:latest northbot/agent:dev pgvector/pgvector:pg16 caddy:2.8.4
docker volume rm -f northbot-install-test >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run --rm --privileged \
  -v "$(hostpath "$ROOT"):/src:ro" -v "$(hostpath "$IMAGES_TAR"):/images.tar:ro" -v northbot-install-test:/var/lib/docker \
  ubuntu:24.04 bash -c '
    set -e
    bash /src/install.sh --source /src --domain localhost --email admin@example.test --images /images.tar --skip-cron
    curl -fsS -k https://localhost/api/health | grep -q "\"status\":\"ok\""
    test -s /opt/northbot/first-login.txt
    grep -q "^NORTHBOT_MASTER_KEY=" /opt/northbot/.env
    NORTHBOT_DIR=/opt/northbot northbot status >/dev/null
    PASS=$(sed -n "s/^password: //p" /opt/northbot/first-login.txt)
    curl -fsS -k -o /dev/null -H "content-type: application/json" -d "{\"email\":\"admin@example.test\",\"password\":\"$PASS\"}" https://localhost/api/auth/login
    # Re-running keeps the keys and the account.
    KEY=$(grep NORTHBOT_MASTER_KEY /opt/northbot/.env)
    bash /src/install.sh --source /src --domain localhost --email admin@example.test --images /images.tar --skip-cron >/dev/null
    test "$KEY" = "$(grep NORTHBOT_MASTER_KEY /opt/northbot/.env)"
    echo INSTALL_OK
  ' 2>&1 | tee "$ROOT/test-results/m12-install.log"
grep -q INSTALL_OK "$ROOT/test-results/m12-install.log" || fail "installer did not finish its acceptance checks"
docker volume rm -f northbot-install-test >/dev/null 2>&1 || true
rm -f "$IMAGES_TAR"
log "install.sh: Docker installed, images loaded, HTTPS up, first account signs in, re-run keeps the keys"

log "M12 PASS"
