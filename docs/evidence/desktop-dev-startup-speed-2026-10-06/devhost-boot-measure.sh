#!/usr/bin/env bash
# P-001 of plan desktop-dev-startup-speed-2026-10-06: time the attended dev
# operator boot (papercusp-desktop/bin/dev-operator-ifneeded.sh) on a spare
# port, three ways, interleaved so load drift hits every variant alike:
#   tsx   — today's default (`npx tsx bin/hono-host.ts`)
#   fresh — bundle-host.sh build (timed separately) + plain-node boot
#   warm  — plain-node boot of the bundle the previous `fresh` round left
# Each boot is timed from launching the wrapper to the first HTTP 200 on
# /api/health and on / (what the desktop window loads). Load average is
# recorded at the start and end of every timed step.
set -uo pipefail
ROOT=~/papercupai-workspace/papercusp
PORT="${PORT:-3390}"
ROUNDS="${ROUNDS:-3}"
OUT="${OUT:-$ROOT/.papercusp/scratch/devhost-measure}"
BUNDLE="$ROOT/apps/operator/dist-devhost/hono-host.mjs"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-900}"
mkdir -p "$OUT" || exit 1
RESULTS="$OUT/results.tsv"
[ -f "$RESULTS" ] || printf 'utc\tround\tvariant\tstep\tstatus\tseconds\tload_start\tload_end\tlog\n' >"$RESULTS"

now() { date +%s.%N; }
load() { cut -d' ' -f1-3 /proc/loadavg | tr ' ' '/'; }
code_of() { curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT$1" 2>/dev/null || true; }
port_busy() { ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; }
record() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$@" >>"$RESULTS"; }

if port_busy; then echo "port $PORT busy — refusing" >&2; exit 2; fi

build_bundle() {
  local round=$1 log="$OUT/r$1-build.log" ls t0 t1 st=ok
  ls=$(load); t0=$(now)
  ( cd "$ROOT/apps/operator" && bash bin/bundle-host.sh bin/hono-host.ts "$BUNDLE" ) >"$log" 2>&1 || st="fail:$?"
  t1=$(now)
  record "$round" fresh build "$st" "$(echo "$t1 - $t0" | bc)" "$ls" "$(load)" "$log"
  [ "$st" = ok ] && [ -s "$BUNDLE" ]
}

boot_once() {
  local round=$1 variant=$2 entry=$3 log="$OUT/r$1-$2-boot.log" ls t0 pid t_health="" t_root="" st=timeout
  ls=$(load); t0=$(now)
  if [ -n "$entry" ]; then
    setsid env OPERATOR_DEV_PORT="$PORT" PAPERCUSP_DEV_HOST_ENTRY="$entry" \
      bash -c 'cd "$1" && exec bash bin/dev-operator-ifneeded.sh' _ "$ROOT/papercusp-desktop" >"$log" 2>&1 </dev/null &
  else
    setsid env OPERATOR_DEV_PORT="$PORT" \
      bash -c 'cd "$1" && exec bash bin/dev-operator-ifneeded.sh' _ "$ROOT/papercusp-desktop" >"$log" 2>&1 </dev/null &
  fi
  pid=$!
  while :; do
    local el; el=$(echo "$(now) - $t0" | bc)
    if [ -z "$t_health" ] && [ "$(code_of /api/health)" = 200 ]; then t_health=$el; fi
    if [ -z "$t_root" ] && [ "$(code_of /)" = 200 ]; then t_root=$el; fi
    if [ -n "$t_health" ] && [ -n "$t_root" ]; then st=ok; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then st=died; break; fi
    if [ "${el%.*}" -ge "$BOOT_TIMEOUT" ]; then st=timeout; break; fi
    sleep 0.5
  done
  local le; le=$(load)
  record "$round" "$variant" health "$st" "${t_health:-NA}" "$ls" "$le" "$log"
  record "$round" "$variant" root "$st" "${t_root:-NA}" "$ls" "$le" "$log"
  # The wrapper's own trap reaps its supervised process group on TERM.
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 120); do port_busy || break; sleep 0.5; done
  if port_busy; then echo "port $PORT still busy after teardown — aborting" >&2; exit 3; fi
  sleep 5
}

for round in $(seq 1 "$ROUNDS"); do
  boot_once "$round" tsx ""
  if build_bundle "$round"; then
    boot_once "$round" fresh "$BUNDLE"
    boot_once "$round" warm "$BUNDLE"
  fi
done
echo DONE >>"$OUT/done"
