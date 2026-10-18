#!/usr/bin/env bash
# Shared progress helpers; stdout belongs to the operation, diagnostics to stderr.
NB_PROGRESS="${NB_PROGRESS:-auto}"
NB_STEP=0 NB_STEPS="${NB_STEPS:-10}"
nb_log() { printf '[northbot] %s\n' "$*" >&2; }
nb_step() {
  NB_STEP=$((NB_STEP + 1))
  local filled=$(((NB_STEP - 1) * 20 / NB_STEPS)) bar='' i
  for ((i=0; i<20; i++)); do
    if [ "$i" -lt "$filled" ]; then bar="${bar}#"; else bar="${bar}-"; fi
  done
  [ "$NB_PROGRESS" = quiet ] || printf '[northbot] [%s] %d/%d stages complete — %s\n' "$bar" "$((NB_STEP - 1))" "$NB_STEPS" "$*" >&2
}
nb_complete() { [ "$NB_PROGRESS" = quiet ] || printf '[northbot] [####################] %d/%d stages complete\n' "$NB_STEPS" "$NB_STEPS" >&2; }
nb_run() {
  local label="$1" result=0; shift
  nb_log "$label"
  "$@" || result=$?
  [ "$result" = 0 ] || { nb_log "FAILED: $label (exit $result)"; return "$result"; }
}
nb_stream() {
  local size="$1" label="$2" args=()
  if command -v pv >/dev/null && [ "$NB_PROGRESS" != quiet ]; then
    args=(-f -p -t -e -b -r -N "$label")
    [ "$size" -le 0 ] || args+=(-s "$size")
    pv "${args[@]}"
  else
    [ "$NB_PROGRESS" = quiet ] || nb_log "$label (streaming; size ${size:-unknown} bytes)"
    cat
  fi
}
nb_file_bytes() { wc -c < "$1" | tr -d '[:space:]'; }
nb_download() {
  local url="$1" destination="$2"
  # Do not print URLs: signed download URLs can contain credentials.
  nb_log 'Downloading verified dependency'
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 \
    --retry 3 --progress-bar --output "$destination" "$url"
}
nb_wait() {
  local label="$1" attempts="$2" delay="$3" i; shift 3
  for ((i=1; i<=attempts; i++)); do
    if "$@" >/dev/null 2>&1; then nb_log "$label: ready"; return 0; fi
    [ "$NB_PROGRESS" = quiet ] || printf '[northbot] %s — waiting %ss / timeout %ss\n' "$label" "$(((i - 1) * delay))" "$((attempts * delay))" >&2
    [ "$i" = "$attempts" ] || sleep "$delay"
  done
  nb_log "$label: timed out"; return 1
}
