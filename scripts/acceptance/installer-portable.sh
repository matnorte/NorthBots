#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*)
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$ROOT"):/src:ro" ubuntu:24.04 bash /src/scripts/acceptance/installer-portable.sh
  exit $?
esac
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
export HOME="$fixture/home" DOCKER_CONFIG="$fixture/home/.docker" TEST_LOG="$fixture/log"
mkdir -p "$fixture/bin" "$HOME"
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) printf '%s\n' "${TEST_KERNEL:-Linux}" ;; -m) printf '%s\n' "${TEST_ARCH:-x86_64}" ;; esac
EOF
cat > "$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ ! -e "$DOCKER_CONFIG/cli-plugins/docker-buildx" ] || "$DOCKER_CONFIG/cli-plugins/docker-buildx" version
EOF
chmod +x "$fixture/bin/"*
die() { printf '%s\n' "$*" >&2; exit 1; }
. "$ROOT/deploy/lib/progress.sh"
. "$ROOT/deploy/lib/platform.sh"
export TEST_KERNEL=Linux TEST_ARCH=x86_64
for pair in ubuntu:apt debian:apt alpine:apk arch:pacman opensuse-tumbleweed:zypper fedora:yum; do
  os="${pair%%:*}" manager="${pair#*:}"
  printf 'ID=%s\nID_LIKE=\nVERSION_ID=1\n' "$os" > "$fixture/os-release"
  nb_detect_platform "$fixture/os-release"
  # Fedora uses dnf if the test host already has it, otherwise yum.
  if [ "$os" = fedora ] && command -v dnf >/dev/null; then manager=dnf; fi
  [ "$NB_MANAGER" = "$manager" ] && [ "$NB_ARCH" = amd64 ]
done
export TEST_KERNEL=Darwin TEST_ARCH=arm64
nb_detect_platform; [ "$NB_OS" = macos ] && [ "$NB_ARCH" = arm64 ]
export TEST_KERNEL=Linux TEST_ARCH=riscv64
if (nb_detect_platform "$fixture/os-release") > "$fixture/error" 2>&1; then exit 1; fi
grep -q 'Unsupported CPU' "$fixture/error"
export TEST_ARCH=x86_64
for manager in apt dnf yum apk pacman zypper brew; do
  for executable in apt-get dnf yum apk pacman zypper brew; do
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$TEST_LOG"\n' > "$fixture/bin/$executable"
    chmod +x "$fixture/bin/$executable"
  done
  : > "$TEST_LOG"; NB_MANAGER="$manager"
  nb_packages fixture-package >/dev/null 2>&1
  grep -q 'fixture-package' "$TEST_LOG"
done
mkdir -p "$DOCKER_CONFIG/cli-plugins" "$fixture/packaged"
printf 'not an executable for this CPU\n' > "$DOCKER_CONFIG/cli-plugins/docker-buildx"
cp "$DOCKER_CONFIG/cli-plugins/docker-buildx" "$fixture/original"
printf '#!/usr/bin/env bash\nprintf "buildx fixture\\n"\n' > "$fixture/packaged/docker-buildx"
chmod +x "$fixture/packaged/docker-buildx"
nb_repair_plugin buildx "$fixture/packaged/docker-buildx"
saved=("$DOCKER_CONFIG"/northbot-plugin-backups/buildx.*/docker-buildx)
[ "${#saved[@]}" = 1 ]; cmp "$fixture/original" "${saved[0]}"
docker buildx version >/dev/null

printf 'binary\000data\377\n' > "$fixture/payload"
NB_PROGRESS=plain nb_stream "$(nb_file_bytes "$fixture/payload")" 'Test stream' < "$fixture/payload" > "$fixture/copied"
cmp "$fixture/payload" "$fixture/copied"
NB_STEP=0 NB_STEPS=2
{ nb_step 'First'; nb_step 'Second'; nb_complete; } 2> "$fixture/progress"
grep -q '0/2 stages complete' "$fixture/progress"
grep -q '1/2 stages complete' "$fixture/progress"
grep -q '2/2 stages complete' "$fixture/progress"
if nb_run 'Expected command failure' bash -c 'exit 19' > "$fixture/output" 2>&1; then exit 1; else [ "$?" = 19 ]; fi
grep -q 'FAILED: Expected command failure' "$fixture/output"
mkdir -p "$fixture/source"; printf 'services: {}\n' > "$fixture/source/docker-compose.yml"
for target in / "$fixture/source/nested"; do
  if bash "$ROOT/install.sh" --email fixture@example.test --source "$fixture/source" --dir "$target" > "$fixture/error" 2>&1; then exit 1; fi
  grep -qE 'dedicated installation directory|inside the source checkout' "$fixture/error"
done
echo 'PORTABLE INSTALLER PASSED (platforms, package managers, plugin recovery, binary streams, stages, failures and path guards)'
