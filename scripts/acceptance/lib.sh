# Shared helpers for acceptance scripts. Source this file; do not run it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROOT
API="${NORTHBOT_API:-http://localhost:3000}"
export API

log() { printf '\033[1;35m[accept]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[accept] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# wait_for_url <url> <timeout_seconds>
wait_for_url() {
  local url="$1" timeout="${2:-60}" i=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$timeout" ]; then fail "timed out waiting for $url"; fi
    sleep 1
  done
  log "up: $url"
}

compose_up() {
  log "docker compose up -d --build"
  docker compose -f "$ROOT/docker-compose.yml" up -d --build
  wait_for_url "$API/health" 180
}
