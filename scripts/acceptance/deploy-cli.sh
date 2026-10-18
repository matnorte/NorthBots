#!/usr/bin/env bash
# Deterministic CLI failure tests. Docker/curl are faked; the real archive and rollback code runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*)
  # NTFS does not implement Unix mode 600 or symlinks as required by production backups.
  # Run every assertion on Ubuntu's native filesystem instead of relaxing any check.
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$ROOT"):/src:ro" ubuntu:24.04 bash -c '
    set -e; mkdir -p /work/deploy /work/scripts/acceptance
    cp /src/deploy/northbot /work/deploy/
    cp /src/scripts/acceptance/deploy-cli.sh /work/scripts/acceptance/
    bash /work/scripts/acceptance/deploy-cli.sh
  '
  exit $?
esac
mkdir -p "$ROOT/test-results"
fixture="$(mktemp -d "$ROOT/test-results/deploy-cli.XXXXXX")"
case "$(realpath "$fixture")" in "$ROOT"/test-results/deploy-cli.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/install/deploy" "$fixture/payload"
export NORTHBOT_DIR="$fixture/install" TEST_LOG="$fixture/commands" TEST_STATE="$fixture/state"
export PATH="$fixture/bin:$PATH"
printf 'old runtime config\n' > "$NORTHBOT_DIR/docker-compose.yml"
printf 'NORTHBOT_MASTER_KEY=fixture-key\n' > "$NORTHBOT_DIR/.env"
cat > "$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
case "$*" in
  *pg_dump*) printf 'fixture database dump'; exit 0 ;;
  *pg_restore*) cat >/dev/null; exit 0 ;;
  *'ps -q '*) printf 'running-container'; exit 0 ;;
  'inspect --format '*) printf 'sha256:actually-running'; exit 0 ;;
  *' build '*) [ "${TEST_FAIL:-}" != build ] || exit 1 ;;
  *' up -d') [ "${TEST_FAIL:-}" != up ] || exit 1 ;;
esac
exit 0
EOF
cat > "$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in *bad-health*) exit 1 ;; esac
printf '{"status":"ok"}'
EOF
cat > "$fixture/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$fixture/bin/rsync" <<'EOF'
#!/usr/bin/env bash
printf 'new runtime config\n' > "$NORTHBOT_DIR/docker-compose.yml"
[ "${TEST_FAIL:-}" != source ]
EOF
chmod +x "$fixture/bin/"*
cli=(bash "$ROOT/deploy/northbot")

# Replacing a pre-existing permissive file must never overwrite through its symlink.
printf 'keep me' > "$fixture/outside"
ln -s "$fixture/outside" "$fixture/backup.tar.gz"
"${cli[@]}" backup "$fixture/backup.tar.gz" >/dev/null
[ "$(cat "$fixture/outside")" = 'keep me' ]
[ ! -L "$fixture/backup.tar.gz" ]
[ "$(stat -c %a "$fixture/backup.tar.gz")" = 600 ]
"${cli[@]}" restore "$fixture/backup.tar.gz" --database restored_copy >/dev/null

# An archive must not write arbitrary files, even when restore was explicitly confirmed.
printf 'malicious' > "$fixture/payload/escape"
tar -czf "$fixture/malicious.tar.gz" --transform='s|escape|../escape|' -C "$fixture/payload" escape
: > "$TEST_LOG"
if "${cli[@]}" restore "$fixture/malicious.tar.gz" --yes > "$fixture/result" 2>&1; then
  echo 'unsafe archive accepted' >&2; exit 1
fi
grep -q 'unexpected archive member' "$fixture/result"
[ ! -e "$fixture/escape" ]
! grep -q 'dropdb' "$TEST_LOG"

for failure in source build up health; do
  export TEST_FAIL="$failure"
  : > "$TEST_LOG"
  printf 'old runtime config\n' > "$NORTHBOT_DIR/docker-compose.yml"
  args=(update --source "$fixture/payload")
  [ "$failure" != health ] || args+=(--health-url http://127.0.0.1/bad-health)
  if "${cli[@]}" "${args[@]}" > "$fixture/result" 2>&1; then
    echo "failed $failure update returned success" >&2; exit 1
  fi
  grep -q 'rolled back to the previous version' "$fixture/result"
  grep -q 'tag sha256:actually-running northbot/server:rollback' "$TEST_LOG"
  grep -q 'tag northbot/server:rollback northbot/server:latest' "$TEST_LOG"
  grep -q 'up -d --no-build --force-recreate' "$TEST_LOG"
  [ "$(cat "$NORTHBOT_DIR/docker-compose.yml")" = 'old runtime config' ]
done
unset TEST_FAIL
echo 'Deployment CLI regressions PASS (private backup, safe restore, source/build/start/health rollback)'
