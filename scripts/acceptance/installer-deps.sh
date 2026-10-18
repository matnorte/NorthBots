#!/usr/bin/env bash
# Exercise the real installer's dependency bootstrap, then stop at the copy boundary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*)
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$ROOT"):/src:ro" ubuntu:24.04 bash -c '
    set -e; mkdir -p /work/scripts/acceptance
    cp /src/install.sh /work/
    cp /src/scripts/acceptance/installer-deps.sh /work/scripts/acceptance/
    bash /work/scripts/acceptance/installer-deps.sh
  '
  exit $?
esac
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/source" "$fixture/install"
export TEST_STATE="$fixture/state" TEST_LOG="$fixture/commands"
export PATH="$fixture/bin:$PATH"
printf 'NORTHBOT_MASTER_KEY=fixture-key\n' > "$fixture/install/.env"
for command in curl openssl git; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/bin/$command"
done
# The installer only needs apparent root until the deliberately failing copy step;
# all package/daemon commands are fakes, so Linux contributors can run unprivileged.
printf '#!/usr/bin/env bash\nprintf "0\\n"\n' > "$fixture/bin/id"
cat > "$fixture/bin/rsync" <<'EOF'
#!/usr/bin/env bash
printf 'copy reached\n' >> "$TEST_LOG"
exit 73
EOF
cat > "$fixture/bin/dpkg-query" <<'EOF'
#!/usr/bin/env bash
[ "${TEST_CE:-0}" = 1 ] || exit 1
printf 'install ok installed'
EOF
cat > "$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'buildx version') [ "${TEST_BUILDX:-0}" = 1 ] || [ -f "$TEST_STATE/buildx" ] ;;
  'compose version') [ "${TEST_COMPOSE:-1}" = 1 ] || [ -f "$TEST_STATE/compose" ] ;;
  'info') exit 0 ;;
  *) echo 'unexpected Docker call' >&2; exit 99 ;;
esac
EOF
cat > "$fixture/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'apt-get %s\n' "$*" >> "$TEST_LOG"
if [ "$1" = install ]; then
  [ "${TEST_APT_FAILURE:-0}" != 1 ] || exit 42
  for package in "$@"; do
    case "$package" in
      docker-buildx) [ "${TEST_CE:-0}" != 1 ] || exit 44 ;;
      docker-buildx-plugin) [ "${TEST_CE:-0}" = 1 ] || exit 44 ;;
      docker-compose-v2) [ "${TEST_CE:-0}" != 1 ] || exit 44 ;;
      docker-compose-plugin) [ "${TEST_CE:-0}" = 1 ] || exit 44 ;;
    esac
    case "$package" in
      docker-buildx|docker-buildx-plugin) [ "${TEST_BROKEN_PLUGIN:-0}" = 1 ] || touch "$TEST_STATE/buildx" ;;
      docker-compose-v2|docker-compose-plugin) touch "$TEST_STATE/compose" ;;
    esac
  done
fi
EOF
chmod +x "$fixture/bin/"*
run_installer() {
  mkdir -p "$TEST_STATE"
  rm -f "$TEST_STATE/buildx" "$TEST_STATE/compose"
  : > "$TEST_LOG"
  local result=0
  bash "$ROOT/install.sh" --domain localhost --email fixture@example.test --source "$fixture/source" \
    --dir "$fixture/install" --skip-cron > "$fixture/output" 2>&1 || result=$?
  [ "$(cat "$fixture/install/.env")" = 'NORTHBOT_MASTER_KEY=fixture-key' ]
  [ "$result" = "$1" ] || { cat "$fixture/output"; echo "expected exit $1, got $result" >&2; exit 1; }
}
export TEST_CE=0 TEST_BUILDX=0 TEST_COMPOSE=1
run_installer 73
grep -q 'apt-get install .*docker-buildx$' "$TEST_LOG"
! grep -q 'docker-compose\|docker-buildx-plugin' "$TEST_LOG"
grep -q 'copy reached' "$TEST_LOG"

export TEST_CE=1 TEST_COMPOSE=0
run_installer 73
grep -q 'apt-get install .*docker-compose-plugin docker-buildx-plugin$' "$TEST_LOG"
! grep -q 'docker-compose-v2' "$TEST_LOG"

export TEST_CE=0 TEST_COMPOSE=0
run_installer 73
grep -q 'apt-get install .*docker-compose-v2 docker-buildx$' "$TEST_LOG"

export TEST_COMPOSE=1 TEST_BUILDX=1
run_installer 73
! grep -q 'apt-get' "$TEST_LOG"

export TEST_BUILDX=0 TEST_APT_FAILURE=1
run_installer 42
! grep -q 'copy reached' "$TEST_LOG"
unset TEST_APT_FAILURE

export TEST_BROKEN_PLUGIN=1
run_installer 1
grep -q 'Docker Buildx is unavailable after dependency installation' "$fixture/output"
! grep -q 'copy reached' "$TEST_LOG"
echo 'INSTALLER DEPENDENCIES PASSED (6 scenarios)'
