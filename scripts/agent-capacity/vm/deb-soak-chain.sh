#!/usr/bin/env bash
# Chain a test-artifact .deb build into a p2p join soak on GCP (plan agent-capacity-and-cost-gcp-2026-09-30,
# WI-10006497). This replaces the per-run ~/.cache/agent-capacity/c100*k/chain.sh copies. One of those
# parsed BUILD_EXIT= while build-test-deb.sh prints DEB_RC=, so c1007k aborted on a good build (2026-10-06).
#
#   1. wait for BUILD_UNIT (a systemd --user unit running build-test-deb.sh) to stop, if one is named;
#   2. require DEB_RC=0, an existing TEST_ARTIFACT_DEB, and MARKER <name> >= 1 for each REQUIRE_MARKERS name;
#   3. sha256 the archived .deb and upload it to $GCS_PREFIX/$RUN/$RUN.deb (no local copy: the archive keeps
#      the 10 most recent builds, so it cannot be pruned before the upload ends). The upload is retried
#      GCS_TRIES times: two gcloud processes starting together can crash one of them on its own credential
#      store ('database is locked'), which aborted c1010k on a good build (WI-10006787);
#   4. take this host's rig flock ($RIG_FLOCK), then the hive-git-physical-rig resource lock, retrying
#      RIG_TRIES times RIG_SLEEP_SEC apart. The flock is what keeps two chains apart: every chain acquires
#      the named lock as the same SU, and an exclusive lock is re-granted to its own holder, so c1010k got
#      the rig while c1010r still ran (WI-10006817). The named lock still excludes other sessions;
#   5. run p2p-join-soak.sh with RUN/DEB/SHA/RIG_LOCK/SU/AGENT_CAPACITY_OUT. Every other soak knob
#      (CONFLICT_AT_OBS, REVOKE, OBS_LIMIT, JOIN_BODY, ...) passes through the environment unchanged.
#      The soak releases the rig lock itself; the flock is released when this chain exits, and the soak
#      does not inherit it (fd 9 is closed for it), so nothing the soak leaves running can pin the rig.
# Each step appends one line to $OUT/chain.log. A failure logs "CHAIN_ABORT <reason>" and exits non-zero.
#
# Required env: RUN · BUILD_LOG (the build-test-deb.sh log) · SU (the su session id that holds the rig lock).
# Optional env: BUILD_UNIT (unset: no wait) · REQUIRE_MARKERS (space-separated marker names) ·
#   OUT (~/.cache/agent-capacity/$RUN) · GCS_PREFIX (gs://pc-agent-capacity-0930-artifacts) ·
#   RIG_TRIES (80) · RIG_SLEEP_SEC (30) · WAIT_POLL_SEC (30) · GCS_TRIES (4) · GCS_RETRY_SEC (15, times the
#   attempt number) · RIG_FLOCK (~/.cache/agent-capacity/rig.flock, waited on for RIG_TRIES*RIG_SLEEP_SEC).
# Exit: the soak's own exit code once it ran · 2 usage · 3 build not usable · 4 hash/upload failed ·
#   5 rig flock or rig lock not acquired.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd) || exit 2
RUN=${RUN:-}; BUILD_LOG=${BUILD_LOG:-}; SU=${SU:-}
if [ -z "$RUN" ] || [ -z "$BUILD_LOG" ] || [ -z "$SU" ]; then
  echo "USAGE: RUN=<name> BUILD_LOG=<build-test-deb.sh log> SU=<su id> [BUILD_UNIT=<unit>] [REQUIRE_MARKERS='a b'] $0" >&2
  exit 2
fi
OUT=${OUT:-$HOME/.cache/agent-capacity/$RUN}
GCS_PREFIX=${GCS_PREFIX:-gs://pc-agent-capacity-0930-artifacts}
RIG_TRIES=${RIG_TRIES:-80}; RIG_SLEEP_SEC=${RIG_SLEEP_SEC:-30}; WAIT_POLL_SEC=${WAIT_POLL_SEC:-30}
GCS_TRIES=${GCS_TRIES:-4}; GCS_RETRY_SEC=${GCS_RETRY_SEC:-15}
RIG_FLOCK=${RIG_FLOCK:-$HOME/.cache/agent-capacity/rig.flock}
REQUIRE_MARKERS=${REQUIRE_MARKERS:-}
mkdir -p "$OUT" || exit 2
cd "$ROOT" || exit 2
CHAIN="$OUT/chain.log"
ts() { date -u +%FT%TZ; }
say() { echo "$* $(ts)" >> "$CHAIN"; }
abort() { local code=$1; shift; say "CHAIN_ABORT $*"; exit "$code"; }

say "CHAIN_WAIT unit=${BUILD_UNIT:-none}"
if [ -n "${BUILD_UNIT:-}" ]; then
  while systemctl --user is-active -q "$BUILD_UNIT"; do sleep "$WAIT_POLL_SEC"; done
fi
[ -f "$BUILD_LOG" ] || abort 3 "build not usable: no build log at $BUILD_LOG"

# build-test-deb.sh's contract (deb-soak-chain.test.ts pins it against that script's source):
# "SIDECAR_RC=<n> <ts>", "DEB_RC=<n> <ts>", "MARKER <name>=<count>", and build-and-archive-deb.sh's
# "TEST_ARTIFACT_DEB=<path>". The last line wins, because a resumed build appends to the same log.
last() { awk -v k="$1" 'index($0, k) == 1 { v = substr($0, length(k) + 1) } END { print v }' "$BUILD_LOG"; }
first_word() { local v; v=$(last "$1"); echo "${v%% *}"; }
rc=$(first_word 'DEB_RC=')
deb=$(last 'TEST_ARTIFACT_DEB=')
say "CHAIN_BUILD deb_rc=${rc:-absent} sidecar_rc=$(first_word 'SIDECAR_RC=') deb=${deb:-absent}"
[ "${rc:-x}" = 0 ] || abort 3 "build not usable: DEB_RC=${rc:-absent} (see $BUILD_LOG)"
[ -n "$deb" ] && [ -f "$deb" ] || abort 3 "build not usable: TEST_ARTIFACT_DEB=${deb:-absent} is not a file"
for m in $REQUIRE_MARKERS; do
  n=$(last "MARKER $m=")
  case "$n" in '' | *[!0-9]*) abort 3 "build not usable: MARKER $m=${n:-absent}" ;; esac
  [ "$n" -ge 1 ] || abort 3 "build not usable: MARKER $m=$n"
done
say "CHAIN_MARKERS ok=${REQUIRE_MARKERS:-none}"

SHA=$(sha256sum "$deb" | cut -d' ' -f1)
[ "${#SHA}" = 64 ] || abort 4 "sha256 of $deb failed"
say "DEB_SHA256 $SHA"
DEB="$GCS_PREFIX/$RUN/$RUN.deb"
uploaded=
for i in $(seq 1 "$GCS_TRIES"); do
  if gcloud storage cp "$deb" "$DEB" --no-user-output-enabled 2> "$OUT/upload.err"; then uploaded=1; break; fi
  say "CHAIN_UPLOAD_RETRY try=$i/$GCS_TRIES $(tail -n 1 "$OUT/upload.err" | cut -c1-200)"
  [ "$i" -lt "$GCS_TRIES" ] && sleep "$((GCS_RETRY_SEC * i))"
done
[ -n "$uploaded" ] || abort 4 "upload to $DEB failed after $GCS_TRIES tries (see $OUT/upload.err)"
say "DEB_UPLOADED $DEB"

mkdir -p "$(dirname "$RIG_FLOCK")" || abort 5 "cannot create the directory of $RIG_FLOCK"
exec 9>> "$RIG_FLOCK" || abort 5 "cannot open $RIG_FLOCK"
say "RIG_FLOCK_WAIT $RIG_FLOCK"
flock -w "$((RIG_TRIES * RIG_SLEEP_SEC))" 9 || abort 5 "rig flock $RIG_FLOCK still held by another chain after $((RIG_TRIES * RIG_SLEEP_SEC))s"
say "RIG_FLOCK_HELD $RIG_FLOCK"

mcp() { env -u CLAUDE_CODE_SESSION_ID node scripts/mcp-call.mjs "$@" --client "$SU"; }
LOCK=
for _ in $(seq 1 "$RIG_TRIES"); do
  mcp locks:acquire_resource \
    "{\"resource\":\"hive-git-physical-rig\",\"mode\":\"exclusive\",\"ttl_sec\":3600,\"reason\":\"$RUN p2p join soak (deb-soak-chain.sh), $SU\"}" \
    > "$OUT/rig-acquire.out" 2>&1
  LOCK=$(grep -oE '"lock_id": ?"[^"]+"' "$OUT/rig-acquire.out" | head -n 1 | sed -E 's/.*"([^"]+)"$/\1/')
  [ -n "$LOCK" ] && break
  sleep "$RIG_SLEEP_SEC"
done
say "RIG_LOCK ${LOCK:-none}"
[ -n "$LOCK" ] || abort 5 "rig lock not acquired after $RIG_TRIES tries (see $OUT/rig-acquire.out)"

RUN="$RUN" DEB="$DEB" SHA="$SHA" RIG_LOCK="$LOCK" SU="$SU" AGENT_CAPACITY_OUT="$OUT" \
  bash scripts/agent-capacity/vm/p2p-join-soak.sh 9>&- > "$OUT/run.log" 2>&1
soak_rc=$?
say "CHAIN_SOAK_EXIT=$soak_rc"
exit "$soak_rc"
