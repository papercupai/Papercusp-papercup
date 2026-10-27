#!/usr/bin/env bash
# bin/reclaim-docker-disk.sh
#
# Reclaim unbounded Docker disk growth on the dev box (WI-39305).
#
# WHY: this host's root filesystem (/dev/nvme0n1p2, ext4 1.9T) holds BOTH $HOME
# and PGDATA, and it filled to 99% (24 GiB free) over ~2 days while a monitor
# filed three successive CRITICAL work-items — WI-38595 (90%), WI-38973 (95%),
# WI-39305 (99%) — that nobody could durably close, because the only available
# response was a one-time manual prune. `packages/operator-core/lib/storage/
# disk-space-alarm.ts` DETECTS the condition but is read-only by construction
# (its own header records it firing 318 times over 8 days while the box sat
# under 1% free, with nothing consuming the toast — EI-20092729937622838). A
# detector with no actor on the other end is not a guard; this script is the
# missing actor.
#
# Measured 2026-08-15: /var/lib/docker had grown to 158 GiB, of which ~84 GiB
# was pure garbage — 34.85 GB of build cache with ZERO active references, 30
# unreferenced images, and 143 orphaned ANONYMOUS volumes. Reclaiming it took
# free space from 22.8 GiB to 102.7 GiB with all 103 running containers
# (sidestage stack, 10 bytebot agents, typesense, redis, testcontainer PGs)
# staying up and healthy. None of that garbage had any mechanism reclaiming it.
#
# Deliberately a systemd timer, NOT a DBOS scheduled workflow and NOT an
# in-process operator tick (dbos-scheduler-consolidation-2026-06-03 D-004 /
# EI-1622): this is dev-box host-level infra hygiene, not product behavior —
# the same reasoning as papercup-testvm-reaper.service,
# papercup-vitest-orphan-reaper.service and papercup-webkit-reaper.service.
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY CONTRACT — the parts that matter more than the bytes reclaimed:
#
#   - NEVER `docker volume prune`. That verb deletes every dangling volume,
#     NAMED ONES INCLUDED. On this box 11 of the 154 dangling volumes were
#     named persistent application data — bytebot_postgres_data, the
#     bytebot-pool_bytebot-N-postgres-data set, automaker-*, sheets-clone*,
#     restart_* (odoo/plane/twenty/outline/chatwoot/vikunja/appflowy),
#     litellm_litellm_pgdata, sidestage_*, stalwart-agenticmail-data. Several
#     back services that were merely not running at that moment. A blanket
#     prune would have silently destroyed all of them.
#     => This script removes ONLY volumes whose name matches ^[0-9a-f]{64}$,
#        i.e. Docker's ANONYMOUS volume ids, which are ephemeral by definition
#        (testcontainers creates and abandons these constantly). Any volume a
#        human or a compose file NAMED is never a candidate, full stop.
#
#   - NEVER touch running containers or in-use images. Docker itself refuses,
#     but the age filters below mean we do not even try: an image or cache
#     layer that a live build/test is using is by definition recent.
#     The ONE exception is step 4: a container labelled org.testcontainers=true
#     that has gone unused past an idle threshold AND has no established
#     connection (WI-6554700010009309). No other container is ever a candidate.
#
#   - AGE FILTERS, so an in-flight build or test suite is never disturbed.
#     Another agent may be mid-`docker build` or mid-integration-test on this
#     shared box at any moment. Cache younger than BUILD_CACHE_MAX_AGE and
#     images younger than IMAGE_MAX_AGE are left alone; an anonymous volume
#     younger than VOLUME_MAX_AGE_SECS is left alone. Nothing here races a
#     concurrent run.
#
#   - REPORT THE `df` DELTA, NEVER DOCKER'S NUMBER. Docker's "Total reclaimed
#     space" is a logical figure that overstates the disk actually returned
#     (measured 2026-08-15: builder prune claimed 34.85GB, df showed 23.89 GiB;
#     image prune claimed 33.95GB, df showed 32.17 GiB). Sharing and sparse
#     allocation account for the gap. `df -B1` before/after is the authority —
#     and the SAME instrument is used for both readings, never two different
#     ones (comparing a `du -sh` to a `du -sb`, or docker's figure to df's,
#     manufactures progress out of nothing).
#
#   - NEVER fail the timer. Every step is best-effort; a docker daemon that is
#     down, wedged, or not installed makes this a logged no-op, exactly like
#     its sibling reapers.
#
# Knobs (all optional):
#   DRY_RUN=1                 preview every action, change nothing
#   BUILD_CACHE_MAX_AGE=24h   build cache older than this is evicted
#   IMAGE_MAX_AGE=168h        unreferenced images older than this are removed
#   VOLUME_MAX_AGE_SECS=86400 anonymous dangling volumes older than this go
#   SKIP_IMAGES=1             skip the image sweep (keep re-pull cost at zero)
#   SKIP_TESTCONTAINERS=1     skip the leaked-testcontainer sweep (step 4)
#   TESTCONTAINER_IDLE_MAX_SECS=18000  a testcontainer unused this long with no
#                             established connection is removed (floor 3600;
#                             5 h so the hourly tick keeps every leak under 6 h)
#   PAPERCUSP_TESTCONTAINERS_LAST_USED_DIR  last-use marker dir (default
#                             /tmp/pcv/testcontainers-last-used, shared with
#                             libs/test-config)
#   RECLAIM_MIN_FREE_PCT=100  only sweep when free% is below this (default 100
#                             = always sweep; the age filters already make a
#                             healthy box a cheap no-op)
#   CONTAINER_STORE_MAX_BYTES=21474836480  allocated-byte cap per physical store;
#                             excess that native guards retain is reported, never
#                             removed by walking a manager-owned layout
#
# Run hourly via the papercup-docker-reclaim.timer systemd user timer.
# The same actor also covers Podman's separate rootless/rootful image stores.
# Podman images use IMAGE_MAX_AGE and native container/build reference protection;
# never pass --external or prune Podman containers/volumes/system storage.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DRY_RUN="${DRY_RUN:-0}"
BUILD_CACHE_MAX_AGE_EXPLICIT="${BUILD_CACHE_MAX_AGE:-}"
IMAGE_MAX_AGE_EXPLICIT="${IMAGE_MAX_AGE:-}"
BUILD_CACHE_MAX_AGE="${BUILD_CACHE_MAX_AGE:-24h}"
IMAGE_MAX_AGE="${IMAGE_MAX_AGE:-168h}"
VOLUME_MAX_AGE_SECS="${VOLUME_MAX_AGE_SECS:-86400}"
SKIP_IMAGES="${SKIP_IMAGES:-0}"
RECLAIM_MIN_FREE_PCT="${RECLAIM_MIN_FREE_PCT:-100}"
TARGET_FS="${TARGET_FS:-/}"
CONTAINER_STORE_MAX_BYTES="${CONTAINER_STORE_MAX_BYTES:-21474836480}"

log() { printf '[docker-reclaim] %s\n' "$*"; }

# Native managers may remove any unreferenced object in their store. Protect
# the whole actual store on a descendant pin, and serialize the final read
# through the last native command with storage:pin's existing mutex/parser.
PIN_GUARD_INPUT=''
PIN_GUARD_PID=''
PIN_GUARD_OUTPUT=''
STORE_NATIVE_FAILURES=0
STORE_SKIP_REASON=''
declare -A SEEN_CONTAINER_STORES=()
container_pin_guard_release() {
  if [[ -n "$PIN_GUARD_INPUT" ]]; then
    local receipt
    printf '%s\t%s\n' "$STORE_NATIVE_FAILURES" "$STORE_SKIP_REASON" >&"$PIN_GUARD_INPUT" || true
    exec {PIN_GUARD_INPUT}>&-
    if IFS= read -r receipt <&"$PIN_GUARD_OUTPUT"; then
      log "store-receipt $receipt"
    else
      log 'store-receipt {"complete":false,"status":"guard-receipt-failed"}'
    fi
    exec {PIN_GUARD_OUTPUT}<&-
    wait "$PIN_GUARD_PID" || true
    PIN_GUARD_INPUT=''; PIN_GUARD_PID=''; PIN_GUARD_OUTPUT=''
  fi
}
trap container_pin_guard_release EXIT

container_pin_guard_acquire() {
  local label="$1" root="$2" module output input readiness identity
  STORE_NATIVE_FAILURES=0; STORE_SKIP_REASON=''
  [[ "$root" == /* && "$root" != *$'\n'* && "$root" != *$'\r'* && "$root" != *$'\t'* ]] || {
    log "retention pin admission failed: $label storage root unavailable — skipping store"
    printf '[docker-reclaim] store-receipt {"store":"%s","status":"discovery-failed","complete":false,"measurementComplete":false}\n' "$label"
    return 1
  }
  # The unit runs a snapshot COPY under $TMPDIR, so a climb out of this script's own
  # path lands in the snapshot, not the checkout. papercup-docker-reclaim.service pins
  # PAPERCUSP_REPO_ROOT; the self-located default serves a direct run (WI-10006358).
  module="${PAPERCUSP_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/lib/retention-pins.mjs"
  coproc CONTAINER_PIN_GUARD {
    exec node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      import { realpathSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      import { isAbsolute, normalize } from "node:path";
      const released = new Promise(resolve => {
        process.stdin.once("end", () => resolve("1\taborted"));
        process.stdin.once("data", data => resolve(String(data)));
        process.stdin.resume();
      });
      const root = process.argv[2], store = process.argv[3];
      const maxBytes = Number(process.argv[4]);
      const receipt = { store, root, maxBytes, measurementComplete: false, complete: false,
        nativeFailures: 0, evictionOrder: "native-unverified" };
      const privileged = store === "podman-rootful" || store === "docker";
      // This is a read-only, bounded, no-follow allocated-inode census. Native
      // managers retain exclusive authority to delete their internal layouts.
      const census = String.raw`
import os, sys, json, stat, time
request = json.load(sys.stdin)
root, pins = request["root"], request["pins"]
deadline = time.monotonic() + 30
seen, pinned_seen = {}, {}
total = pinned = entries = 0
def covers(path):
    return any(scope == "/" or path == scope or path.startswith(scope + "/") for scope in pins)
def add(path, s):
    global total, pinned, entries
    entries += 1
    if entries > 1000000 or time.monotonic() >= deadline:
        raise RuntimeError("allocation census budget exceeded")
    key, size = (s.st_dev, s.st_ino), s.st_blocks * 512
    if size < 0:
        raise RuntimeError("invalid allocation")
    if key in seen and seen[key] != size:
        raise RuntimeError("allocation changed during census")
    if key not in seen:
        seen[key] = size
        total += size
    if covers(path) and key not in pinned_seen:
        pinned_seen[key] = size
        pinned += size
def walk(fd, path, device):
    before = os.fstat(fd)
    if before.st_dev != device:
        raise RuntimeError("filesystem boundary")
    add(path, before)
    with os.scandir(fd) as children:
        for child in children:
            child_path = os.path.join(path, child.name)
            s = os.stat(child.name, dir_fd=fd, follow_symlinks=False)
            if s.st_dev != device:
                raise RuntimeError("filesystem boundary")
            if stat.S_ISDIR(s.st_mode):
                nested = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    current = os.fstat(nested)
                    if (s.st_dev, s.st_ino) != (current.st_dev, current.st_ino):
                        raise RuntimeError("directory identity changed")
                    walk(nested, child_path, device)
                finally:
                    os.close(nested)
            else:
                add(child_path, s)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_ctime_ns):
        raise RuntimeError("directory changed during census")
try:
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        initial = os.fstat(fd)
        walk(fd, root, initial.st_dev)
        identity = str(initial.st_dev) + ":" + str(initial.st_ino)
    finally:
        os.close(fd)
    if total > 9007199254740991 or pinned > total:
        raise RuntimeError("allocation overflow")
    print(json.dumps({"bytes": total, "pinnedBytes": pinned, "identity": identity, "complete": True}))
except Exception as error:
    print(json.dumps({"complete": False, "permissionDenied": isinstance(error, PermissionError), "error": str(error)[:240]}))
`;
      try {
        const { withRetentionPinProtection, readRetentionPins } = await import(pathToFileURL(process.argv[1]).href);
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid container store cap");
        // Keep the registry and mutex under the caller identity. Only resolving
        // a rootful store needs privilege; sudoing the guard would switch both.
        const resolvePath = path => {
          try { return realpathSync(path); } catch (error) {
            if (!privileged ||
                !["EACCES", "EPERM"].includes(error.code)) throw error;
            const physical = execFileSync("sudo", ["-n", "realpath", "-e", "--", path], {
              encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
            }).replace(/\n$/, "");
            if (!isAbsolute(physical) || /[\r\n\0]/.test(physical)) {
              throw new Error("rootful storage canonical path is invalid");
            }
            return physical;
          }
        };
        const nowMs = Date.now();
        await withRetentionPinProtection(async isPinned => {
          // The same parser, time and held mutex give both reads the identical
          // validated snapshot, including when a pin expires during native work.
          const read = readRetentionPins({ nowMs });
          if (read.errors.length) throw new Error("pin allocation snapshot unavailable");
          const pinPaths = [...new Set(read.pins.flatMap(pin => pin.paths.flatMap(path => {
            let physical = path;
            try { physical = resolvePath(path); } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            return [normalize(path), normalize(physical)];
          })))];
          const physicalRoot = resolvePath(root);
          receipt.physicalRoot = physicalRoot;
          if (physicalRoot === "/") throw new Error("filesystem root is not a container store");
          const measure = () => {
            const args = ["-c", census];
            const options = { input: JSON.stringify({ root: physicalRoot, pins: pinPaths }),
              encoding: "utf8", timeout: 35000, maxBuffer: 8192, stdio: ["pipe", "pipe", "pipe"] };
            let result = JSON.parse(execFileSync("python3", args, options));
            if (result.permissionDenied && privileged) {
              result = JSON.parse(execFileSync("sudo", ["-n", "python3", ...args], options));
            }
            if (!result.complete) throw new Error(result.error || "incomplete allocation census");
            return result;
          };
          const before = measure();
          const pinned = isPinned(root);
          receipt.beforeBytes = before.bytes;
          process.stdout.write(`${pinned ? "PINNED" : "LOCKED"}\t${before.identity}\n`);
          const [failures, skip] = (await released).trim().split("\t");
          receipt.nativeFailures = Number(failures) || 0;
          const after = measure();
          if (after.identity !== before.identity) throw new Error("store root identity changed");
          receipt.measurementComplete = true;
          receipt.afterBytes = after.bytes;
          receipt.pinnedBytes = after.pinnedBytes;
          receipt.reclaimedBytes = Math.max(0, before.bytes - after.bytes);
          receipt.pinnedOverageBytes = Math.max(0, after.pinnedBytes - maxBytes);
          receipt.unprotectedOverageBytes = Math.max(0, after.bytes - Math.max(maxBytes, after.pinnedBytes));
          receipt.status = skip || (receipt.nativeFailures ? "native-failed"
            : receipt.unprotectedOverageBytes ? (pinned ? "pinned-unrelated-overage" : "unprotected-overage")
            : receipt.pinnedOverageBytes ? "pinned-overage" : "within-cap");
          receipt.complete = !skip && !receipt.nativeFailures && !receipt.unprotectedOverageBytes;
          process.stdout.write(JSON.stringify(receipt) + "\n");
        }, { resolvePath, nowMs });
      } catch (error) {
        receipt.status = "measurement-failed";
        receipt.error = String(error).slice(0, 240);
        if (receipt.beforeBytes === undefined) process.stdout.write("ERROR\n");
        process.stdout.write(JSON.stringify(receipt) + "\n");
        await released;
      }
      process.stdin.destroy();
    ' "$module" "$root" "$label" "$CONTAINER_STORE_MAX_BYTES"
  }
  PIN_GUARD_PID="${CONTAINER_PIN_GUARD_PID:-}"
  input="${CONTAINER_PIN_GUARD[1]:-}"
  output="${CONTAINER_PIN_GUARD[0]:-}"
  if [[ -z "$PIN_GUARD_PID" || -z "$input" || -z "$output" ]]; then
    log "retention pin admission failed: $label guard unavailable — skipping store"
    container_pin_guard_release
    return 1
  fi
  exec {PIN_GUARD_INPUT}>&"$input"
  exec {PIN_GUARD_OUTPUT}<&"$output"
  exec {input}>&-
  exec {output}<&-
  IFS=$'\t' read -r readiness identity <&"$PIN_GUARD_OUTPUT" || readiness=ERROR
  if [[ -n "$identity" && -n "${SEEN_CONTAINER_STORES[$identity]:-}" ]]; then
    STORE_SKIP_REASON=duplicate-store
    container_pin_guard_release
    return 1
  fi
  [[ -z "$identity" ]] || SEEN_CONTAINER_STORES[$identity]="$label"
  if [[ "$readiness" != LOCKED ]]; then
    if [[ "$readiness" == PINNED ]]; then log "retention pin protects $label — skipping store"
    else log "retention pin admission failed: $label — skipping store"; fi
    container_pin_guard_release
    return 1
  fi
}

# `docker` needs root on this box; prefer non-interactive sudo, fall back to a
# bare call so the script still works where the user is in the docker group.
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
  else
    log "docker unreachable — skipping Docker; checking Podman image stores"
    DOCKER=()
  fi
fi

avail_bytes() { df -B1 --output=avail "$TARGET_FS" 2>/dev/null | tail -1 | tr -d ' '; }
total_bytes() { df -B1 --output=size  "$TARGET_FS" 2>/dev/null | tail -1 | tr -d ' '; }

BEFORE="$(avail_bytes)"
TOTAL="$(total_bytes)"
if [[ -z "$BEFORE" || -z "$TOTAL" || "$TOTAL" -eq 0 ]]; then
  log "could not read df for $TARGET_FS — no-op"
  exit 0
fi

FREE_PCT=$(( BEFORE * 100 / TOTAL ))
log "start: $((BEFORE / 1073741824)) GiB free on $TARGET_FS (${FREE_PCT}% of $((TOTAL / 1073741824)) GiB)"

if (( FREE_PCT >= RECLAIM_MIN_FREE_PCT )); then
  log "free% ${FREE_PCT} >= RECLAIM_MIN_FREE_PCT ${RECLAIM_MIN_FREE_PCT} — nothing to do"
  exit 0
fi

# Below the shared 2% write reserve, retain only twelve hours of UNUSED image
# and build cache. Native reference checks still protect containers and live
# build leases; named volumes retain their separate preservation contract.
# Explicit operator age overrides and SKIP_IMAGES continue to take precedence.
if (( BEFORE * 100 < TOTAL * 2 )); then
  [[ -n "$IMAGE_MAX_AGE_EXPLICIT" ]] || IMAGE_MAX_AGE=12h
  [[ -n "$BUILD_CACHE_MAX_AGE_EXPLICIT" ]] || BUILD_CACHE_MAX_AGE=12h
  log "critical headroom: image age=${IMAGE_MAX_AGE}, build-cache age=${BUILD_CACHE_MAX_AGE} (native reference protection retained)"
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would run: $*"
    return 0
  fi
  local command_exit=0
  timeout 120s "$@" >/dev/null 2>&1 || command_exit=$?
  if (( command_exit != 0 )); then
    STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
    log "step failed (non-fatal, exit=${command_exit}): $*"
  fi
}

# ── 1. Build cache ───────────────────────────────────────────────────────────
if (( ${#DOCKER[@]} > 0 )); then
  docker_root=''
  if ! docker_root="$(timeout 30s "${DOCKER[@]}" info --format '{{.DockerRootDir}}' 2>/dev/null)"; then
    docker_root=''
  fi
  container_pin_guard_acquire docker "$docker_root" || DOCKER=()
fi
if (( ${#DOCKER[@]} > 0 )); then
# The single safest reclaim: pure derived data, regenerated on demand. On the
# measured run this was 34.85 GB with zero active references.
log "pruning build cache older than ${BUILD_CACHE_MAX_AGE}"
run "${DOCKER[@]}" builder prune -af --filter "until=${BUILD_CACHE_MAX_AGE}"

# ── 2. Unreferenced images ───────────────────────────────────────────────────
# Images backing a running container are protected by Docker itself; the age
# filter additionally spares anything pulled recently for an in-flight run.
if [[ "$SKIP_IMAGES" == "1" ]]; then
  log "SKIP_IMAGES=1 — skipping image sweep"
else
  log "pruning unreferenced images older than ${IMAGE_MAX_AGE}"
  run "${DOCKER[@]}" image prune -af --filter "until=${IMAGE_MAX_AGE}"
fi

# ── 3. Orphaned ANONYMOUS volumes only ───────────────────────────────────────
# See the safety contract: named volumes are persistent application data and
# are never candidates. We resolve each anonymous dangling volume's CreatedAt
# and skip anything younger than VOLUME_MAX_AGE_SECS so a just-started
# testcontainer is never pulled out from under a running suite.
NOW_EPOCH="$(date +%s)"
anon_removed=0
anon_skipped_young=0
anonymous_volumes=''
if ! anonymous_volumes="$(timeout 30s "${DOCKER[@]}" volume ls -qf dangling=true 2>/dev/null)"; then
  STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
  anonymous_volumes=''
fi

while IFS= read -r vol; do
  [[ -z "$vol" ]] && continue
  if ! created="$(timeout 30s "${DOCKER[@]}" volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null)" || [[ -z "$created" ]]; then
    STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
    continue
  fi
  if [[ -n "$created" ]]; then
    created_epoch="$(date -d "$created" +%s 2>/dev/null || echo 0)"
    if (( created_epoch <= 0 )); then
      STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
      continue
    fi
    if (( created_epoch > 0 )) && (( NOW_EPOCH - created_epoch < VOLUME_MAX_AGE_SECS )); then
      anon_skipped_young=$(( anon_skipped_young + 1 ))
      continue
    fi
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would remove anonymous volume $vol"
  else
    if timeout 30s "${DOCKER[@]}" volume rm "$vol" >/dev/null 2>&1; then
      anon_removed=$(( anon_removed + 1 ))
    else
      STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
    fi
  fi
done < <(printf '%s\n' "$anonymous_volumes" | grep -E '^[0-9a-f]{64}$')

log "anonymous volumes removed=${anon_removed} skipped_too_young=${anon_skipped_young} (named volumes never touched)"

# ── 4. Leaked testcontainers (WI-6554700010009309) ───────────────────────────
# libs/test-config starts every shared test container with `.withReuse()` and
# the integration layer runs with Ryuk disabled, so nothing else ever removes
# one. A container whose reuse hash stops matching (an image bump, a moved
# generation label, a duplicate from a start race) leaks forever: on 2026-10-13
# up to 5 of the 9 running testcontainers had been idle for days, the oldest 17.
#
# Each start in libs/test-config stamps $TESTCONTAINERS_LAST_USED_DIR/<id>
# (libs/test-config/src/testcontainer-last-used.ts). A container is removed only
# when ALL of these hold:
#   - it carries the label org.testcontainers=true (nothing else is a candidate);
#   - its last-use marker is older than TESTCONTAINER_IDLE_MAX_SECS. A container
#     with NO marker is stamped now and never removed on first sight, so even a
#     container whose users cannot write markers gets a full idle window;
#   - no established TCP connection touches any of its published host ports.
#     A connection counts as use and refreshes the marker.
# `docker rm -f -v` also drops the container's own anonymous data volumes.
#
# Default 5 h (WI-6554700010010406). Plan papercusp-performance-audit-2026-10-12
# R-4 requires that no test container is observed idle for more than 6 h without
# an owner. This script runs hourly (papercup-docker-reclaim.timer, *:17), so a
# container that crosses the threshold just after a tick survives about one more
# hour: the worst observed idle is roughly threshold + 1 h. A 6 h default would
# allow ~7 h. The cost of a short window is bounded: libs/test-config stamps the
# marker every time a Vitest process resolves the container, so the shared reused
# test PG is re-created only after more than 5 h with no use at all.
TESTCONTAINER_IDLE_MAX_SECS="${TESTCONTAINER_IDLE_MAX_SECS:-18000}"
TESTCONTAINERS_LAST_USED_DIR="${PAPERCUSP_TESTCONTAINERS_LAST_USED_DIR:-/tmp/pcv/testcontainers-last-used}"
SKIP_TESTCONTAINERS="${SKIP_TESTCONTAINERS:-0}"
if (( TESTCONTAINER_IDLE_MAX_SECS < 3600 )); then
  log "TESTCONTAINER_IDLE_MAX_SECS=${TESTCONTAINER_IDLE_MAX_SECS} below the 3600s floor — using 3600"
  TESTCONTAINER_IDLE_MAX_SECS=3600
fi

testcontainer_connections() {
  local id="$1" port n total=0 published connections
  published="$(timeout 30s "${DOCKER[@]}" port "$id" 2>/dev/null)" || return 1
  while IFS= read -r port; do
    [[ -z "$port" ]] && continue
    connections="$(timeout 30s ss -Htn state established "( sport = :$port or dport = :$port )" 2>/dev/null)" || return 1
    n="$(printf '%s\n' "$connections" | sed '/^$/d' | wc -l)"
    total=$(( total + n ))
  done < <(printf '%s\n' "$published" | sed -nE 's/.*:([0-9]+)$/\1/p' | sort -u)
  echo "$total"
}

if [[ "$SKIP_TESTCONTAINERS" == "1" ]]; then
  log "SKIP_TESTCONTAINERS=1 — skipping leaked-testcontainer sweep"
elif ! command -v ss >/dev/null 2>&1; then
  # Without ss the connection guard cannot run, so nothing is provably idle.
  STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
  log "ss not found — skipping leaked-testcontainer sweep"
elif ! tc_ids="$(timeout 30s "${DOCKER[@]}" ps -aq --no-trunc --filter label=org.testcontainers=true 2>/dev/null)"; then
  STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
  log "docker ps failed — skipping leaked-testcontainer sweep"
else
  [[ "$DRY_RUN" == "1" ]] || mkdir -p "$TESTCONTAINERS_LAST_USED_DIR" 2>/dev/null
  tc_removed=0; tc_recent=0; tc_busy=0; tc_first_seen=0
  NOW_EPOCH="$(date +%s)"
  while IFS= read -r id; do
    [[ "$id" =~ ^[0-9a-f]{64}$ ]] || continue
    marker="$TESTCONTAINERS_LAST_USED_DIR/$id"
    desc="$("${DOCKER[@]}" inspect -f '{{.Name}} {{.Config.Image}} created={{.Created}}' "$id" 2>/dev/null)"
    if [[ ! -e "$marker" ]]; then
      tc_first_seen=$(( tc_first_seen + 1 ))
      if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN no last-use marker for ${desc:-$id} — would stamp it now (idle window starts)"
      else
        touch "$marker" 2>/dev/null
      fi
      continue
    fi
    used_epoch="$(stat -c %Y "$marker" 2>/dev/null || echo "$NOW_EPOCH")"
    idle=$(( NOW_EPOCH - used_epoch ))
    if (( idle < TESTCONTAINER_IDLE_MAX_SECS )); then
      tc_recent=$(( tc_recent + 1 ))
      continue
    fi
    if ! conns="$(testcontainer_connections "$id")"; then
      STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
      log "testcontainer live references unavailable — retained $id"
      continue
    fi
    if (( conns > 0 )); then
      tc_busy=$(( tc_busy + 1 ))
      [[ "$DRY_RUN" == "1" ]] || touch "$marker" 2>/dev/null
      log "testcontainer ${desc:-$id} idle-marked ${idle}s but has ${conns} established connection(s) — kept, marker refreshed"
      continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN would remove leaked testcontainer ${desc:-$id} (unused for ${idle}s)"
    elif timeout 30s "${DOCKER[@]}" rm -f -v "$id" >/dev/null 2>&1; then
      tc_removed=$(( tc_removed + 1 ))
      rm -f "$marker"
      log "removed leaked testcontainer ${desc:-$id} (unused for ${idle}s)"
    else
      STORE_NATIVE_FAILURES=$(( STORE_NATIVE_FAILURES + 1 ))
      log "step failed (non-fatal): docker rm -f -v $id"
    fi
  done <<< "$tc_ids"

  # Drop markers whose container is gone so the directory cannot grow forever.
  if [[ "$DRY_RUN" != "1" && -d "$TESTCONTAINERS_LAST_USED_DIR" ]]; then
    for marker in "$TESTCONTAINERS_LAST_USED_DIR"/*; do
      [[ -e "$marker" ]] || continue
      name="${marker##*/}"
      [[ "$name" =~ ^[0-9a-f]{64}$ ]] || continue
      grep -qx "$name" <<< "$tc_ids" || rm -f "$marker"
    done
  fi
  log "testcontainers removed=${tc_removed} recently_used=${tc_recent} busy=${tc_busy} first_seen=${tc_first_seen} (idle threshold ${TESTCONTAINER_IDLE_MAX_SECS}s)"
fi
[[ "$DRY_RUN" != "1" ]] || STORE_SKIP_REASON=dry-run
container_pin_guard_release
fi

# Podman does not share Docker's daemon/storage or its anonymous-volume contract.
# Its image-prune command protects container AND external build references unless
# --external is passed. Keep the same image age floor; never collect its volumes.
reclaim_podman_images() {
  local label="$1" root
  shift
  if ! root="$(timeout 30s "$@" info --format '{{.Store.GraphRoot}}' 2>/dev/null)"; then
    log "$label unreachable — skipping image store"
    printf '[docker-reclaim] store-receipt {"store":"%s","status":"discovery-failed","complete":false,"measurementComplete":false}\n' "$label"
    return 0
  fi
  container_pin_guard_acquire "$label" "$root" || return 0
  if [[ "$SKIP_IMAGES" == "1" ]]; then
    log "SKIP_IMAGES=1 — skipping $label image sweep"
    STORE_SKIP_REASON=images-disabled
    container_pin_guard_release
    return 0
  fi
  log "pruning $label unreferenced images older than ${IMAGE_MAX_AGE}"
  run "$@" image prune -af --filter "until=${IMAGE_MAX_AGE}"
  [[ "$DRY_RUN" != "1" ]] || STORE_SKIP_REASON=dry-run
  container_pin_guard_release
}

if command -v podman >/dev/null 2>&1; then
  reclaim_podman_images podman-rootless podman
  # Rootful storage is a different store even when rootless `podman info` works.
  reclaim_podman_images podman-rootful sudo -n podman
fi

# ── Report the df delta, never docker's figure ───────────────────────────────
AFTER="$(avail_bytes)"
if [[ -n "$AFTER" ]]; then
  FREED=$(( AFTER - BEFORE ))
  log "done: $((AFTER / 1073741824)) GiB free (df delta: $((FREED / 1048576)) MiB reclaimed)"
else
  log "done: could not re-read df"
fi
exit 0
