#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pc-estate-mirror.sh — the OFF-GCP copy of the estate backups (WI-645563)
#
# WHY THIS EXISTS
#   gs://papercusp-estate-backups-active-alcove-504205-q3 lives in the SAME GCP
#   project (active-alcove-504205-q3) as the two VMs it protects. A project- or
#   account-level suspension therefore takes the estate AND its backups in one
#   event -- which is exactly the Hetzner event the whole restore plan existed
#   to stop recurring. Acceptance criterion `recovery-survives-provider-loss`
#   was graded DEGRADED at ship time with this item as the stated remediation.
#
#   A second bucket in another GCP project on the same billing account does NOT
#   fix that: account-level suspension is the modelled event. This script keeps
#   a copy on hardware that is not Google's at all, and seals it immutable so
#   neither a stray `rm -rf` nor an agent with sudo can quietly delete it.
#
# WHAT IT GUARANTEES (and what it does not)
#   ✓ The bytes are off GCP entirely, on the owner's box.
#   ✓ Every artifact is verified against the snapshot's own MANIFEST.json
#     sha256 BEFORE it is published -- a truncated or corrupt transfer is
#     quarantined, never mistaken for a good copy.
#   ✓ Published snapshots are chattr +i immutable (verified at runtime; the
#     state file records `sealed:false` rather than pretending when it fails).
#   ✓ The restore PROCEDURE (tools/) is mirrored too. Data without the runbook
#     is not a recovery.
#   ✗ NOT geographically offsite. Fire/theft at the office destroys this copy --
#     GCP still holds one, so no SINGLE event destroys both, but this is two
#     failure domains, not three. Offsite hardening is tracked separately.
#   ✗ NOT encrypted at rest. The dumps sit mode-0700 under the owner's account
#     on the owner's hardware; every agent here already holds `sudo -n` and read
#     access to the source bucket, so a key stored on this same box would add a
#     way to LOSE the backup without adding a boundary that matters.
#
# MODES
#   mirror   pull every not-yet-mirrored snapshot, verify, seal, prune  (daily)
#   verify   re-check every stored snapshot against its manifest        (weekly)
#   health   assert the mirror is FRESH and sealed; alarm if not        (6-hourly)
#
# Exits non-zero on any failure, so systemd's OnFailure= alert fires. A backup
# that fails silently is the failure mode this whole file is built against
# (EI-10733: the DB backup rotted unnoticed for 30 days).
# ---------------------------------------------------------------------------
set -uo pipefail

MODE="${1:-mirror}"

BUCKET="${PC_ESTATE_BUCKET:-gs://papercusp-estate-backups-active-alcove-504205-q3}"
ROOT="${PC_ESTATE_MIRROR_ROOT:-/mnt/data/papercusp-estate-mirror}"
KEEP="${PC_ESTATE_MIRROR_KEEP:-14}"          # snapshots retained per host
MIN_FREE_GB="${PC_ESTATE_MIRROR_MIN_FREE_GB:-40}"
MAX_AGE_H="${PC_ESTATE_MIRROR_MAX_AGE_H:-30}" # health: newest snapshot age
SEAL="${PC_ESTATE_MIRROR_SEAL:-1}"

SNAPDIR="$ROOT/snapshots"
STATE="$ROOT/MIRROR-STATE.json"
STAGE="$ROOT/.staging"
QUAR="$ROOT/.quarantine"
# Quarantine VERDICTS live outside the quarantined payload so a re-attempt that
# replaces the payload cannot reset the attempt count that bounds it.
QMETA="$ROOT/.quarantine-meta"
LOG="$ROOT/mirror.log"
# WI-10006303: a user-scope unit cannot depend on network-online.target (not-found in
# the user manager) and Persistent=true fires the missed run at login, before the
# uplink is up (measured 2026-10-05: probe 14:38:46-14:39:47Z, Wi-Fi CONNECTED_GLOBAL
# 14:53:35Z). So the script itself waits for connectivity, bounded, and DEFERS
# (exit 75 + a capped retry timer) instead of raising a false "gcloud auth?" alarm.
NET_WAIT_SEC="${PC_ESTATE_MIRROR_NET_WAIT_SEC:-1800}"       # how long one run waits for an uplink
NET_DEFER_MAX="${PC_ESTATE_MIRROR_NET_DEFER_MAX:-6}"         # consecutive no-network DEFERs before a real FATAL
NET_PROBE_HOST="${PC_ESTATE_MIRROR_NET_PROBE_HOST:-storage.googleapis.com}"
PROBE_RETRY_SEC="${PC_ESTATE_MIRROR_PROBE_RETRY_SEC:-20}"    # pause between the 3 bucket probes
RETRY_TIMER="${PC_ESTATE_MIRROR_RETRY_TIMER:-pc-estate-mirror-retry.timer}"
DEFER_COUNT="$ROOT/.net-defer-count"
GCS_PROBE_ERR=""
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so a test can point the alert channel at a recording stub and
# assert on WHICH channel fired. Without this seam the only way to prove an
# alarm is falsifiable is to mutate this file in the shared tree, which the
# git-sync sweep can commit mid-probe; with it, the whole alert contract is
# testable against a copy outside the tree.
ALERT="${PC_ESTATE_MIRROR_ALERT:-$SELF_DIR/pc-estate-mirror-alert.sh}"
# Where the restore runbook (tools/) is copied FROM. Defaults to this script's own
# directory, but the unit runs the script through papercusp-script-snapshot.sh
# (a private per-run copy, so a mid-run edit in the shared tree cannot rewrite
# the running program), and that snapshot holds only the *.sh/*.mjs siblings —
# not RESTORE-RUNBOOK.md. Without this override the copy would silently fall
# back to the bucket's hand-uploaded, possibly months-stale tools/.
TOOLS_SRC="${PC_ESTATE_MIRROR_TOOLS_SRC:-$SELF_DIR}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FATAL: $*"; exit 1; }

alarm() {
  # Best-effort: the alert path must never itself fail the run's exit code.
  [ -x "$ALERT" ] && "$ALERT" "$*" || log "ALARM (no alert script): $*"
}

standdown() {
  # The retraction half of alarm(). Deleting the marker only stands the alarm
  # down for whoever LOOKS at the mirror; the fleet-wide coord:send that alarm()
  # fired is still sitting in every inbox saying the backups are unprotected.
  # Same best-effort contract as alarm(): a stand-down that fails must never
  # turn a healthy run red.
  [ -x "$ALERT" ] && "$ALERT" --resolved "$*" || log "STAND-DOWN (no alert script): $*"
}

degraded() {
  # The third channel, between alarm() and standdown(): a fault in the PROBE that
  # is not a fault in the BACKUPS. alarm() appends "the only surviving copy is the
  # GCS bucket" to whatever reason it is given, so routing a probe-only fault
  # through it broadcasts a backup outage that is not happening (WI-10001692).
  [ -x "$ALERT" ] && "$ALERT" --degraded "$*" || log "DEGRADED (no alert script): $*"
}

partial_source() {
  # The fourth channel: a fault in a SOURCE backup that the mirror copied and
  # verified faithfully. Neither the mirror nor its probe is broken, so neither the
  # FAILING nor the DEGRADED latch applies, and nothing re-raises it later: the
  # caller fires this exactly once, when the snapshot is first published (WI-10006330).
  [ -x "$ALERT" ] && "$ALERT" --partial-source "$*" || log "PARTIAL SOURCE (no alert script): $*"
}

clear_failing_marker() {
  # Retraction half of the ALERT-MIRROR-FAILING latch, callable from EVERY branch
  # that has positively MEASURED the backups to be fine — not only the fully
  # healthy one. pc-estate-mirror-alert.sh writes this marker and, before
  # WI-10001692, nothing cleared it: once any run failed it asserted "the backups
  # are unprotected" forever, including inside the triage text broadcast
  # fleet-wide. That is worse than no marker, because agents read its ABSENCE as
  # evidence of health (WI-1038273 did exactly that), so a stuck marker misleads
  # in the direction of a fault that is already fixed. An alarm that cannot stand
  # down is a bug in the alarm.
  #
  # Returns 0 ONLY on the transition out of an alarm we actually raised (marker
  # present AND cleared), so the CALLER picks the channel that announces it: the
  # healthy path stands the alarm down, while the degraded path stays silent here
  # and lets degraded() speak — a --resolved broadcast there would both overclaim
  # ("the fault is over" while the probe is still blind) and delete the degraded
  # latch it is about to set.
  [ -e "$ROOT/ALERT-MIRROR-FAILING" ] || return 1
  if rm -f "$ROOT/ALERT-MIRROR-FAILING" 2>/dev/null \
    || sudo -n rm -f "$ROOT/ALERT-MIRROR-FAILING" 2>/dev/null; then
    log "cleared ALERT-MIRROR-FAILING ($*)"
    return 0
  fi
  # Never fail the health check over the marker -- a probe that dies while
  # cleaning up reports a fault that does not exist.
  log "WARN: could not clear $ROOT/ALERT-MIRROR-FAILING ($*)"
  return 1
}

clear_degraded_marker() {
  # Retraction half of the ALERT-MIRROR-DEGRADED latch. Before this, the ONLY
  # thing that removed this marker was the alert script's --resolved path — and
  # that path is reached only when clear_failing_marker() has just cleared
  # ALERT-MIRROR-FAILING, a marker the degraded path deliberately never writes.
  # So the common case latched forever: a probe-only fault raised DEGRADED, the
  # probe later returned to full health, found no FAILING marker to clear, never
  # stood anything down, and left the degraded latch on disk permanently.
  #
  # That is not merely a stale file. pc-estate-mirror-alert.sh reads this
  # marker's EXISTENCE as ALREADY_KNOWN and suppresses the fleet-wide channel for
  # a degradation it believes has already been announced. A latch that cannot
  # clear therefore silently MUTES every future degraded alert — the anti-spam
  # guard becomes a permanent gag, and it fails in the direction where nobody is
  # told. Same contract as clear_failing_marker(): returns 0 only on a real
  # transition out of a latch we actually set, and never fails the health check
  # over a marker.
  [ -e "$ROOT/ALERT-MIRROR-DEGRADED" ] || return 1
  if rm -f "$ROOT/ALERT-MIRROR-DEGRADED" 2>/dev/null \
    || sudo -n rm -f "$ROOT/ALERT-MIRROR-DEGRADED" 2>/dev/null; then
    log "cleared ALERT-MIRROR-DEGRADED ($*)"
    return 0
  fi
  log "WARN: could not clear $ROOT/ALERT-MIRROR-DEGRADED ($*)"
  return 1
}

# Measure freshness from the SNAPSHOT TREE — the immutable artifact the mirror
# exists to produce — rather than from MIRROR-STATE.json, a single deletable file
# whose absence says nothing about whether the backups are there. Prints
# "<hosts> <snapshots> <newest_age_h|NONE>" and never fails its caller: a census
# that dies must not be readable as "zero snapshots", which is the same
# false-absence shape this whole bug is made of.
snapshot_census() {
  python3 - "$SNAPDIR" 2>/dev/null <<'PY' || echo "CENSUS-FAILED CENSUS-FAILED CENSUS-FAILED"
import os, sys, datetime
snapdir = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc)
hosts = snaps = 0
newest = None
try:
    entries = sorted(os.listdir(snapdir))
except Exception:
    print("0 0 NONE"); raise SystemExit(0)
for h in entries:
    hd = os.path.join(snapdir, h)
    if not os.path.isdir(hd):
        continue
    stamps = [d for d in os.listdir(hd) if os.path.isdir(os.path.join(hd, d))]
    if not stamps:
        continue
    hosts += 1
    snaps += len(stamps)
    for d in stamps:
        try:
            t = datetime.datetime.strptime(d[:15], "%Y%m%dT%H%M%S").replace(
                tzinfo=datetime.timezone.utc)
        except Exception:
            continue
        if newest is None or t > newest:
            newest = t
age = "NONE" if newest is None else "%.1f" % ((now - newest).total_seconds() / 3600.0)
print("%d %d %s" % (hosts, snaps, age))
PY
}

# --- immutability helpers ---------------------------------------------------
# chattr +i is verified at runtime, never assumed: it is a filesystem
# capability, and claiming "immutable" on a filesystem that silently ignored
# the flag would be worse than not claiming it.
seal()   { [ "$SEAL" = "1" ] || return 1; sudo -n chattr -R +i "$1" 2>/dev/null; }
unseal() { sudo -n chattr -R -i "$1" 2>/dev/null || true; }

seal_supported() {
  [ "$SEAL" = "1" ] || return 1
  local probe="$ROOT/.sealprobe.$$"
  : >"$probe" 2>/dev/null || return 1
  if sudo -n chattr +i "$probe" 2>/dev/null; then
    sudo -n chattr -i "$probe" 2>/dev/null; rm -f "$probe"; return 0
  fi
  rm -f "$probe" 2>/dev/null; return 1
}

free_gb() { df -BG --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9'; }

# --- verify one snapshot directory against its own MANIFEST.json ------------
# Returns 0 = every listed artifact present, right size, right sha256.
verify_snapshot() {
  local dir="$1"
  python3 - "$dir" <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]
mp = os.path.join(d, "MANIFEST.json")
if not os.path.isfile(mp):
    print("MISSING MANIFEST.json"); sys.exit(1)
try:
    m = json.load(open(mp))
except Exception as e:
    print("UNREADABLE MANIFEST.json: %s" % e); sys.exit(1)
arts = m.get("artifacts") or []
if not arts:
    print("MANIFEST lists ZERO artifacts"); sys.exit(1)
bad = []
total = 0
for a in arts:
    p = os.path.join(d, a["path"])
    if not os.path.isfile(p):
        bad.append("%s: MISSING" % a["path"]); continue
    sz = os.path.getsize(p)
    total += sz
    if "bytes" in a and sz != a["bytes"]:
        bad.append("%s: size %d != manifest %d" % (a["path"], sz, a["bytes"])); continue
    if a.get("sha256"):
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != a["sha256"]:
            bad.append("%s: sha256 MISMATCH" % a["path"])
for b in bad:
    print(b)
print("VERIFIED artifacts=%d bytes=%d manifest_failures=%s" %
      (len(arts) - len(bad), total, m.get("failures")))
sys.exit(1 if bad else 0)
PY
}

# ---------------------------------------------------------------------------
# MODE: mirror
# ---------------------------------------------------------------------------
gcs_reachable() {
  # Bounded retry on the reachability probe, because THIS TIMER IS DAILY: a
  # single transient blip that reaches `die` costs a full ~24h of off-site
  # coverage, not one run. That is not hypothetical — 2026-09-01T05:18Z failed
  # here once with "cannot read gs://…: <gcloud's last stderr line>", and the off-GCP copy
  # then sat 33h stale until the next attempt succeeded unattended (WI-2140790).
  #
  # Deliberately bounded, and deliberately still fatal after the bound: a real
  # auth expiry fails all three attempts and raises the SAME alarm it always
  # did. Retrying is only allowed to absorb a blip, never to convert a standing
  # fault into silence — that is the EI-10733 failure (a backup rotting quietly
  # for 30 days) this whole alarm exists to prevent.
  # The last stderr line is kept in GCS_PROBE_ERR so the FATAL names the real error
  # ("Reauthentication failed", "403", a DNS failure) instead of guessing "auth?".
  local attempt err; err="$(mktemp)"
  for attempt in 1 2 3; do
    if gcloud storage ls "$BUCKET/" >/dev/null 2>"$err"; then rm -f "$err"; return 0; fi
    GCS_PROBE_ERR="$(tail -n 1 "$err" 2>/dev/null | tr -d '\r' | cut -c1-200)"
    if [ "$attempt" -lt 3 ]; then
      log "bucket probe failed (attempt $attempt/3): ${GCS_PROBE_ERR:-no stderr} — retrying in ${PROBE_RETRY_SEC}s"
      sleep "$PROBE_RETRY_SEC"
    fi
  done
  rm -f "$err"
  return 1
}

# Connectivity = a default route AND the bucket endpoint resolves. Both go through
# PATH (ip, getent) so the test suite can shim them.
net_online() {
  ip route show default 2>/dev/null | grep -q . || return 1
  getent ahosts "$NET_PROBE_HOST" >/dev/null 2>&1
}

wait_for_network() {
  local waited=0
  while ! net_online; do
    [ "$waited" -ge "$NET_WAIT_SEC" ] && return 1
    [ "$waited" -eq 0 ] && log "network not up yet (no default route, or $NET_PROBE_HOST unresolvable) — waiting up to ${NET_WAIT_SEC}s"
    sleep 10; waited=$((waited+10))
  done
  [ "$waited" -gt 0 ] && log "network up after ${waited}s"
  return 0
}

# EX_TEMPFAIL (75): the unit maps it to success (SuccessExitStatus=75), so OnFailure=
# does NOT raise the fleet-wide alarm for a box that merely has no uplink yet; a
# bounded retry timer re-fires the mirror instead. The 6-hourly health probe still
# alarms STALE on its own clock, so a box offline for a day is still caught — and
# after NET_DEFER_MAX consecutive defers this becomes a real FATAL (the alarm).
defer_for_network() {
  local n=0
  [ -f "$DEFER_COUNT" ] && n="$(tr -cd 0-9 <"$DEFER_COUNT" 2>/dev/null)"; n="${n:-0}"
  n=$((n+1))
  if [ "$n" -gt "$NET_DEFER_MAX" ]; then
    rm -f "$DEFER_COUNT"
    die "no network for $NET_DEFER_MAX consecutive runs (each waited ${NET_WAIT_SEC}s) — giving up until the next scheduled run"
  fi
  echo "$n" >"$DEFER_COUNT"
  if [ -n "$RETRY_TIMER" ] && command -v systemctl >/dev/null 2>&1 \
     && systemctl --user start "$RETRY_TIMER" >/dev/null 2>&1; then
    log "DEFER $n/$NET_DEFER_MAX: no network after ${NET_WAIT_SEC}s — $RETRY_TIMER armed"
  else
    log "DEFER $n/$NET_DEFER_MAX: no network after ${NET_WAIT_SEC}s — retry timer not armed; next scheduled run will retry"
  fi
  exit 75
}

do_mirror() {
  mkdir -p "$SNAPDIR" "$STAGE" "$QUAR" "$QMETA" || die "cannot create $ROOT"
  chmod 700 "$ROOT" 2>/dev/null || true

  command -v gcloud >/dev/null || die "gcloud not on PATH"
  wait_for_network || defer_for_network
  gcs_reachable || die "cannot read $BUCKET after 3 attempts over ~$((2*PROBE_RETRY_SEC))s: ${GCS_PROBE_ERR:-gcloud printed nothing}"
  rm -f "$DEFER_COUNT"

  local sealed=false; seal_supported && sealed=true
  $sealed || log "WARNING: chattr +i unavailable here — snapshots will be mirrored but NOT sealed"

  # Every snapshot is exactly one MANIFEST.json, so this enumerates them
  # without depending on the daily/<date>/ nesting staying the shape it is.
  local manifests
  manifests=$(gcloud storage ls "$BUCKET/daily/**/MANIFEST.json" 2>/dev/null | sort) \
    || die "snapshot enumeration failed"
  [ -n "$manifests" ] || die "no snapshots found in $BUCKET/daily/ — nothing to mirror is itself a fault"

  # Walk each host NEWEST-FIRST and stop once KEEP snapshots are held (WI-10006308).
  # The bucket keeps far more history than the KEEP retained here, and the old
  # oldest-first walk downloaded, verified and sealed every one of those older
  # snapshots only for retention to delete them minutes later — +45 snapshots,
  # ~38min and ~50GB of egress on 2026-10-03, growing by two every day until it
  # would overrun the unit's TimeoutStartSec. Quarantined and failed snapshots do
  # not count toward KEEP, so an older good one still backfills behind a bad
  # newer one: the set left on disk is exactly what download-all-then-prune kept.
  # Newest-first also means a run cut short has already secured the copy that
  # matters most.
  local ordered
  ordered=$(printf '%s\n' "$manifests" \
    | awk -F/ 'NF >= 4 { print $(NF-2) "\t" $(NF-1) "\t" $0 }' \
    | sort -t "$(printf '\t')" -k1,1 -k2,2r \
    | cut -f3-)
  [ -n "$ordered" ] || die "snapshot enumeration returned no parseable <host>/<ts>/MANIFEST.json paths"

  local errors=() quarantined=() mirrored=0 skipped=0 beyond_keep=0
  local -A held=()
  while IFS= read -r mf; do
    [ -n "$mf" ] || continue
    local prefix host ts dst
    prefix="${mf%/MANIFEST.json}"
    ts="$(basename "$prefix")"
    host="$(basename "$(dirname "$prefix")")"
    dst="$SNAPDIR/$host/$ts"

    if [ "${held[$host]:-0}" -ge "$KEEP" ]; then beyond_keep=$((beyond_keep+1)); continue; fi
    if [ -f "$dst/MIRROR-META.json" ]; then
      skipped=$((skipped+1)); held[$host]=$(( ${held[$host]:-0} + 1 )); continue
    fi

    # A snapshot that has already been judged UNMIRRORABLE is not retried
    # forever. The distinction matters and it is not cosmetic:
    #   source_incomplete — the object is absent FROM THE BUCKET. No number of
    #                       retries invents it, so retrying only burns transfer
    #                       and raises the same alarm every single day until
    #                       everyone learns to ignore the alarm. That is how a
    #                       real one gets missed.
    #   transfer_corrupt  — the object is there but arrived wrong. That IS
    #                       plausibly transient, so it gets a bounded 3 tries.
    # Either way the snapshot stays visible in MIRROR-STATE.json as a standing
    # fault. Suppressing the repeat alarm is not the same as forgetting.
    local qmeta="$QMETA/$host/$ts.json"
    if [ -f "$qmeta" ]; then
      local qclass qatt
      qclass=$(python3 -c "import json;print(json.load(open('$qmeta')).get('classification',''))" 2>/dev/null)
      qatt=$(python3 -c "import json;print(json.load(open('$qmeta')).get('attempts',0))" 2>/dev/null)
      if [ "$qclass" = "source_incomplete" ] || [ "${qatt:-0}" -ge 3 ]; then
        quarantined+=("$host/$ts ($qclass, attempts=${qatt:-0})")
        continue
      fi
    fi

    local avail; avail=$(free_gb)
    if [ -n "$avail" ] && [ "$avail" -lt "$MIN_FREE_GB" ]; then
      errors+=("disk floor: ${avail}GB free < ${MIN_FREE_GB}GB — refusing to mirror $host/$ts")
      log "REFUSING: only ${avail}GB free (floor ${MIN_FREE_GB}GB)"
      break
    fi

    log "mirroring $host/$ts"
    rm -rf "${STAGE:?}/$host/$ts"
    mkdir -p "$STAGE/$host"
    if ! gcloud storage cp -r "$prefix" "$STAGE/$host/" --quiet >>"$LOG" 2>&1; then
      errors+=("$host/$ts: download failed")
      rm -rf "${STAGE:?}/$host/$ts"
      continue
    fi

    local vout
    if ! vout=$(verify_snapshot "$STAGE/$host/$ts" 2>&1); then
      # A bad copy is QUARANTINED, never published and never silently dropped:
      # the difference between the two is the difference between a known-bad
      # backup and an unknown-bad one.
      mkdir -p "$QUAR/$host" "$QMETA/$host"
      rm -rf "${QUAR:?}/$host/$ts"
      mv "$STAGE/$host/$ts" "$QUAR/$host/$ts" 2>/dev/null || true

      local klass
      # $vout is passed through the environment, not interpolated into the
      # heredoc: it is arbitrary text from a failure path, and a quote or a
      # backslash in it must not be able to rewrite this program.
      klass=$(PC_VOUT="$vout" python3 - "$qmeta" "$host" "$ts" <<'PY'
import json, os, sys, datetime
qmeta, host, ts = sys.argv[1:4]
lines = [l.strip() for l in os.environ.get("PC_VOUT", "").splitlines()
         if l.strip() and not l.startswith("VERIFIED ")]
# Absent from the source bucket vs present-but-wrong. Only the second is worth
# retrying, and calling the first "transient" is how a permanent fault becomes
# background noise.
klass = "source_incomplete" if lines and all(l.endswith(": MISSING") for l in lines) \
        else "transfer_corrupt"
prev = {}
if os.path.isfile(qmeta):
    try: prev = json.load(open(qmeta))
    except Exception: prev = {}
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
os.makedirs(os.path.dirname(qmeta), exist_ok=True)
json.dump({
    "host": host, "taken_at": ts,
    "classification": klass,
    "attempts": int(prev.get("attempts", 0)) + 1,
    "first_seen": prev.get("first_seen", now),
    "last_seen": now,
    "failures": lines[:20],
    "note": ("The bucket itself does not hold these objects; the snapshot's own "
             "MANIFEST.json claims them. Retrying cannot fix this — the source "
             "snapshot is incomplete.") if klass == "source_incomplete"
            else "Objects are present in the bucket but arrived wrong; bounded retry.",
}, open(qmeta, "w"), indent=2)
print(klass)
PY
)
      # New quarantines alarm; a fault already on the books does not re-alarm.
      errors+=("$host/$ts: VERIFY FAILED (${klass:-unknown}) — quarantined: $(echo "$vout" | head -3 | tr '\n' ';')")
      log "VERIFY FAILED $host/$ts [${klass:-unknown}]: $vout"
      continue
    fi
    log "verified $host/$ts: $(echo "$vout" | tail -1)"

    python3 - "$STAGE/$host/$ts" "$prefix" "$host" "$ts" "$vout" "$sealed" <<'PY'
import json, os, sys, datetime
d, src, host, ts, vout, sealed = sys.argv[1:7]
total = 0
for r, _, fs in os.walk(d):
    for f in fs:
        total += os.path.getsize(os.path.join(r, f))
mf = json.load(open(os.path.join(d, "MANIFEST.json")))
json.dump({
    "mirrored_at": datetime.datetime.now(datetime.timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source": src,
    "host": host,
    "taken_at": ts,
    "bytes_on_disk": total,
    "artifacts": len(mf.get("artifacts") or []),
    "manifest_failures": mf.get("failures"),
    "verification": vout.strip().splitlines()[-1] if vout.strip() else "",
    "sealed": sealed == "true",
}, open(os.path.join(d, "MIRROR-META.json"), "w"), indent=2)
PY

    mkdir -p "$SNAPDIR/$host"
    rm -rf "${dst:?}"
    if ! mv "$STAGE/$host/$ts" "$dst"; then
      errors+=("$host/$ts: publish (mv) failed")
      continue
    fi
    $sealed && { seal "$dst" || log "WARNING: seal failed for $dst"; }
    mirrored=$((mirrored+1))
    # A snapshot whose MANIFEST records producer failures verifies cleanly here --
    # every artifact it DECLARES is present -- yet that day's backup is missing data,
    # and nothing on the source VMs alerts on it. 2026-10-05 hetzner-restore-mesh
    # shipped 108/109 artifacts (a ClickHouse export hit SOCKET_TIMEOUT) and this
    # mirror published it silently (WI-10006330). The producer writes an integer;
    # a list form is counted by length so neither shape reads as zero.
    mfail=$(python3 -c 'import json,sys
f=json.load(open(sys.argv[1])).get("manifest_failures")
print(len(f) if isinstance(f,list) else int(f or 0))' "$dst/MIRROR-META.json" 2>/dev/null || echo 0)
    if [ "${mfail:-0}" -gt 0 ] 2>/dev/null; then
      log "PARTIAL SOURCE BACKUP $host/$ts: MANIFEST records $mfail producer failure(s)"
      partial_source "$host/$ts: the source backup recorded $mfail artifact failure(s) in its MANIFEST, so that day's backup is missing data (the mirror copy itself verified clean)"
    fi
    held[$host]=$(( ${held[$host]:-0} + 1 ))
  done <<<"$ordered"
  [ "$beyond_keep" -gt 0 ] && \
    log "not fetched: $beyond_keep bucket snapshot(s) older than the newest KEEP=$KEEP per host (retention would prune them)"

  # --- the restore PROCEDURE travels with the data --------------------------
  # Data without the runbook is not a recovery, so tools/ is re-synced every
  # run. SOURCE ORDER MATTERS: the repo is authoritative and always current,
  # while the bucket's tools/ is a hand-uploaded copy with no automated sync —
  # so it can be, and has been, months behind. Prefer the repo when it is here;
  # fall back to the bucket when it is not. Either way the mirror records WHICH,
  # so nobody has to guess how current their emergency runbook is.
  local tnew="$ROOT/.tools.new" tsrc=""
  rm -rf "$tnew"; mkdir -p "$tnew"
  if [ -f "$TOOLS_SRC/RESTORE-RUNBOOK.md" ] && cp -a "$TOOLS_SRC"/. "$tnew/" 2>>"$LOG"; then
    tsrc="repo:$TOOLS_SRC"
  elif gcloud storage cp -r "$BUCKET/tools/*" "$tnew/" --quiet >>"$LOG" 2>&1; then
    tsrc="bucket:$BUCKET/tools"
  fi
  if [ -n "$tsrc" ]; then
    printf 'synced_at=%s\nsource=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tsrc" >"$tnew/TOOLS-SOURCE.txt"
    [ -d "$ROOT/tools" ] && { unseal "$ROOT/tools"; rm -rf "$ROOT/tools"; }
    mv "$tnew" "$ROOT/tools"
    $sealed && seal "$ROOT/tools"
    log "tools/ synced from $tsrc"
  else
    rm -rf "$tnew"
    errors+=("tools/ sync failed — the mirror has data but no runbook copy")
  fi

  # --- retention ------------------------------------------------------------
  local pruned=0
  for hostdir in "$SNAPDIR"/*/; do
    [ -d "$hostdir" ] || continue
    local old
    old=$(ls -1 "$hostdir" 2>/dev/null | sort -r | tail -n +$((KEEP+1)))
    while IFS= read -r o; do
      [ -n "$o" ] || continue
      unseal "$hostdir$o"
      rm -rf "${hostdir:?}$o" && pruned=$((pruned+1))
    done <<<"$old"
  done

  write_state "$mirrored" "$skipped" "$pruned" "$sealed" "${errors[@]:-}"

  for q in "${quarantined[@]:-}"; do
    [ -n "$q" ] && log "standing quarantine (not retried, still on the books): $q"
  done

  if [ ${#errors[@]} -gt 0 ] && [ -n "${errors[0]:-}" ]; then
    alarm "estate mirror: ${#errors[@]} error(s) — ${errors[0]}"
    return 1
  fi
  log "mirror OK: +${mirrored} new, ${skipped} already held, ${pruned} pruned, ${#quarantined[@]} standing quarantine(s), sealed=${sealed}"
  return 0
}

write_state() {
  local mirrored="$1" skipped="$2" pruned="$3" sealed="$4"; shift 4
  local errs=("$@")
  python3 - "$STATE" "$SNAPDIR" "$mirrored" "$skipped" "$pruned" "$sealed" "$(free_gb)" "$QMETA" "${errs[@]}" <<'PY'
import json, os, sys, datetime
state, snapdir, mirrored, skipped, pruned, sealed, freegb, qmeta = sys.argv[1:9]
errs = [e for e in sys.argv[9:] if e]
# Standing quarantines are DERIVED from the marker directory rather than passed
# in, so a run that quarantines nothing new still reports every fault already on
# the books. A fault that disappears from the report the day after it is raised
# is a fault nobody fixes.
standing = []
for root, _, files in os.walk(qmeta) if os.path.isdir(qmeta) else []:
    for f in files:
        if not f.endswith(".json"):
            continue
        try:
            q = json.load(open(os.path.join(root, f)))
        except Exception:
            continue
        standing.append({k: q.get(k) for k in
                         ("host", "taken_at", "classification", "attempts",
                          "first_seen", "failures")})
standing.sort(key=lambda q: (q.get("host") or "", q.get("taken_at") or ""))
hosts = {}
total = 0
for h in sorted(os.listdir(snapdir)) if os.path.isdir(snapdir) else []:
    hd = os.path.join(snapdir, h)
    if not os.path.isdir(hd):
        continue
    snaps = sorted(x for x in os.listdir(hd) if os.path.isdir(os.path.join(hd, x)))
    b = 0
    for s in snaps:
        for r, _, fs in os.walk(os.path.join(hd, s)):
            for f in fs:
                try:
                    b += os.path.getsize(os.path.join(r, f))
                except OSError:
                    pass
    total += b
    hosts[h] = {"count": len(snaps), "oldest": snaps[0] if snaps else None,
                "newest": snaps[-1] if snaps else None, "bytes": b}
json.dump({
    "last_run_at": datetime.datetime.now(datetime.timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ok": not errs,
    "mirrored": int(mirrored), "already_held": int(skipped), "pruned": int(pruned),
    "sealed": sealed == "true",
    "free_gb": int(freegb or 0),
    "bytes_total": total,
    "hosts": hosts,
    "errors": errs,
    "quarantined": standing,
    "unseal_hint": "sudo chattr -R -i <path>  # published snapshots are immutable",
}, open(state, "w"), indent=2)
PY
}

# ---------------------------------------------------------------------------
# MODE: verify — re-read every stored byte. Catches bit rot and tampering,
# which a copy job can never catch because it only ever looks at new data.
# ---------------------------------------------------------------------------
do_verify() {
  [ -d "$SNAPDIR" ] || die "no mirror at $SNAPDIR"
  local bad=0 good=0
  for hostdir in "$SNAPDIR"/*/; do
    [ -d "$hostdir" ] || continue
    for snap in "$hostdir"*/; do
      [ -d "$snap" ] || continue
      if out=$(verify_snapshot "$snap" 2>&1); then
        good=$((good+1))
      else
        bad=$((bad+1)); log "VERIFY FAIL ${snap}: $(echo "$out" | head -3 | tr '\n' ';')"
      fi
    done
  done
  log "verify: ${good} intact, ${bad} FAILED"
  if [ "$bad" -gt 0 ]; then
    alarm "estate mirror: ${bad} stored snapshot(s) FAILED re-verification (bit rot or tampering)"
    return 1
  fi
  [ "$good" -gt 0 ] || { alarm "estate mirror: verify found ZERO snapshots"; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
# MODE: health — the detector. A mirror timer that quietly stops running looks
# exactly like a healthy mirror from the inside; only an age assertion tells
# them apart.
# ---------------------------------------------------------------------------
do_health() {
  local problems=()
  if [ ! -f "$STATE" ]; then
    # $STATE is ONE deletable file. Its absence is a fact about that file, never a
    # verdict on the mirror — so MEASURE the snapshot tree before naming a
    # consequence. This branch used to assert "the mirror has never completed a
    # run" without ever stat-ing $SNAPDIR, and broadcast it fleet-wide with
    # expects:"action" while 29G of same-day snapshots sat next to it
    # (WI-10001692). An alert that names a catastrophic consequence must verify
    # the consequence, not infer it from the first thing it happened to look at.
    local sn_hosts sn_count sn_age
    read -r sn_hosts sn_count sn_age <<<"$(snapshot_census)"
    if [ "$sn_hosts" = "CENSUS-FAILED" ]; then
      alarm "estate mirror: MIRROR-STATE.json missing at $STATE AND the snapshot census could not run — freshness is UNKNOWN, not healthy"
      return 1
    fi
    if [ "${sn_count:-0}" -eq 0 ]; then
      alarm "estate mirror: no MIRROR-STATE.json at $STATE and ZERO snapshots in $SNAPDIR — the mirror has never completed a run"
      return 1
    fi
    if [ "$sn_age" = "NONE" ]; then
      alarm "estate mirror: MIRROR-STATE.json missing and no snapshot in $SNAPDIR carries a readable timestamp ($sn_count dirs across $sn_hosts host(s)) — freshness cannot be established"
      return 1
    fi
    if awk "BEGIN{exit !($sn_age > $MAX_AGE_H)}"; then
      alarm "estate mirror: MIRROR-STATE.json missing AND newest snapshot is ${sn_age}h old (limit ${MAX_AGE_H}h) across $sn_hosts host(s) — the mirror has stopped"
      return 1
    fi
    # The backups are present and current; only the probe's own bookkeeping is
    # gone. That IS a real fault — seal, free-space and quarantine can no longer
    # be asserted — but it is not a backup outage, so it goes out DEGRADED. It
    # returns 0 deliberately: a non-zero exit fires the unit's
    # OnFailure=pc-estate-mirror-alert.service, which would re-broadcast the very
    # "only surviving copy is GCS" claim this branch exists to stop telling.
    log "HEALTH: MIRROR-STATE.json absent but snapshots are current — $sn_count snapshot(s) across $sn_hosts host(s), newest ${sn_age}h old (limit ${MAX_AGE_H}h)"
    # A stale ALERT-MIRROR-FAILING asserts a BACKUP OUTAGE, and the census above
    # just falsified that claim — so retract it HERE too. Without this the branch
    # returns below without ever reaching the stand-down block, and the false
    # marker latches for as long as MIRROR-STATE.json stays missing: the probe
    # would report "degraded, backups fine" every 6h while the marker on disk kept
    # telling every triaging agent the opposite. Deliberately BEFORE degraded():
    # the stand-down path clears the degraded latch, so raising it first would
    # erase the latch we are about to set.
    clear_failing_marker "backups measured present and current; probe bookkeeping still missing"
    degraded "MIRROR-STATE.json is missing, so seal/free-space/quarantine cannot be asserted — but the BACKUPS are present and current ($sn_count snapshots across $sn_hosts hosts, newest ${sn_age}h old, limit ${MAX_AGE_H}h). The next successful mirror run rewrites the state file."
    return 0
  fi
  mapfile -t problems < <(python3 - "$STATE" "$MAX_AGE_H" "$MIN_FREE_GB" <<'PY'
import json, sys, datetime
state, max_age_h, min_free = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
s = json.load(open(state))
now = datetime.datetime.now(datetime.timezone.utc)
def age_h(stamp, fmt):
    try:
        t = datetime.datetime.strptime(stamp, fmt).replace(tzinfo=datetime.timezone.utc)
    except Exception:
        return None
    return (now - t).total_seconds() / 3600.0
a = age_h(s.get("last_run_at", ""), "%Y-%m-%dT%H:%M:%SZ")
if a is None:
    print("last_run_at unreadable")
elif a > max_age_h:
    print("STALE: last successful mirror run was %.1fh ago (limit %dh)" % (a, max_age_h))
# ONE fault must not be reported twice at two different severities. A snapshot
# that fails verification is recorded BOTH as a run error (driving ok:false, read
# here) and as a standing quarantine (read below, as a stderr NOTE) — the same
# single fact in two fields. The quarantine channel deliberately does NOT
# re-alarm, because a permanent fault re-broadcast every six hours is how a team
# learns to ignore this alarm; but ok:false then re-raised that identical fact at
# FULL severity through alarm(), whose text asserts "the backups are not being
# maintained" and ships fleet-wide with expects:"action".
#
# The asymmetry is what made it bite: MIRROR-STATE.json is rewritten only by the
# DAILY mirror run, while this probe fires 6-HOURLY. So one quarantined snapshot
# held ok:false for a full day and produced FOUR such broadcasts — each naming a
# single-provider backup outage that measurably was not happening, for a fault
# already on the books and already announced once by the mirror run that found it
# (WI-10001692).
#
# So: attribute each error to a standing quarantine and drop the ones already
# accounted for there. Anything left is a genuine run failure and still alarms at
# full severity, and an ok:false with no errors at all is still reported rather
# than silently passing — this must only ever subtract facts that another channel
# is provably already carrying.
standing_keys = {"%s/%s" % (q.get("host"), q.get("taken_at"))
                 for q in (s.get("quarantined") or [])}
errors = s.get("errors") or []
unattributed = [e for e in errors
                if not any(e.startswith(k + ":") for k in standing_keys)]
if not s.get("ok"):
    if unattributed:
        print("last run reported errors: %s" % "; ".join(unattributed)[:300])
    elif not errors:
        print("state file reports ok:false but lists no errors — state is inconsistent")
if not s.get("sealed"):
    print("mirror is NOT sealed immutable")
if int(s.get("free_gb") or 0) < min_free:
    print("disk floor: %sGB free < %dGB" % (s.get("free_gb"), min_free))
# Standing quarantines go to stderr, not into the problem list: they were
# alarmed once when they were found, and re-alarming a known-permanent fault
# every six hours is how a team learns to ignore this alarm. They stay in
# MIRROR-STATE.json and in the journal, which is where a standing fault belongs.
for q in (s.get("quarantined") or []):
    sys.stderr.write("NOTE standing quarantine: %s/%s [%s, attempts=%s, first seen %s]\n"
                     % (q.get("host"), q.get("taken_at"), q.get("classification"),
                        q.get("attempts"), q.get("first_seen")))
hosts = s.get("hosts") or {}
if not hosts:
    print("mirror holds ZERO hosts")
for h, v in hosts.items():
    if not v.get("count"):
        print("host %s holds ZERO snapshots" % h)
        continue
    na = age_h((v.get("newest") or "")[:15], "%Y%m%dT%H%M%S")
    if na is None:
        print("host %s: newest snapshot timestamp unreadable (%s)" % (h, v.get("newest")))
    elif na > max_age_h:
        print("host %s: newest snapshot is %.1fh old (limit %dh)" % (h, na, max_age_h))
PY
)
  if [ ${#problems[@]} -gt 0 ] && [ -n "${problems[0]:-}" ]; then
    for p in "${problems[@]}"; do log "HEALTH: $p"; done
    alarm "estate mirror health: ${problems[0]}"
    return 1
  fi
  # RETRACT the alarm on recovery. pc-estate-mirror-alert.sh WRITES this marker
  # and nothing anywhere cleared it, so it was a write-only latch: once any run
  # failed it asserted "the mirror is broken" forever, including inside the triage
  # text the alert broadcasts fleet-wide. That is worse than no marker, because
  # agents read its ABSENCE as evidence of health (WI-1038273 did exactly that),
  # so a stuck marker misleads in the direction of a fault that is already fixed.
  # An alarm that cannot stand down is a bug in the alarm.
  # Guarded by clear_failing_marker's own existence test on purpose: the
  # stand-down fires ONLY on the transition out of an alarm we actually raised,
  # never on an ordinary healthy run. A stand-down every 6 hours would be its own
  # spam.
  # BOTH latches are cleared here, and EITHER transition earns the stand-down.
  # Clearing only the FAILING marker is what stranded ALERT-MIRROR-DEGRADED
  # permanently: the degraded path never writes the FAILING marker, so on full
  # recovery there was nothing for clear_failing_marker() to clear, the
  # stand-down never fired, and the degraded latch — the one that gags future
  # degraded alerts — survived every healthy run that followed.
  local stood_down=0
  clear_failing_marker "mirror recovered" && stood_down=1
  clear_degraded_marker "mirror recovered" && stood_down=1
  [ "$stood_down" = 1 ] && \
    standdown "mirror healthy again as of $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "health OK"
  return 0
}

mkdir -p "$ROOT" 2>/dev/null || true
case "$MODE" in
  mirror) do_mirror ;;
  verify) do_verify ;;
  health) do_health ;;
  *) echo "usage: $0 [mirror|verify|health]" >&2; exit 2 ;;
esac
