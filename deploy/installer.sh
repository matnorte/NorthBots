#!/usr/bin/env bash
# Sourced by the top-level entry point; keep SCRIPT_DIR at the checkout root.
set -euo pipefail
. "$SCRIPT_DIR/deploy/lib/progress.sh"
. "$SCRIPT_DIR/deploy/lib/platform.sh"
ARGS=("$@")
DOMAIN='' EMAIL='' PASSWORD='' SOURCE='' REPO='' REF=main DIR='' IMAGES='' HTTPS=auto CRON=1
USER_MODE=0 NO_DEPS=0 CHECK=0
log() { nb_log "$@"; }
die() { nb_log "error: $*"; exit 1; }
usage() {
  cat <<'HELP'
NorthBot installer
  bash install.sh --domain bots.example.com --email you@example.com
  bash install.sh --domain localhost --email you@example.com --user

  --domain HOST       Domain/IPv4; localhost is the desktop default
  --email ADDRESS     First account email (required)
  --password TEXT     Optional first password; otherwise generated privately
  --source DIR        Copy this checkout (default: installer directory)
  --repo URL          Clone source instead (--ref defaults to main)
  --dir DIR           Install location (/opt/northbot, or user data directory)
  --images FILE       Import prebuilt images with byte progress
  --no-https          HTTP on port 8080; default for localhost/IPv4
  --https             Explicit HTTPS (default for a public domain)
  --user              Use an existing accessible Docker engine without sudo
  --no-deps           Do not install packages or download CLI plugins
  --check             Read-only prerequisite check; no installation
  --progress MODE     auto (terminal bars), plain (logs), or quiet
  --skip-cron         Do not configure automatic backups
  -h, --help          Show this help

Linux: apt, dnf/yum, apk, pacman and zypper package adapters.
macOS: Docker Desktop and Homebrew for missing command-line tools.
Windows: install.ps1 with WSL2 and Docker integration.
Requires local Docker running amd64/arm64 Linux containers.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain|--email|--password|--source|--repo|--ref|--dir|--images|--progress)
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "Missing value for $1"
      case "$1" in
        --domain) DOMAIN="$2" ;; --email) EMAIL="$2" ;; --password) PASSWORD="$2" ;;
        --source) SOURCE="$2" ;; --repo) REPO="$2" ;; --ref) REF="$2" ;; --dir) DIR="$2" ;;
        --images) IMAGES="$2" ;; --progress) NB_PROGRESS="$2" ;;
      esac; shift 2 ;;
    --no-https) HTTPS=0; shift ;; --https) HTTPS=1; shift ;;
    --user) USER_MODE=1; shift ;; --no-deps) NO_DEPS=1; shift ;;
    --check) CHECK=1; shift ;; --skip-cron) CRON=0; shift ;;
    -h|--help) usage; exit 0 ;; *) die "Unknown option $1 (see --help)" ;;
  esac
done
case "$NB_PROGRESS" in auto|plain|quiet) ;; *) die '--progress must be auto, plain or quiet' ;; esac
nb_detect_platform
[ "$NB_KERNEL" != Darwin ] || USER_MODE=1
[ -n "$DOMAIN" ] || DOMAIN=localhost
case "$DOMAIN" in -*|*.|.*|*[!a-zA-Z0-9.-]*) die '--domain must be a host name or IPv4 address, without a scheme or port' ;; esac
if [ "$CHECK" = 1 ]; then
  nb_log "Host: $NB_OS $NB_VERSION ($NB_ARCH); package manager: $NB_MANAGER"
  missing=0
  for dependency in curl openssl rsync git pv; do command -v "$dependency" >/dev/null || { nb_log "Missing $dependency"; missing=1; }; done
  docker compose version && docker buildx version && docker info >/dev/null || missing=1
  [ "$missing" = 0 ] || die 'Preflight found missing prerequisites or an inaccessible Docker engine'
  log 'Preflight passed'; exit 0
fi
[ -n "$EMAIL" ] || die '--email is required (for example --email you@example.com)'
case "$EMAIL" in *$'\n'*|*$'\r'*) die 'Invalid email' ;; esac
if [ "$NB_KERNEL" = Linux ] && [ "$USER_MODE" = 0 ] && [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null || die 'Run as root, or use --user with an accessible Docker engine'
  exec sudo -E bash "$SCRIPT_DIR/install.sh" "${ARGS[@]}"
fi
[ "$USER_MODE" = 0 ] || CRON=0
if [ -z "$DIR" ]; then
  if [ "$USER_MODE" = 1 ]; then DIR="$HOME/.local/share/northbot"; else DIR=/opt/northbot; fi
fi
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
# Resolve existing symlink/.. ancestors before any destructive rsync operation.
ancestor="$DIR" suffix=''
while [ ! -d "$ancestor" ]; do suffix="/$(basename "$ancestor")$suffix"; ancestor="$(dirname "$ancestor")"; done
DIR="$(cd "$ancestor" && pwd -P)$suffix"
case "$DIR" in /|/etc|/usr|/opt|/home|/root|"$HOME") die 'Choose a dedicated installation directory' ;; esac
if [ -z "$SOURCE" ] && [ -z "$REPO" ]; then SOURCE="$SCRIPT_DIR"; fi
[ -z "$SOURCE" ] || [ -f "$SOURCE/docker-compose.yml" ] || die '--source must contain docker-compose.yml'
if [ -n "$SOURCE" ]; then
  SOURCE="$(cd "$SOURCE" && pwd -P)"
  if [ "$SOURCE" != "$DIR" ]; then
    case "$DIR/" in "$SOURCE/"*) die 'Install directory cannot be inside the source checkout' ;; esac
    case "$SOURCE/" in "$DIR/"*) die 'Source checkout cannot be inside the installation directory' ;; esac
  fi
fi
if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ] && [ ! -f "$DIR/docker-compose.yml" ] && [ ! -f "$DIR/.env" ]; then
  die 'Destination is not empty and has no NorthBot configuration; choose a dedicated directory'
fi
case "$REF" in -*|*$'\n'*|*$'\r'*) die 'Invalid source ref' ;; esac
case "$REPO" in -*|http*://*@*|*\?*|*$'\n'*|*$'\r'*) die 'Use a repository URL without embedded credentials/query; use a Git credential helper or SSH' ;; esac
if [ -n "$IMAGES" ]; then
  [ -f "$IMAGES" ] || die '--images archive not found'
  IMAGES="$(cd "$(dirname "$IMAGES")" && pwd)/$(basename "$IMAGES")"
fi
if [ "$HTTPS" = auto ]; then
  case "$DOMAIN" in localhost) if [ "$USER_MODE" = 1 ]; then HTTPS=0; else HTTPS=1; fi ;; *[!0-9.]*) HTTPS=1 ;; *) HTTPS=0 ;; esac
fi
DOCKER_PROGRESS=plain
if [ "$NB_PROGRESS" = auto ] && [ -t 2 ]; then DOCKER_PROGRESS=tty; fi
[ "$NB_PROGRESS" != quiet ] || DOCKER_PROGRESS=quiet
signup_tmp=''
cleanup() {
  local result=$?
  [ -z "$signup_tmp" ] || rm -rf -- "$signup_tmp"
  [ "$result" = 0 ] || nb_log "Installation stopped at stage $NB_STEP/$NB_STEPS. Existing keys were not rotated."
  [ "$result" = 0 ] || ! command -v northbot >/dev/null || nb_log "Diagnose with: northbot doctor"
}
trap cleanup EXIT
nb_step "Checking $NB_OS prerequisites"
if [ "$USER_MODE" = 1 ] && [ "$NB_KERNEL" = Linux ]; then NO_DEPS=1; fi
nb_dependencies
nb_step 'Connecting to the Docker engine'
if ! docker info >/dev/null 2>&1; then
  [ "$USER_MODE" = 0 ] || die 'Start Docker Desktop or your rootless Docker engine, then rerun'
  if [ -d /run/systemd/system ]; then nb_run 'Starting Docker' systemctl enable --now docker
  elif command -v rc-service >/dev/null; then nb_run 'Starting Docker' rc-service docker start
  elif command -v service >/dev/null && [ ! -f /.dockerenv ]; then nb_run 'Starting Docker' service docker start
  elif [ -f /.dockerenv ]; then log 'Starting dockerd in the installation test container'; (dockerd >/var/log/dockerd.log 2>&1 &)
  else die 'Start Docker using your service manager, then rerun the installer'; fi
  nb_wait 'Docker engine' 60 1 docker info || die 'Docker did not start (inspect service logs)'
fi
engine_os="$(docker info --format '{{.OSType}}')"
[ "$engine_os" = linux ] || die 'Switch Docker to Linux containers before installing NorthBot'
endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
case "$endpoint" in unix://*) ;; *) die 'Run this installer on the Docker host; remote/npipe contexts cannot mount local files' ;; esac
socket="${endpoint#unix://}"
if [ "$NB_KERNEL" = Darwin ] || docker info --format '{{.OperatingSystem}}' | grep -qi 'docker desktop'; then socket=/var/run/docker.sock; fi
nb_step 'Copying the application (file transfer progress follows)'
mkdir -p "$DIR"
if [ -n "$REPO" ]; then
  if [ -d "$DIR/.git" ]; then
    nb_run 'Fetching source' git -C "$DIR" fetch --progress --depth 1 origin "$REF"
    git -C "$DIR" checkout FETCH_HEAD
  else nb_run 'Cloning source' git clone --progress --depth 1 --branch "$REF" -- "$REPO" "$DIR"; fi
elif [ "$(cd "$SOURCE" && pwd)" != "$(cd "$DIR" && pwd)" ]; then
  log "copying NorthBot from $SOURCE to $DIR"
  rsync -a --progress --delete --exclude node_modules --exclude .git --exclude dist --exclude test-results --exclude .env \
    --exclude first-login.txt --exclude backups "$SOURCE/" "$DIR/"
fi
cd "$DIR"
[ -f docker-compose.yml ] || die "$DIR does not look like NorthBot (no docker-compose.yml)"
nb_step 'Preparing private instance configuration'
if [ ! -f .env ]; then
  log 'Writing .env with a new vault master key and database password'
  umask 077
  if [ "$HTTPS" = 1 ]; then ORIGIN="https://$DOMAIN"; SECURE=true; WEB_BIND=127.0.0.1; else ORIGIN="http://$DOMAIN:8080"; SECURE=false; WEB_BIND=0.0.0.0; fi
  cat > .env <<EOF
# Private NorthBot recovery material. Retain NORTHBOT_MASTER_KEY with protected backups.
NORTHBOT_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NORTHBOT_DOMAIN=$DOMAIN
NORTHBOT_HTTPS=$([ "$HTTPS" = 1 ] && echo true || echo false)
RP_ID=$DOMAIN
WEB_ORIGIN=$ORIGIN
COOKIE_SECURE=$SECURE
BIND_ADDR=127.0.0.1
WEB_BIND=$WEB_BIND
EOF
  umask 022
else log 'Keeping the existing .env (secrets and keys are never rotated by a re-run)'; fi
set -a; . ./.env; set +a
if [ "${NORTHBOT_DOMAIN:-$DOMAIN}" != "$DOMAIN" ] && [ "$DOMAIN" != localhost ]; then
  log "note: .env keeps domain ${NORTHBOT_DOMAIN}; to switch to $DOMAIN run: northbot set-domain $DOMAIN"
fi
DOMAIN="${NORTHBOT_DOMAIN:-$DOMAIN}"
# The management command goes on PATH now, so it is there even if a later stage fails.
install_cli() {
  if [ "$USER_MODE" = 0 ]; then
    install -m 755 deploy/northbot /usr/local/bin/northbot
    printf 'NORTHBOT_DIR=%q\n' "$DIR" > /etc/northbot.conf
  else
    mkdir -p "$HOME/.local/bin"
    printf '#!/usr/bin/env bash\nexport NORTHBOT_DIR=%q\nexec bash %q "$@"\n' "$DIR" "$DIR/deploy/northbot" > "$HOME/.local/bin/northbot"
    chmod 755 "$HOME/.local/bin/northbot"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
      for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || continue
        grep -qs 'NorthBot CLI' "$rc" || printf '\n# NorthBot CLI\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      done
      log "Added ~/.local/bin to PATH (open a new terminal to use northbot)" ;;
    esac
  fi
}
install_cli
FILES=(-f docker-compose.yml)
[ "${NORTHBOT_HTTPS:-false}" = true ] && FILES+=(-f deploy/docker-compose.https.yml)
compose() { docker compose --progress "$DOCKER_PROGRESS" --project-directory "$DIR" "${FILES[@]}" "$@"; }
if ! grep -q '^NORTHBOT_DOCKER_SOCKET=' .env && [ "$socket" != /var/run/docker.sock ]; then
  case "$socket" in *[[:space:]]*) die 'Set NORTHBOT_DOCKER_SOCKET explicitly for a socket path containing whitespace' ;; esac
  printf '\nNORTHBOT_DOCKER_SOCKET=%s\n' "$socket" >> .env
  export NORTHBOT_DOCKER_SOCKET="$socket"
fi
nb_step 'Preparing images (actual build and download progress follows)'
if [ -n "$IMAGES" ]; then
  log 'Loading archive; byte progress measures transfer into Docker'
  nb_stream "$(nb_file_bytes "$IMAGES")" 'Import images' < "$IMAGES" | docker load
else
  compose --profile images build agent-image
  compose build
fi
nb_step 'Downloading runtime images'
if [ -z "$IMAGES" ]; then
  compose pull postgres
  [ "${NORTHBOT_HTTPS:-false}" != true ] || compose pull caddy
else log 'Using supplied prebuilt images'; fi
nb_step 'Starting containers'
compose up -d --no-build
nb_step 'Waiting for API and web readiness'
nb_wait 'NorthBot API' 150 2 curl -fsS --max-time 5 http://127.0.0.1:3000/health || { compose logs --tail 60 server; die 'The server did not become healthy'; }
if [ "${NORTHBOT_HTTPS:-false}" = true ]; then
  nb_wait 'NorthBot HTTPS' 60 2 curl -fsS -k --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" || { compose logs --tail 40 caddy; die 'HTTPS did not become ready; check DNS and ports 80/443'; }
fi
nb_step 'Preparing the first account'
if [ ! -f first-login.txt ]; then
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  signup_tmp="$(mktemp -d)"
  printf '%s\0%s' "$EMAIL" "$PASSWORD" | compose exec -T server node --input-type=module -e '
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    const [email, password] = input.split("\0"); process.stdout.write(JSON.stringify({ email, password }));
  ' > "$signup_tmp/request.json"
  code=$(curl -s -o "$signup_tmp/response.json" -w '%{http_code}' -H 'content-type: application/json' --data-binary "@$signup_tmp/request.json" http://127.0.0.1:3000/auth/signup)
  case "$code" in
    201) umask 077; printf 'email: %s\npassword: %s\n' "$EMAIL" "$PASSWORD" > first-login.txt; umask 022; log "Created first account ($EMAIL); password is in $DIR/first-login.txt" ;;
    409) log "An account for $EMAIL already exists" ;;
    *) die "Could not create the first account (HTTP $code)" ;;
  esac
  rm -rf -- "$signup_tmp"; signup_tmp=''
fi
nb_step 'Running 24/7 and scheduling backups'
if [ "$USER_MODE" = 0 ]; then
  if [ -d /run/systemd/system ]; then
    /usr/local/bin/northbot enable || log 'Could not install the systemd units; containers still restart unless stopped'
  else log 'No systemd: containers restart unless stopped; start NorthBot at boot with your init system'; fi
  if [ "$CRON" = 1 ] && [ -d /etc/cron.d ]; then
    printf 'SHELL=/bin/bash\n0 3 * * * root /usr/local/bin/northbot backup --rotate 7 >> /var/log/northbot-backup.log 2>&1\n' > /etc/cron.d/northbot-backup
    log 'Nightly backups: 03:00, retaining seven archives'
  elif [ "$CRON" = 1 ]; then log 'No cron.d found; schedule northbot backup with your host scheduler'; fi
else
  log "Management command: $HOME/.local/bin/northbot. Schedule backups with your host scheduler."
fi
nb_complete
log "done. Open $WEB_ORIGIN and sign in as $EMAIL."
log 'Manage it with: northbot status | doctor | logs | backup | restore FILE | update'
