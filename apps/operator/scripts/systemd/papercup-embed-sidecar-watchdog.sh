#!/usr/bin/env bash
# papercup-embed-sidecar-watchdog.sh — WI-4021 / EI-25222670171204378
#
# Fired every 60s by papercup-embed-sidecar-watchdog.timer. /healthz is answered
# directly by the sidecar's HTTP handler and can stay green while the embed
# worker is wedged, so this probes the real /embed path with the LRU bypassed
# and requires one returned vector plus exact per-request inference accounting.
#
# Three rules decide whether a failed probe restarts the sidecar:
#
# 1. STARTUP GRACE. papercup-embed-sidecar.service is Type=simple, so systemd
#    marks it active the instant node starts — before it listens on :3384 and
#    long before gemma/harrier/rerank are warm. A probe in that window fails
#    with "connection refused" against a healthy, starting process. Skip the
#    probe until the unit has been active for EMBED_WATCHDOG_STARTUP_GRACE_SEC.
#
# 2. NON-BLOCKING RESTART. `systemctl restart` waits for the whole start job,
#    including a slow ExecStartPre bundle (an npm-install mutex wait plus
#    esbuild measured ~2.5 min). The timer fires during that wait; systemd runs
#    the queued watchdog the moment the restart returns, which is the moment the
#    sidecar turns active and is not yet listening. That probe failed and
#    restarted it again: four restarts in five minutes on 2026-10-06 with
#    embeddings down throughout. `--no-block` returns at once, so the next
#    probe sees the unit `activating` (not active) and then the grace window.
#
# 3. CONSECUTIVE FAILURES. A dead or wedged worker fails every probe; a live
#    worker slowed by GPU or CPU contention misses one deadline and recovers.
#    Restart only after EMBED_WATCHDOG_FAILURE_THRESHOLD consecutive failed
#    probes. Any passing probe, or a skipped one, resets the count.
#
# Saturation alone cannot distinguish busy from wedged. Defer a failed probe
# only when successful gemma query inference advances in the same process.
#
# Everything external is overridable so the behaviour can be tested with stubs.
set -uo pipefail

SYSTEMCTL="${EMBED_WATCHDOG_SYSTEMCTL:-systemctl}"
CURL="${EMBED_WATCHDOG_CURL:-curl}"
JQ="${EMBED_WATCHDOG_JQ:-jq}"
UNIT="${EMBED_WATCHDOG_UNIT:-papercup-embed-sidecar.service}"
BASE_URL="${EMBED_WATCHDOG_BASE_URL:-http://127.0.0.1:3384}"
GRACE_SEC="${EMBED_WATCHDOG_STARTUP_GRACE_SEC:-180}"
THRESHOLD="${EMBED_WATCHDOG_FAILURE_THRESHOLD:-2}"
PROBE_TIMEOUT_SEC="${EMBED_WATCHDOG_PROBE_TIMEOUT_SEC:-15}"
STATE_FILE="${EMBED_WATCHDOG_STATE_FILE:-${XDG_RUNTIME_DIR:-/tmp}/papercup-embed-sidecar-watchdog.failures}"
PROGRESS_FILE="${STATE_FILE}.progress"
NOW_EPOCH="${EMBED_WATCHDOG_NOW_EPOCH:-$(date +%s)}"

reset_failures() {
  printf '0' > "$STATE_FILE" 2>/dev/null || true
}

read_failures() {
  local n
  n="$(cat -- "$STATE_FILE" 2>/dev/null || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s' "$n"
}

if ! "$SYSTEMCTL" --user is-active --quiet "$UNIT"; then
  # Stopped, failed, or still in ExecStartPre: systemd's own Restart= policy
  # owns those states. Probing here is what turned a slow start into a loop.
  reset_failures
  rm -f -- "$PROGRESS_FILE"
  exit 0
fi

# `--timestamp=unix` prints "@<epoch>"; empty when systemd has no record.
entered="$("$SYSTEMCTL" --user show --timestamp=unix -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null || true)"
entered="${entered#@}"
if [[ "$entered" =~ ^[0-9]+$ ]] && (( NOW_EPOCH - entered < GRACE_SEC )); then
  echo "embed sidecar active for $(( NOW_EPOCH - entered ))s (< ${GRACE_SEC}s startup grace) — skipping probe"
  reset_failures
  rm -f -- "$PROGRESS_FILE"
  exit 0
fi

payload='{"model":"gemma","kind":"query","texts":["papercup-embed-sidecar-watchdog"],"bypassCache":true}'
if "$CURL" -fsS --max-time "$PROBE_TIMEOUT_SEC" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    "$BASE_URL/embed" \
  | "$JQ" -e '(.vectors | arrays | length == 1 and (.[0] | arrays | length > 0)) and (.cache | .hits == 0 and .coalesced == 0 and .inferred == 1)' >/dev/null; then
  reset_failures
  rm -f -- "$PROGRESS_FILE"
  exit 0
fi

health="$("$CURL" -fsS --max-time 2 "$BASE_URL/healthz" 2>/dev/null || true)"
progress="$(printf '%s' "$health" | "$JQ" -er '
  select(.ok == true and .workers.embedder.alive == true and .queue.saturated == true and .queue.depth > 0)
  | [.pid, .uptimeMs, .inferenceProgress["gemma:query"].completed]
  | select(all(.[]; type == "number" and . >= 0 and floor == .))
  | @tsv' 2>/dev/null || true)"
if [[ -n "$progress" ]]; then
  read -r pid uptime completed <<< "$progress"
  previous="$(cat -- "$PROGRESS_FILE" 2>/dev/null || true)"
  previous_pid='' previous_uptime='' previous_completed=''
  read -r previous_pid previous_uptime previous_completed <<< "$previous"
  printf '%s\n' "$progress" > "$PROGRESS_FILE"
  if [[ "$previous_pid" == "$pid" && "$previous_uptime" =~ ^[0-9]+$ && "$previous_completed" =~ ^[0-9]+$ ]] \
      && (( uptime >= previous_uptime && completed > previous_completed )); then
    reset_failures
    echo 'embed worker probe failed while successful gemma query inference advances — deferring restart'
    exit 0
  fi
else
  rm -f -- "$PROGRESS_FILE"
fi

failures=$(( $(read_failures) + 1 ))
if (( failures < THRESHOLD )); then
  printf '%s' "$failures" > "$STATE_FILE"
  echo "embed worker probe failed (${failures}/${THRESHOLD} consecutive) — not restarting yet"
  exit 0
fi

reset_failures
rm -f -- "$PROGRESS_FILE"
echo "embed worker probe failed (${failures}/${THRESHOLD} consecutive) — restarting papercup-embed-sidecar"
"$SYSTEMCTL" --user restart --no-block "$UNIT"
