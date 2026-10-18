#!/usr/bin/env bash
# Host prerequisites. No remote shell scripts, engine replacement or data deletion.
nb_detect_platform() {
  NB_KERNEL="$(uname -s)" NB_ARCH="$(uname -m)" NB_MANAGER=none
  NB_OS=unknown NB_LIKE='' NB_VERSION=''
  if [ "$NB_KERNEL" = Linux ]; then
    local ID='' ID_LIKE='' VERSION_ID=''
    [ ! -r "${1:-/etc/os-release}" ] || . "${1:-/etc/os-release}"
    NB_OS="$ID" NB_LIKE="$ID_LIKE" NB_VERSION="$VERSION_ID"
    case " $NB_OS $NB_LIKE " in
      *ubuntu*|*debian*) NB_MANAGER=apt ;;
      *fedora*|*rhel*|*centos*) if command -v dnf >/dev/null; then NB_MANAGER=dnf; else NB_MANAGER=yum; fi ;;
      *alpine*) NB_MANAGER=apk ;;
      *arch*) NB_MANAGER=pacman ;;
      *suse*) NB_MANAGER=zypper ;;
    esac
  elif [ "$NB_KERNEL" = Darwin ]; then NB_OS=macos; command -v brew >/dev/null && NB_MANAGER=brew || true
  else
    die 'Use Linux, macOS with Docker Desktop, or install.ps1 with a WSL2 Linux distribution on Windows.'
  fi
  case "$NB_ARCH" in x86_64|amd64) NB_ARCH=amd64 ;; aarch64|arm64) NB_ARCH=arm64 ;; *) die "Unsupported CPU $NB_ARCH: this stack supports amd64 and arm64 Linux containers." ;; esac
}
nb_packages() {
  [ "$#" -gt 0 ] || return 0
  case "$NB_MANAGER" in
    apt) export DEBIAN_FRONTEND=noninteractive; nb_run 'Refreshing package index' apt-get update; nb_run 'Installing prerequisites' apt-get install -y -o Dpkg::Progress-Fancy=1 ca-certificates "$@" ;;
    dnf|yum) nb_run 'Installing prerequisites' "$NB_MANAGER" install -y "$@" ;;
    apk) nb_run 'Installing prerequisites' apk add --no-cache ca-certificates "$@" ;;
    pacman) nb_run 'Installing prerequisites' pacman -S --needed --noconfirm ca-certificates "$@" ;;
    zypper) nb_run 'Installing prerequisites' zypper --non-interactive install ca-certificates "$@" ;;
    brew) nb_run 'Installing prerequisites' brew install "$@" ;;
    *) die 'No supported package manager found. Install curl, openssl, rsync, git, pv and Docker with Compose/Buildx, then use --no-deps.' ;;
  esac
}
nb_repair_plugin() {
  local name="$1" config="${DOCKER_CONFIG:-$HOME/.docker}" candidate saved
  shift
  local candidates=("$@")
  if [ "${#candidates[@]}" = 0 ]; then
    candidates=(/usr/local/lib/docker/cli-plugins/docker-"$name" /usr/local/libexec/docker/cli-plugins/docker-"$name"
      /usr/lib/docker/cli-plugins/docker-"$name" /usr/libexec/docker/cli-plugins/docker-"$name"
      /Applications/Docker.app/Contents/Resources/cli-plugins/docker-"$name")
  fi
  docker "$name" version >/dev/null 2>&1 && return 0
  for candidate in "${candidates[@]}"; do
    [ -x "$candidate" ] && "$candidate" version >/dev/null 2>&1 || continue
    if [ -e "$config/cli-plugins/docker-$name" ] || [ -L "$config/cli-plugins/docker-$name" ]; then
      saved="$(umask 077; mkdir -p "$config/northbot-plugin-backups"; mktemp -d "$config/northbot-plugin-backups/$name.XXXXXX")" || return 1
      mv "$config/cli-plugins/docker-$name" "$saved/docker-$name" || return 1
      nb_log "Backed up an invalid user $name plugin; using the packaged plugin"
    fi
    if ! docker "$name" version >/dev/null 2>&1; then
      mkdir -p "$config/cli-plugins"
      ln -s "$candidate" "$config/cli-plugins/docker-$name" || return 1
    fi
    docker "$name" version >/dev/null 2>&1 && return 0
  done
  return 1
}
nb_download_plugin() {
  local name="$1" version asset checks base tmp hash actual target config="${DOCKER_CONFIG:-$HOME/.docker}"
  [ "$NB_KERNEL" = Linux ] || die "Repair Docker Desktop's $name plugin before continuing."
  case "$name" in
    compose) version=v2.40.3; asset=docker-compose-linux-x86_64; [ "$NB_ARCH" != arm64 ] || asset=docker-compose-linux-aarch64 ;;
    buildx) version=v0.30.1; asset="buildx-$version.linux-$NB_ARCH" ;;
    *) return 1 ;;
  esac
  base="https://github.com/docker/$name/releases/download/$version"
  tmp="$(mktemp -d)" || return 1
  # This subshell's trap owns only its private directory.
  (
    trap 'rm -rf -- "$tmp"' EXIT
    nb_download "$base/$asset" "$tmp/plugin" || exit 1
    nb_download "$base/checksums.txt" "$tmp/checksums" || exit 1
    hash="$(awk -v asset="$asset" '$2 == asset || $2 == "*"asset {print $1}' "$tmp/checksums")"
    [ "${#hash}" = 64 ] || { nb_log 'No unambiguous SHA-256 for plugin'; exit 1; }
    case "$hash" in *[!a-fA-F0-9]*) exit 1 ;; esac
    actual="$(openssl dgst -sha256 "$tmp/plugin")"; actual="${actual##* }"
    [ "$hash" = "$actual" ] || { nb_log 'Plugin checksum mismatch'; exit 1; }
    chmod 755 "$tmp/plugin"
    "$tmp/plugin" version >/dev/null || exit 1
    mkdir -p "$config/cli-plugins"
    target="$config/cli-plugins/docker-$name"
    if [ -e "$target" ] || [ -L "$target" ]; then
      checks="$(umask 077; mkdir -p "$config/northbot-plugin-backups"; mktemp -d "$config/northbot-plugin-backups/$name.XXXXXX")" || exit 1
      mv "$target" "$checks/docker-$name" || exit 1
    fi
    mv "$tmp/plugin" "$target"
  ) || return 1
  docker "$name" version >/dev/null 2>&1
}
nb_dependencies() {
  local need=() command compose_package=docker-compose-v2 buildx_package=docker-buildx
  nb_repair_plugin compose || true; nb_repair_plugin buildx || true
  for command in curl openssl rsync git pv; do command -v "$command" >/dev/null || need+=("$command"); done
  if [ "$NB_MANAGER" = apt ]; then
    command -v docker >/dev/null || need+=(docker.io)
    if dpkg-query -W -f='${Status}' docker-ce-cli 2>/dev/null | grep -qx 'install ok installed'; then
      compose_package=docker-compose-plugin buildx_package=docker-buildx-plugin
    elif [ "$NB_OS" != ubuntu ] && [[ " $NB_LIKE " != *ubuntu* ]]; then
      # Debian's stable repositories may omit v2 plugins; use verified releases below.
      compose_package='' buildx_package=''
    fi
    docker compose version >/dev/null 2>&1 || { [ -z "$compose_package" ] || need+=("$compose_package"); }
    docker buildx version >/dev/null 2>&1 || { [ -z "$buildx_package" ] || need+=("$buildx_package"); }
  elif [ "$NB_MANAGER" = apk ]; then
    command -v docker >/dev/null || need+=(docker)
    docker compose version >/dev/null 2>&1 || need+=(docker-cli-compose)
    docker buildx version >/dev/null 2>&1 || need+=(docker-cli-buildx)
  elif [ "$NB_MANAGER" = pacman ] || [ "$NB_MANAGER" = zypper ]; then
    command -v docker >/dev/null || need+=(docker)
    docker compose version >/dev/null 2>&1 || need+=(docker-compose)
    docker buildx version >/dev/null 2>&1 || need+=(docker-buildx)
  elif [ "$NB_MANAGER" = dnf ] || [ "$NB_MANAGER" = yum ]; then
    if ! command -v docker >/dev/null; then
      # Only add Docker's signed RPM repository when no engine is installed.
      nb_packages curl
      command="$NB_OS"; case "$command" in fedora|rhel) ;; *) command=centos ;; esac
      nb_download "https://download.docker.com/linux/$command/docker-ce.repo" /etc/yum.repos.d/northbot-docker.repo
      need+=(docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin)
    fi
  elif [ "$NB_KERNEL" = Darwin ]; then
    command -v docker >/dev/null || die 'Install and start Docker Desktop for Mac, then rerun this command.'
  fi
  if [ "$NO_DEPS" = 1 ]; then
    [ "${#need[@]}" = 0 ] || die 'Missing prerequisites; install them or rerun without --no-deps.'
  else nb_packages "${need[@]}"; fi
  for command in curl openssl rsync git pv; do command -v "$command" >/dev/null || die "Missing prerequisite: $command"; done
  if ! nb_repair_plugin compose; then
    [ "$NO_DEPS" != 1 ] || die 'Docker Compose is unavailable after dependency installation'
    [ "$NB_MANAGER" != apt ] || [ -z "$compose_package" ] || die "Docker Compose is unavailable after dependency installation (expected $compose_package)"
    nb_download_plugin compose || die 'Could not install a verified Compose plugin'
  fi
  if ! nb_repair_plugin buildx; then
    [ "$NO_DEPS" != 1 ] || die 'Docker Buildx is unavailable after dependency installation'
    [ "$NB_MANAGER" != apt ] || [ -z "$buildx_package" ] || die "Docker Buildx is unavailable after dependency installation (expected $buildx_package)"
    nb_download_plugin buildx || die 'Could not install a verified Buildx plugin'
  fi
}
