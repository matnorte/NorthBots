#!/usr/bin/env bash
# NorthBot installer for a bare Ubuntu server (22.04 or 24.04).
#
#   sudo ./install.sh --domain bots.example.com --email you@example.com
#
# It installs Docker, copies NorthBot to /opt/northbot, writes secrets to .env (a new vault
# master key and database password), starts everything behind HTTPS (Caddy, automatic
# certificates), creates the first account, installs the `northbot` command, and schedules a
# nightly backup. Running it again keeps your .env and data and just brings things up to date.
#
# Options:
#   --domain NAME      Public domain (DNS must point here). "localhost" works for trying it out.
#   --email ADDRESS    The first account's email.
#   --password TEXT    The first account's password (default: generated and saved to first-login.txt).
#   --source DIR       Install from this checkout (default: the folder this script is in).
#   --repo URL         Or clone from git (with --ref BRANCH_OR_TAG).
#   --dir DIR          Where to install (default /opt/northbot).
#   --images FILE      Load prebuilt images from a `docker save` tarball instead of building.
#   --no-https         Skip Caddy; serve plain HTTP on port 8080 (development only).
#   --skip-cron        Do not install the nightly backup.
set -euo pipefail

ARGS=("$@")
DOMAIN="" EMAIL="" PASSWORD="" SOURCE="" REPO="" REF="main" DIR="/opt/northbot" IMAGES="" HTTPS=1 CRON=1

log() { printf '\033[1;35m[northbot]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[northbot] error:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --images) IMAGES="$2"; shift 2 ;;
    --no-https) HTTPS=0; shift ;;
    --skip-cron) CRON=0; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ -n "$DOMAIN" ] || die "--domain is required"
[ -n "$EMAIL" ] || die "--email is required"
case "$DOMAIN" in *[!a-zA-Z0-9.-]*) die "--domain must be a plain host name" ;; esac
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "run as root"
  exec sudo -E bash "$0" "${ARGS[@]}"
fi
if [ -z "$SOURCE" ] && [ -z "$REPO" ]; then SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi

# ---- 1. The system ----
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = "ubuntu" ] || log "warning: this installer is tested on Ubuntu; found ${PRETTY_NAME:-an unknown system}"
export DEBIAN_FRONTEND=noninteractive
need=()
for c in curl openssl rsync git; do command -v "$c" >/dev/null || need+=("$c"); done
command -v docker >/dev/null || need+=(docker.io)
docker compose version >/dev/null 2>&1 || need+=(docker-compose-v2)
if [ ${#need[@]} -gt 0 ]; then
  log "installing ${need[*]}"
  apt-get update -qq
  apt-get install -y -qq ca-certificates "${need[@]}" >/dev/null
fi

if ! docker info >/dev/null 2>&1; then
  if [ -d /run/systemd/system ]; then
    systemctl enable --now docker >/dev/null
  else
    # Containers and CI without systemd: start the daemon ourselves.
    log "starting dockerd"
    (dockerd >/var/log/dockerd.log 2>&1 &)
  fi
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker did not start (see /var/log/dockerd.log)"
fi

# ---- 2. The code ----
mkdir -p "$DIR"
if [ -n "$REPO" ]; then
  if [ -d "$DIR/.git" ]; then
    log "updating $DIR from $REPO ($REF)"
    git -C "$DIR" fetch --depth 1 origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD
  else
    log "cloning $REPO ($REF) into $DIR"
    git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
  fi
elif [ "$(cd "$SOURCE" && pwd)" != "$(cd "$DIR" && pwd)" ]; then
  log "copying NorthBot from $SOURCE to $DIR"
  rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude test-results --exclude .env \
    --exclude first-login.txt --exclude backups "$SOURCE/" "$DIR/"
fi
cd "$DIR"
[ -f docker-compose.yml ] || die "$DIR does not look like NorthBot (no docker-compose.yml)"

# ---- 3. Secrets (written once, never rotated by a re-run) ----
if [ ! -f .env ]; then
  log "writing .env with a new vault master key and database password"
  umask 077
  if [ "$HTTPS" = 1 ]; then ORIGIN="https://$DOMAIN"; SECURE=true; WEB_BIND=127.0.0.1; else ORIGIN="http://$DOMAIN:8080"; SECURE=false; WEB_BIND=0.0.0.0; fi
  cat > .env <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep a copy of NORTHBOT_MASTER_KEY somewhere safe:
# without it, the vault in a backup cannot be read.
NORTHBOT_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NORTHBOT_DOMAIN=$DOMAIN
NORTHBOT_HTTPS=$([ "$HTTPS" = 1 ] && echo true || echo false)
RP_ID=$DOMAIN
WEB_ORIGIN=$ORIGIN
COOKIE_SECURE=$SECURE
# The database and API listen on this machine only; the web (or Caddy) is the way in.
BIND_ADDR=127.0.0.1
WEB_BIND=$WEB_BIND
EOF
  umask 022
else
  log "keeping the existing .env (secrets and keys are never rotated by a re-run)"
fi
set -a; . ./.env; set +a
FILES=(-f docker-compose.yml)
[ "${NORTHBOT_HTTPS:-false}" = true ] && FILES+=(-f deploy/docker-compose.https.yml)
compose() { docker compose --project-directory "$DIR" "${FILES[@]}" "$@"; }

# ---- 4. Images and start ----
if [ -n "$IMAGES" ]; then
  log "loading prebuilt images from $IMAGES"
  docker load -q -i "$IMAGES"
  compose up -d --no-build
else
  log "building images (the agent computer image takes a few minutes the first time)"
  compose --profile images build -q agent-image
  compose build -q
  compose up -d
fi

log "waiting for NorthBot to be healthy"
for i in $(seq 1 150); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  [ "$i" = 150 ] && { compose logs --tail 60 server; die "the server did not become healthy"; }
  sleep 2
done

if [ "${NORTHBOT_HTTPS:-false}" = true ]; then
  log "checking HTTPS for $DOMAIN"
  for i in $(seq 1 60); do
    curl -fsS -k --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1 && break
    [ "$i" = 60 ] && { compose logs --tail 40 caddy; die "HTTPS did not come up (is DNS for $DOMAIN pointing here, and ports 80/443 open?)"; }
    sleep 2
  done
fi

# ---- 5. The first account ----
if [ ! -f first-login.txt ]; then
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  body=$(printf '{"email":"%s","password":"%s"}' "$(json "$EMAIL")" "$(json "$PASSWORD")")
  code=$(curl -s -o /tmp/northbot-signup.json -w '%{http_code}' -H 'content-type: application/json' -d "$body" http://127.0.0.1:3000/auth/signup)
  case "$code" in
    201) umask 077; printf 'email: %s\npassword: %s\n' "$EMAIL" "$PASSWORD" > first-login.txt; umask 022; log "created the first account ($EMAIL); the password is in $DIR/first-login.txt" ;;
    409) log "an account for $EMAIL already exists" ;;
    *) die "could not create the first account (HTTP $code): $(cat /tmp/northbot-signup.json)" ;;
  esac
  rm -f /tmp/northbot-signup.json
fi

# ---- 6. The northbot command and nightly backups ----
install -m 755 deploy/northbot /usr/local/bin/northbot
printf 'NORTHBOT_DIR=%s\n' "$DIR" > /etc/northbot.conf
if [ "$CRON" = 1 ] && [ -d /etc/cron.d ]; then
  printf 'SHELL=/bin/bash\n0 3 * * * root /usr/local/bin/northbot backup --rotate 7 >> /var/log/northbot-backup.log 2>&1\n' > /etc/cron.d/northbot-backup
  log "nightly backups: 03:00, keeping 7 (in $DIR/backups)"
fi

URL="$WEB_ORIGIN"
log "done. Open $URL and sign in as $EMAIL."
log "manage it with: northbot status | backup | restore FILE | update"
