#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Papercusp Postgres backup — EI-10733 / EI-10730 / WI-39596
#
# This file is canonical in the Papercusp staging tree. The systemd unit points
# here directly; do not restore an untracked ~/.config/kopia/db-backup.sh copy.
#
# Replaces the pg_dumpall legs of ~/.config/kopia/hooks/pre-snapshot.sh, which
# had NOT produced a usable dump since 2026-06-12 (30 days) and whose failure
# mode simultaneously wedged the release pipeline for 9h.
#
# WHAT WENT WRONG (all one defect chain):
#   1. `timeout 60 sudo -u postgres pg_dumpall | gzip` — the cluster is 29 GB
#      (papercusp alone 23 GB). It outgrew 60s around 2026-06-12 and from then
#      on was SIGKILLed mid-stream on EVERY cycle. Backup silently dead.
#   2. `timeout` signals only its DIRECT child (sudo -> pg_dumpall). pg_dumpall
#      shells out to a per-database `pg_dump` GRANDCHILD (sh -c -- pg_dump ...)
#      which does NOT die with it. The orphan holds ACCESS SHARE on every table
#      for as long as it lives; a migration needs ACCESS EXCLUSIVE and the
#      deploy runs lock_timeout=15s, so ONE orphan blocks every migration and
#      auto-rollback wedges the release. That is how :3070 sat 9h behind main.
#   3. It ran on the 5-minute kopia snapshot cycle. Even a WORKING 29 GB dump
#      cannot fit in 5 minutes, so a naive timeout bump would just reinstate
#      near-continuous ACCESS SHARE pressure on the DB the whole fleet migrates
#      against. The cadence itself was the defect -> this runs on its own timer.
#
# HOW THIS CANNOT REGRESS THE SAME WAY:
#   * NO ORPHAN IS POSSIBLE. The grandchild does not exist by construction: we
#     never run a full pg_dumpall (only --globals-only, which spawns nothing),
#     and pg_dump's -j workers are direct children it reaps itself. And because
#     a table lock is held by the BACKEND rather than the client process,
#     terminating the backend — not the process — is what actually releases it:
#     reap_own_stragglers() does that at both ends of every run, so even a
#     SIGKILLed client cannot leave a migration-blocking lock behind.
#   * NOT REAPABLE BY MISTAKE. Every HOST connection is tagged with the exact
#     host identity `pcbackup`, while the per-workspace hook uses the distinct
#     `pcbackup-workspace` identity. Cleanup may therefore reap this producer's
#     abandoned backends without terminating a healthy workspace snapshot.
#     Neither identity matches an `application_name LIKE 'pg_dump%'` reaper.
#     An age-based reaper (EI-10730's) would otherwise terminate this dump the
#     moment it legitimately ran longer than 90s.
#   * FAILURE IS LOUD. Success/failure is recorded in STATUS.json and the
#     script exits non-zero. healthcheck.sh asserts DUMP CONTENT freshness from
#     that file — not kopia snapshot recency, which is what hid this for a
#     month (kopia dutifully re-snapshotted the same 30-day-old .sql.gz every
#     5 minutes, so the backup looked perfectly healthy at the snapshot layer
#     while the payload rotted).
#
# RESTORE:  psql -f /mnt/cold-a/Backup/db-dumps/pg/globals.sql     (roles first)
#           pg_restore -d <db> -j4 /mnt/cold-a/Backup/db-dumps/pg/<db>/
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# PAPERCUSP_HOST_PG_DUMP_DIR is shared with the per-workspace pre-snapshot hook
# (packages/backup/src/host-dump-coverage.ts), which reads STATUS.json from this
# same directory to decide whether its own dump would be redundant. The two
# defaults are pinned together by host-dump-coverage-defaults.test.ts — if they
# drift, the hook simply never finds a receipt and keeps dumping, so the failure
# is a silent return of the redundancy rather than a broken backup.
# The FALLBACK moved to /mnt/backup/db-dumps on 2026-09-05 (WI-2146225).
# WI-2145150 relocated the dumps by setting Environment= on two units and left
# every fallback here naming /mnt/data/Backup/db-dumps. WI-2145397 made each
# unit carry the variable, which fixes the units — but a fallback is what runs
# when there is NO unit: a manual invocation, a new timer someone forgets to
# annotate, a test. Those silently wrote ~100G back onto the 96%-full volume
# the relocation existed to escape, re-creating the split rather than erroring.
# A default should name the volume that actually has room; the env var stays
# the override. Pinned to host-dump-coverage.ts by
# host-dump-coverage-defaults.test.ts — change both or that test goes red.
# Current default moved to /mnt/cold-a/Backup/db-dumps under WI-6554700010014799:
# /mnt/backup no longer has enough headroom for the largest tier, its atomic
# replacement, and the existing 120 GiB free-space floor. The old tree stays intact.
DUMP="${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/cold-a/Backup/db-dumps}"
BACKUP_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
# Reuse the installed shared Kopia helper for the hold lease and dump rotation.
source "$(dirname "$BACKUP_SELF")/kopia-cache-bootstrap.sh"
BACKUP_REPO_ROOT="$(git -C "$(dirname "$BACKUP_SELF")" rev-parse --show-toplevel 2>/dev/null || true)"
STATUS="$DUMP/STATUS.json"
LOG="$DUMP/db-backup.log"
BACKUP_USER="${USER:-$(id -un)}"
BACKUP_GROUP="$(id -gn)"
BACKUP_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
# Keep the producer lock in a directory owned by this producer, not under the
# Kopia cache. The latter is a relocatable symlink on managed hosts and can be
# left dangling during a cache move; a failed lock open must never look like a
# successful "previous backup still running" skip.
LOCK="${PC_BACKUP_LOCK:-$BACKUP_HOME/.cache/papercusp/db-backup.lock}"
PSQL="sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc"

# pg_dump runs as the `postgres` OS user (peer auth on the unix socket — there is
# no backup-service PG role, and TCP is scram-only), so IT opens the output files.
# The old hook dodged this by piping to a shell redirect, which the shell (as
# the backup service user) opened. -Fd cannot stream to stdout, and pg_dump chmods the
# directory it writes, so the target must be postgres-OWNED. This staging dir is
# owned by postgres and group-writable by the backup service user, so pg_dump can write and
# this script can still do the atomic swap. 0775 keeps it readable by kopia.
PGOUT="$DUMP/pg"
sudo -n install -d -o postgres -g "$BACKUP_GROUP" -m 0775 "$PGOUT" 2>/dev/null || true

# Our ownership tag. Keep distinct from packages/backup's
# WORKSPACE_BACKUP_APPLICATION_NAME: reap_own_stragglers() below is deliberately
# exact-owner cleanup, not a cluster-wide backup kill switch.
readonly HOST_BACKUP_APPLICATION_NAME=pcbackup
export PGAPPNAME="$HOST_BACKUP_APPLICATION_NAME"

# Throwaway schemas no restore needs, passed to every pg_dump as
# --exclude-schema (WI-10004136). The memory benches create a pid-scoped
# bench_memory_<pid> schema per run and DROP it at exit (BENCH_SCHEMA in
# packages/operator-core/lib/memory/bench/bench-host.ts). Measured 2026-09-30
# 04:19Z: a dump that included one held AccessShareLock on all its tables for
# 9.5 min, so the bench's DROP SCHEMA hit lock_timeout three times and the
# schema leaked. Dumping them also wastes backup time and space. pg_dump
# patterns are psql-style: `*` is any sequence, `_` is literal.
readonly DISPOSABLE_SCHEMA_PATTERN='bench_memory*'

# The host cron producer is a separate backup path from the per-workspace
# hook, but it dumps the same Postgres cluster. Hold the canonical
# backup↔migration rendezvous on a dedicated psql session around every dump of
# the migration database; otherwise a long pg_dump can acquire AccessShareLock
# while a migration is already retrying its DDL and exhaust all five short
# attempts. Hold it around THOSE dumps only — see guarded_dump_one (WI-10008166).
readonly BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'
# PostgreSQL advisory locks are DATABASE-scoped. Migration appliers connect to
# the Papercusp database; using psql's historical `postgres` catalog default
# here lets both sides hold the same numeric key simultaneously, then collide
# later on relation locks. The dedicated rendezvous session must use the same
# database as the migrations it excludes. Catalog/reaper queries above remain
# on `postgres` intentionally and are independent of this lock session.
readonly BACKUP_MIGRATION_ADVISORY_DATABASE='papercusp'
readonly BACKUP_MIGRATION_LOCK_READY='papercusp_backup_migration_lock_acquired'
BACKUP_MIGRATION_LOCK_PID=''
BACKUP_MIGRATION_LOCK_IN_FD=''
BACKUP_MIGRATION_LOCK_OUT_FD=''
BACKUP_MIGRATION_LOCK_HELD=false

# The first deadline is a STALL floor, not an unconditional kill. The transcript
# tier legitimately grew from ~98 GiB to ~105 GiB and a single-worker scheduled
# dump crossed 2700s while its output was still advancing (2026-09-26,
# EI-24357465999459516). Killing it at that instant converted a healthy producer
# into a stale-backup incident. Extend only when the directory archive grows,
# and never beyond the absolute ceiling below. A genuinely stuck dump still
# dies at the original floor. On 2026-10-15 the transcript tier reached 159 GB
# at the former 5400s ceiling and was still growing. On 2026-10-22 it hit the
# two-hour ceiling at 178,588,236,543 bytes; the retained, pg_restore-listable
# transcript archive occupied 179,791,685,043 bytes. The measured ceiling was
# too short for this workload. Allow 30 more minutes while preserving the 300s
# no-progress abort, disk-headroom guard, and six-hour freshness alarm.
TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"
TIMEOUT_MAX_SEC="${PC_BACKUP_TIMEOUT_MAX_SEC:-9000}"
PROGRESS_STALE_SEC="${PC_BACKUP_PROGRESS_STALE_SEC:-300}"
KILL_GRACE_SEC="${PC_BACKUP_KILL_GRACE_SEC:-5}"
JOBS="${PC_BACKUP_JOBS:-4}"

if ! [[ "$TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$TIMEOUT_MAX_SEC" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$PROGRESS_STALE_SEC" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$KILL_GRACE_SEC" =~ ^[0-9]+$ ]] ||
   [ "$TIMEOUT_MAX_SEC" -lt "$TIMEOUT_SEC" ]; then
  printf '[%s] FATAL: invalid backup watchdog bounds: floor=%ss max=%ss stale=%ss grace=%ss\n' \
    "$(date -Iseconds)" "$TIMEOUT_SEC" "$TIMEOUT_MAX_SEC" "$PROGRESS_STALE_SEC" "$KILL_GRACE_SEC" >&2
  exit 1
fi

# ── DISK HEADROOM ───────────────────────────────────────────────────────────
# Until 2026-09-03 this script never looked at free space AT ALL, and the shape
# of a -Fd dump makes that specifically dangerous: "$out.tmp" is written
# ALONGSIDE the existing "$out" and only swapped at the very end (see the atomic
# swap below), so a run transiently needs ~2x one database's dump on disk — and
# it needs it on a volume this script shares with everything else.
#
# MEASURED FAILURE (2026-09-03, WI-2143109): /mnt/data was already 97% full when
# the hourly timer fired. papercusp.tmp reached 85 GB, free space fell 590 GB/h,
# and the volume was ~20 minutes from ZERO. Filling it does not merely fail the
# backup: /mnt/data carries the Windows VM image and Postgres' own backup tree,
# and the owner's two VMs were already stalling on 25 ms NVMe write latency with
# a 160-deep queue. The observable symptom reported by a human was "why is the
# VM so laggy", followed by a CLOCK_WATCHDOG_TIMEOUT BSOD in the guest — i.e.
# this script's missing precondition surfaced as someone else's crash.
#
# So: refuse to start without headroom, refuse a database whose own last dump
# would not fit, and abort mid-flight rather than consume the last of the disk.
# Loud failure is the point — a skipped backup is recoverable, a full volume is
# an outage. All three are overridable for a deliberate one-off restore test.
#
# ⚠ Do NOT "fix" a headroom refusal by lowering these. The refusal means the
# volume is too full for a backup to be safe; the repair is to reclaim space.
PC_BACKUP_MIN_FREE_GB="${PC_BACKUP_MIN_FREE_GB:-120}"   # hard floor: never go below this
PC_BACKUP_SPACE_SAFETY="${PC_BACKUP_SPACE_SAFETY:-140}" # % of last dump size to require free
PC_BACKUP_WATCH_SEC="${PC_BACKUP_WATCH_SEC:-15}"        # mid-flight free-space poll interval

# Free GiB on the volume that actually holds the dumps. Reads $PGOUT rather than
# a hardcoded path so an overridden PAPERCUSP_HOST_PG_DUMP_DIR is measured on
# ITS OWN filesystem — a guard that measures the wrong volume is worse than no
# guard, because it reports headroom that does not exist where we are writing.
fs_avail_gb() {
  local kb
  kb=$(df --output=avail -k "$PGOUT" 2>/dev/null | tail -1 | tr -d '[:space:]')
  [ -n "$kb" ] || { echo 0; return; }   # unreadable df ⇒ report 0 ⇒ fail closed
  echo $(( kb / 1048576 ))
}

# Databases that are NOT real state: per-test, scratch, repro, e2e, gym fixtures.
# Deny-list (not an allow-list) so a genuinely new production DB is picked up
# automatically instead of being silently skipped.
# ^tmpl_ and ^papercusp_it_baseline_ are the test harness's migration templates
# (tmpl_<key>, tmpl_bld_*, tmpl_gym_*: libs/test-config/src/pg-migrate.ts) and its
# throwaway integration baselines (baseline-schema-global-setup.ts). Measured
# 2026-10-06: 17 + 7 of them were dumped every hour, and one dropped mid-run
# failed the whole backup (EI-25211496463956189, WI-10006723).
EXCLUDE_RE='(_test$|_e2e|^e2e|^repro_|scratch|restore_check|gym_smoke|^template|^tmpl_|^papercusp_it_baseline_)'

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG" >&2; }

if ! mkdir -p "$DUMP"; then
  printf '[%s] FATAL: unable to create backup dump directory %s\n' \
    "$(date -Iseconds)" "$DUMP" >&2
  exit 1
fi

# STATUS.json is a completion receipt, so publish a separate, bounded signal
# while this writer is active. The consumer verifies the PID generation against
# /proc and ignores a stale marker left by SIGKILL. This marker is best-effort;
# it must never turn a bookkeeping failure into a skipped backup.
HOST_BACKUP_PROGRESS_PATH="$DUMP/IN_PROGRESS.$$.json"
write_host_backup_progress_marker() {
  local stat_line start_ticks started_at tmp
  stat_line=$(cat "/proc/$$/stat" 2>/dev/null) || return 0
  start_ticks=$(printf '%s\n' "$stat_line" | awk '{ sub(/^.*\) /, ""); print $20 }')
  [[ "$start_ticks" =~ ^[0-9]+$ ]] || return 0
  started_at=$(date +%s)
  [[ "$started_at" =~ ^[0-9]+$ ]] || return 0
  tmp="${HOST_BACKUP_PROGRESS_PATH}.tmp.$$"
  if ! printf '{"pid":%s,"processStartTicks":"%s","startedAtEpoch":%s,"phase":"host-backup"}\n' \
      "$$" "$start_ticks" "$started_at" >"$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  mv -f "$tmp" "$HOST_BACKUP_PROGRESS_PATH" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}
cleanup_host_backup_progress_marker() {
  [ -z "${HOST_BACKUP_PROGRESS_PATH:-}" ] || \
    rm -f "$HOST_BACKUP_PROGRESS_PATH" "${HOST_BACKUP_PROGRESS_PATH}.tmp.$$" 2>/dev/null || true
}
trap cleanup_host_backup_progress_marker EXIT
write_host_backup_progress_marker

if ! mkdir -p "$(dirname "$LOCK")"; then
  log "FATAL: unable to create backup lock directory $(dirname "$LOCK") — refusing to skip this backup"
  exit 1
fi

# ── The dump directory OWNS its .kopiaignore ────────────────────────────────
# This script writes each dump to <db>.tmp (mode 0700 postgres) and renames it
# into place only after chown+validate. A kopia sweep that walks a .tmp catches
# a half-written dump — never the backup of record, and on a ~90G database that
# is a large pointless upload into a repo living on a 96%-full volume.
#
# The rule existed. It lived ONLY as an untracked .kopiaignore sitting in the
# dump directory, owned by nobody — so when WI-2145150 relocated the dumps to
# /mnt/backup/db-dumps the file did not travel, and the protection silently
# ceased to exist. That is the SAME failure shape as this work-item's other two
# defects: state kept outside the tree does not survive a move, and its absence
# raises no error anywhere. The durable answer is not to re-place the file by
# hand at the new path — it is to make the producer provision it, so the rule
# arrives wherever the dumps do, including the next relocation.
#
# Idempotent and non-clobbering: create it when absent, otherwise only ensure
# each REQUIRED rule is present. Operators legitimately add their own
# exclusions here, and this must never eat them — we only ever append.
#
# ensure_kopiaignore_rule <rule> <why>
# Appends <rule> only when that exact line is absent. Never rewrites, never
# reorders, never removes. Safe to call repeatedly and in any order.
ensure_kopiaignore_rule() {
  local rule="$1" why="${2:-}"
  if [ ! -f "$DUMP/.kopiaignore" ]; then
    printf '%s\n' \
      '# Provisioned by papercusp-db-backup.sh (WI-2146225) so the rules travel' \
      '# with the dump dir — including across the next relocation.' \
      '' > "$DUMP/.kopiaignore"
    log ".kopiaignore provisioned at $DUMP (was missing)"
  fi
  if ! grep -qxF "$rule" "$DUMP/.kopiaignore"; then
    [ -n "$why" ] && printf '%s\n' "" "# $why" >> "$DUMP/.kopiaignore"
    printf '%s\n' "$rule" >> "$DUMP/.kopiaignore"
    log ".kopiaignore at $DUMP was missing '$rule' — appended"
  fi
}

ensure_kopiaignore_rule '*.tmp' \
  'In-progress dumps: <db>.tmp is mode 0700 postgres and is renamed into place only after validation. Never the backup of record.'

# Single instance. A backup still running when the next timer fires must not be
# joined by a second one (that is WI-3550's overlap failure, on a bigger job).
if ! exec 9>"$LOCK"; then
  log "FATAL: unable to open backup lock $LOCK — refusing to report a skipped run"
  exit 1
fi
if ! flock -n 9; then
  log "skipped: previous backup still running"
  # 75 (EX_TEMPFAIL) is the systemd unit's intentional-defer status. Returning
  # zero records a successful run even though no artifact advanced, masking a
  # stale recovery point until the health probe notices it.
  exit 75
fi

renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

# ── pre-flight headroom gate ────────────────────────────────────────────────
# Before anything is written. Deliberately exits NON-ZERO and does NOT touch
# STATUS.json: healthcheck.sh asserts dump-content freshness from that file, so
# leaving it stale is what makes a refused backup visible as an aging dump
# rather than a fresh-looking success. Writing a "skipped" receipt here would
# hide exactly the condition an operator needs to see.
PC_FREE_GB=$(fs_avail_gb)
if [ "$PC_FREE_GB" -lt "$PC_BACKUP_MIN_FREE_GB" ]; then
  log "REFUSED: only ${PC_FREE_GB} GiB free on $(df --output=target "$PGOUT" 2>/dev/null | tail -1) — below the ${PC_BACKUP_MIN_FREE_GB} GiB floor."
  log "REFUSED: not dumping. A -Fd dump writes a full second copy before its atomic swap, so starting here risks filling the volume."
  log "REFUSED: reclaim space (this volume also carries VM images and the offsite staging tree); do NOT just lower PC_BACKUP_MIN_FREE_GB."
  exit 1
fi
log "headroom ok: ${PC_FREE_GB} GiB free (floor ${PC_BACKUP_MIN_FREE_GB} GiB)"

# ── mid-flight headroom watchdog ────────────────────────────────────────────
# The pre-flight gate can pass and the dump can STILL eat the volume: the
# database may have grown since its last dump, and the estimate below is only an
# estimate. So poll while the dump runs and abort it if free space reaches the
# floor. Aborting costs one backup cycle; not aborting costs the whole box.
#
# Kills BOTH ways on purpose, matching this script's own doctrine above: the
# client process (so `timeout`'s child stops writing) AND the backend via
# reap_own_stragglers (because a table lock is held by the BACKEND — killing the
# client alone proves nothing). Never a name/pattern kill: we hold the real PID.
run_bounded_watched() {
  local floor_secs="$1" max_secs="$2" progress_path="$3"; shift 3
  local rc=0 dump_pid watch_pid start_epoch now_epoch elapsed
  local last_bytes=0 last_progress_epoch=0 current_bytes=0 progress_path_seen=0
  start_epoch=$(date +%s)
  last_progress_epoch="$start_epoch"
  "$@" &
  dump_pid=$!
  (
    while kill -0 "$dump_pid" 2>/dev/null; do
      sleep "$PC_BACKUP_WATCH_SEC"
      now=$(fs_avail_gb)
      if [ "$now" -lt "$PC_BACKUP_MIN_FREE_GB" ]; then
        log "ABORTING DUMP: free space fell to ${now} GiB (floor ${PC_BACKUP_MIN_FREE_GB} GiB) while dumping — killing this dump to protect the volume"
        kill -TERM "$dump_pid" 2>/dev/null
        sleep 5
        kill -KILL "$dump_pid" 2>/dev/null
        reap_own_stragglers
        return 0
      fi

      now_epoch=$(date +%s)
      elapsed=$(( now_epoch - start_epoch ))
      # A -Fd producer may not have created its output directory by the first
      # watch sample. Treat that startup interval as zero bytes while the free
      # space floor and elapsed watchdog remain active. Once observed, a missing
      # or unreadable path is still an immediate measurement failure.
      if [ ! -e "$progress_path" ] && [ "$progress_path_seen" -eq 0 ]; then
        current_bytes=0
      else
        progress_path_seen=1
        measurement_output=$(sudo -n -u postgres du -sb "$progress_path" 2>&1)
        measurement_rc=$?
        current_bytes=${measurement_output%%$'\t'*}
        if [ "$measurement_rc" -ne 0 ] || ! [[ "$current_bytes" =~ ^[0-9]+$ ]]; then
          measurement_detail=$(printf '%s' "$measurement_output" | tr '\r\n' ' ')
          measurement_detail=${measurement_detail:0:240}
          log "ABORTING DUMP: unable to measure archive progress at $progress_path as postgres (du_status=$measurement_rc output=${measurement_detail:-<empty>}); terminating bounded producer"
          kill -TERM "$dump_pid" 2>/dev/null
          sleep "$KILL_GRACE_SEC"
          kill -KILL "$dump_pid" 2>/dev/null
          reap_own_stragglers
          return 0
        fi
      fi
      if [ "$current_bytes" -gt "$last_bytes" ]; then
        last_bytes="$current_bytes"
        last_progress_epoch="$now_epoch"
      fi

      if [ "$elapsed" -ge "$max_secs" ]; then
        log "ABORTING DUMP: absolute watchdog ceiling ${max_secs}s reached (output ${last_bytes} bytes); killing bounded producer"
      elif [ "$elapsed" -ge "$floor_secs" ] &&
           [ $(( now_epoch - last_progress_epoch )) -ge "$PROGRESS_STALE_SEC" ]; then
        log "ABORTING DUMP: no archive growth for ${PROGRESS_STALE_SEC}s after ${floor_secs}s floor (output ${last_bytes} bytes); killing stalled producer"
      else
        continue
      fi

      kill -TERM "$dump_pid" 2>/dev/null
      sleep "$KILL_GRACE_SEC"
      kill -KILL "$dump_pid" 2>/dev/null
      reap_own_stragglers
      return 0
    done
  ) &
  watch_pid=$!
  wait "$dump_pid"; rc=$?
  kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
  return "$rc"
}

# ── orphan sweep ────────────────────────────────────────────────────────────
# Reap by PROVENANCE, not age. Anything named pg_dump* is BY DEFINITION not us
# (we use the exact host identity above), so it is a stray or an orphan from the old broken hook —
# never a healthy dump of ours. This is the predicate EI-10730's reaper should
# have used: its age-based rule ("older than 60s must be an orphan") is only
# true while the dump is broken, and would execute this script's own dump.
reap_foreign_dumps() {
  local pids
  pids=$($PSQL "SELECT string_agg(pid::text,' ') FROM pg_stat_activity
                 WHERE application_name LIKE 'pg_dump%'
                   AND backend_start < now() - interval '5 minutes';" 2>/dev/null | tr -d '[:space:]')
  [ -z "$pids" ] && return 0
  $PSQL "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name LIKE 'pg_dump%'
            AND backend_start < now() - interval '5 minutes';" >/dev/null 2>&1
  log "reaped foreign/orphaned pg_dump backend(s) holding table locks: $pids"
}

# Kill any backend WE left behind (e.g. if we were SIGKILLed and the process
# group kill below never ran). Locks are held by the BACKEND, not the client,
# so killing the process is not sufficient — terminate the backend.
reap_own_stragglers() {
  $PSQL "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = '$HOST_BACKUP_APPLICATION_NAME' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
}

# Release the dedicated advisory-lock backend. The EXIT trap is the safety net
# for every failure path, including a timeout/oom before the final cleanup.
# Closing the psql session releases the session-level advisory lock even when
# the explicit \q cannot be delivered because the backend was already reaped.
release_migration_rendezvous() {
  if [ "${BACKUP_MIGRATION_LOCK_HELD:-false}" != true ] && \
     [ -n "${BACKUP_MIGRATION_LOCK_PID:-}" ]; then
    # Acquisition may have failed before Bash published either coprocess FD.
    # Kill the client first so the following wait cannot strand the EXIT path.
    kill "$BACKUP_MIGRATION_LOCK_PID" 2>/dev/null || true
  fi
  if [ -n "${BACKUP_MIGRATION_LOCK_IN_FD:-}" ]; then
    if [ "${BACKUP_MIGRATION_LOCK_HELD:-false}" = true ]; then
      printf '\\q\n' >&"$BACKUP_MIGRATION_LOCK_IN_FD" 2>/dev/null || true
    fi
    exec {BACKUP_MIGRATION_LOCK_IN_FD}>&- 2>/dev/null || true
  fi
  if [ -n "${BACKUP_MIGRATION_LOCK_PID:-}" ]; then
    wait "$BACKUP_MIGRATION_LOCK_PID" 2>/dev/null || true
  fi
  if [ -n "${BACKUP_MIGRATION_LOCK_OUT_FD:-}" ]; then
    exec {BACKUP_MIGRATION_LOCK_OUT_FD}<&- 2>/dev/null || true
  fi
  if [ "${BACKUP_MIGRATION_LOCK_HELD:-false}" = true ]; then
    # The hold length is the number a waiting migration pays; log it so a
    # regression to a whole-run hold is visible in the journal (WI-10008166).
    log "migration rendezvous released after $(( $(date +%s) - ${BACKUP_MIGRATION_LOCK_SINCE:-$(date +%s)} ))s (${BACKUP_MIGRATION_LOCK_LEG:-host dump})"
  fi
  BACKUP_MIGRATION_LOCK_PID=''
  BACKUP_MIGRATION_LOCK_IN_FD=''
  BACKUP_MIGRATION_LOCK_OUT_FD=''
  BACKUP_MIGRATION_LOCK_HELD=false
  BACKUP_MIGRATION_LOCK_SINCE=''
  BACKUP_MIGRATION_LOCK_LEG=''
}

trap 'release_migration_rendezvous; cleanup_host_backup_progress_marker' EXIT

# Ask kopia-backup-guard.sh to hand the host-wide Kopia lock back while this
# script goes on running (WI-10004870). The guard holds that lock, not this
# script, so it can only be asked: creating KOPIA_BACKUP_GUARD_RELEASE_PATH does
# it, and the guard unlocks within one monitor interval while still waiting for
# us. Call it only once nothing left in the run writes a snapshotted artifact.
# Outside the guard (a manual run) the variable is unset and this is a no-op.
release_shared_backup_lock() {
  [ -n "${KOPIA_BACKUP_GUARD_RELEASE_PATH:-}" ] || return 0
  if : >"$KOPIA_BACKUP_GUARD_RELEASE_PATH" 2>/dev/null; then
    log "shared backup lock: early release requested before the local-only transcript tier(s) of: $*"
  else
    log "WARNING: could not ask the guard to release the shared backup lock ($KOPIA_BACKUP_GUARD_RELEASE_PATH); it stays held to the end of the run"
  fi
}

# Acquire the shared rendezvous on a session that remains open while the
# guarded pg_dump runs. A one-shot `psql -c pg_advisory_lock` would release the
# lock as soon as psql exits, so use a coprocess and keep its stdin open until
# release_migration_rendezvous closes it. The marker is emitted only after the
# advisory lock has been granted, making the hand-off observable and preventing
# the pg_dump from racing the lock wait. Re-acquirable: release reaps the
# coprocess, so each guarded leg opens its own session. $1 names the leg.
acquire_migration_rendezvous() {
  local line acquired=false leg="${1:-host dump}"
  coproc BACKUP_MIGRATION_LOCK_PSQL {
    exec sudo -n -u postgres env "PGAPPNAME=$HOST_BACKUP_APPLICATION_NAME" \
      psql -X -q -v ON_ERROR_STOP=1 -At \
      -h /var/run/postgresql -d "$BACKUP_MIGRATION_ADVISORY_DATABASE"
  }
  # `sudo` can fail before Bash publishes the named-coproc descriptors (for
  # example when the database service is down). Read these with nounset-safe
  # defaults so that failure becomes a clean backup refusal, not an opaque
  # shell error before the EXIT cleanup can run.
  BACKUP_MIGRATION_LOCK_PID="${BACKUP_MIGRATION_LOCK_PSQL_PID:-}"
  BACKUP_MIGRATION_LOCK_IN_FD="${BACKUP_MIGRATION_LOCK_PSQL[1]:-}"
  BACKUP_MIGRATION_LOCK_OUT_FD="${BACKUP_MIGRATION_LOCK_PSQL[0]:-}"
  if [ -z "$BACKUP_MIGRATION_LOCK_PID" ] || \
     [ -z "$BACKUP_MIGRATION_LOCK_IN_FD" ] || \
     [ -z "$BACKUP_MIGRATION_LOCK_OUT_FD" ]; then
    log "backup FAIL — migration rendezvous session could not start"
    release_migration_rendezvous
    return 1
  fi
  printf '%s\n' \
    'SET lock_timeout = 0;' \
    'SET statement_timeout = 0;' \
    "SELECT pg_advisory_lock(hashtext('$BACKUP_MIGRATION_ADVISORY_LOCK_KEY'));" \
    "\\echo $BACKUP_MIGRATION_LOCK_READY" \
    >&"$BACKUP_MIGRATION_LOCK_IN_FD" || {
      log "backup FAIL — could not send migration rendezvous request"
      release_migration_rendezvous
      return 1
    }
  while IFS= read -r -u "$BACKUP_MIGRATION_LOCK_OUT_FD" line; do
    if [ "$line" = "$BACKUP_MIGRATION_LOCK_READY" ]; then
      acquired=true
      break
    fi
  done
  if [ "$acquired" != true ]; then
    log "backup FAIL — migration rendezvous session exited before acquiring the advisory lock"
    release_migration_rendezvous
    return 1
  fi
  BACKUP_MIGRATION_LOCK_HELD=true
  BACKUP_MIGRATION_LOCK_SINCE=$(date +%s)
  BACKUP_MIGRATION_LOCK_LEG="$leg"
  log "migration rendezvous acquired for $leg"
}

# guarded_dump_one <db> <label> [extra pg_dump args...] — dump_one, holding the
# migration rendezvous for exactly that dump when <db> is the migration database.
#
# Only a dump of $BACKUP_MIGRATION_ADVISORY_DATABASE can collide with a papercusp
# migration: the advisory lock AND the relation locks a pg_dump takes are both
# per-database, and every migration applier connects to that one database. So
# holding the rendezvous across any other leg — the other databases on this
# cluster, oddsmith on its own server — blocks every papercusp migration while
# protecting nothing. MEASURED 2026-10-10 (WI-10008166): the old whole-run hold
# (acquired before the first dump, released after the transcript tier) covered
# ~15 GB of unrelated databases plus a 35-min oddsmith dump on top of the two
# papercusp tiers, ~3.4 h end to end. Armed migrations 1438-1440 waited out all
# of it, and bg-host withheld the background plane until they applied.
#
# Each guarded leg takes its own session, so a waiting migration runs BETWEEN
# legs. The tiers are separate pg_dump snapshots already, so nothing assumed
# cross-leg consistency. A rendezvous that cannot be acquired fails THAT leg —
# recorded like any dump failure — rather than dumping unguarded or aborting the
# legs still to come.
guarded_dump_one() {
  local db="$1" label="$2" rc=0
  if [ "$db" != "$BACKUP_MIGRATION_ADVISORY_DATABASE" ]; then
    dump_one "$@"
    return
  fi
  if ! acquire_migration_rendezvous "$label"; then
    log "$label FAIL — migration rendezvous not acquired; leg not dumped"
    return 1
  fi
  dump_one "$@" || rc=$?
  release_migration_rendezvous
  reap_own_stragglers   # nothing of ours may outlive the hold holding locks
  return "$rc"
}

# Bounded run. NOTE the grandchild trap of EI-10730 does not exist here BY
# CONSTRUCTION: it is specific to a full `pg_dumpall`, which shells out to a
# per-database `pg_dump` (sh -c -- pg_dump ...) that does not die with it. We
# never do that — `pg_dump` is invoked directly (its -j workers are direct
# children it reaps itself), and `pg_dumpall --globals-only` spawns nothing.
#
# The real guarantee is PG-side regardless: a table lock is held by the BACKEND,
# not by the client process, so killing a client proves nothing and
# pg_terminate_backend is authoritative. That is what reap_own_stragglers is —
# and it is why this cannot leave a migration-blocking lock behind even if the
# client is SIGKILLed.
run_bounded() {
  local secs="$1"; shift
  timeout --kill-after=20s "$secs" "$@"
}

START=$(date +%s)
reap_own_stragglers
reap_foreign_dumps
# No whole-run rendezvous: guarded_dump_one holds it around each dump of the
# migration database only (WI-10008166).

FAILED=()
DUMPED=()

# ── globals (roles, tablespaces) — tiny, but a restore is useless without them
if run_bounded 120 sudo -n -u postgres env "PGAPPNAME=$HOST_BACKUP_APPLICATION_NAME" \
      pg_dumpall -h /var/run/postgresql --globals-only -f "$PGOUT/globals.sql.tmp"; then
  mv -f "$PGOUT/globals.sql.tmp" "$PGOUT/globals.sql"
  log "globals ok ($(stat -c%s "$PGOUT/globals.sql") bytes)"
else
  rm -f "$PGOUT/globals.sql.tmp"; FAILED+=("globals"); log "globals FAIL"
fi

# ── per-database, parallel directory format ─────────────────────────────────
# -Fd + -j is the only pg_dump format that parallelises; pg_dumpall is
# plain-text-only and single-threaded, which is a large part of why the old
# hook could not finish.
#
# Do NOT add pg_dump compression here. Kopia is the single compression layer
# (zstd) for this source. Compressing each full logical dump before Kopia sees
# it destroys content-defined chunk reuse across hourly rewrites: the measured
# -Z1 writer made the first post-dump snapshot upload 6.3 GB while an unchanged
# follow-up uploaded 0 B. Uncompressed directory members let Kopia deduplicate
# stable COPY data while preserving the hourly recovery-point objective.
# INVALID databases (WI-10003455). A DROP DATABASE interrupted mid-flight (PG ≥15)
# leaves the catalog row behind with datconnlimit = -2 — and datallowconn still
# TRUE, so the old `AND datallowconn` filter admitted them. pg_dump then fails
# with "cannot connect to invalid database", and every such leftover turned the
# whole unit red (measured 2026-09-27: 18 of them, exit 1 on EVERY hourly run
# while the real papercusp tiers dumped fine). A red that never clears is noise
# that masks the real failure it exists to report.
#
# An invalid database holds nothing restorable — Postgres refuses every
# connection to it by definition, so there is nothing pg_dump COULD capture.
# Skipping it loses no data. It is NOT silent: each one is logged and listed
# in STATUS.json's "invalidSkipped" so the leak stays visible to whoever reaps it.
DB_SELECT_SQL="SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn AND datconnlimit <> -2;"
INVALID_DB_SQL="SELECT datname FROM pg_database WHERE datconnlimit = -2;"
DBS=$(sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc \
       "$DB_SELECT_SQL" 2>/dev/null \
       | grep -vE "$EXCLUDE_RE")
INVALID_SKIPPED=()
# WI-10006723: databases enumerated above but DROPPED before their turn came. A
# run dumps sequentially for an hour or more, so a scratch database created and
# dropped by a test or rehearsal inside that window used to fail its pg_dump
# ("database ... does not exist") and turn the whole run red. Filled by the dump
# loop below and listed in STATUS.json's "vanishedSkipped", never in "failed".
VANISHED_SKIPPED=()
while IFS= read -r inv; do
  [ -n "$inv" ] || continue
  INVALID_SKIPPED+=("$inv")
done < <(sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc "$INVALID_DB_SQL" 2>/dev/null)
if [ ${#INVALID_SKIPPED[@]} -gt 0 ]; then
  log "WARN skipping ${#INVALID_SKIPPED[@]} INVALID database(s) (datconnlimit=-2, interrupted DROP DATABASE — nothing dumpable; reap with DROP DATABASE): ${INVALID_SKIPPED[*]}"
fi

# Remove a "$db.tmp" that pg_dump created as postgres.
#
# pg_dump -Fd writes its output dir 0700 postgres:postgres. On the SUCCESS path
# we chown it back (below), so a plain `rm -rf` works. On the FAILURE path the
# chown never runs — and THIS script runs as the backup service user, so `rm -rf` on that
# 0700 postgres-owned dir dies with "Permission denied". That turned a single
# bad dump into a PERMANENT one: the leftover .tmp survived, and because
# pg_dump -Fd refuses a non-empty target, every later run failed the same way.
# Found 2026-07-26: a 1.3G papercusp.tmp stranded from one 00:01 failure, with
# the real pg_dump error never recorded anywhere. Route EVERY tmp removal
# through sudo so a failed dump can always be cleaned up.
rm_tmp() {
  [ -e "$1" ] || return 0
  rm -rf "$1" 2>/dev/null || sudo -n rm -rf "$1" 2>/dev/null || {
    log "WARN could not remove stale tmp $1 — the next run of this db will fail until it is removed by hand"
    return 1
  }
}

# dump_one <db> <label> [extra pg_dump args...]
#
# WHY A FUNCTION (WI-2146225). This body carries every safety property the
# EI-10733 family cost us to learn: the space precondition, the postgres->service
# chown/chmod that keeps the artifact readable by BOTH the archiver and
# pg_restore, the pg_restore -l validation that refuses to trust an exit code,
# the atomic swap that leaves last-known-good intact on failure, and the stderr
# capture that makes a failure diagnosable. The tiered dumps below need ALL of
# them. Copying the body would have produced a second dump path that silently
# drifts out of those guarantees — which is the exact shape of every bug in the
# header comment.
#
# Returns 0 dumped, 1 failed, 2 skipped for space. The CALLER records the
# outcome, because different callers must account for failure differently (see
# the tier pass: a tier failure must not redden a healthy authoritative dump).
dump_one() {
  local db="$1" label="$2"; shift 2
  local out="$PGOUT/$label"
  local prev_gb prev_kb need_gb avail_gb dumperr rc sz detail
  rm_tmp "$out.tmp"

  # Per-database precondition. The previous successful dump of THIS database is
  # the only honest size estimate available before dumping it, and it is a
  # LOWER bound (the db only grows between runs) — hence the safety multiplier.
  # Requiring need + floor, not just need, is the point: finishing a dump with
  # 2 GiB left is not a success, it is the same outage one cycle later.
  #
  # A database with no previous dump (first run, or last run failed) has no
  # estimate, so it is gated on the floor alone — the pre-flight check above.
  # That is deliberate: refusing a brand-new database forever because it has
  # never been dumped would be a guard that prevents its own precondition.
  prev_gb=0
  if [ -d "$out" ]; then
    prev_kb=$(du -sk "$out" 2>/dev/null | cut -f1)
    [ -n "$prev_kb" ] && prev_gb=$(( prev_kb / 1048576 ))
  fi
  need_gb=$(( prev_gb * PC_BACKUP_SPACE_SAFETY / 100 ))
  avail_gb=$(fs_avail_gb)
  if [ "$prev_gb" -gt 0 ] && [ "$avail_gb" -lt $(( need_gb + PC_BACKUP_MIN_FREE_GB )) ]; then
    log "$label SKIPPED — needs ~${need_gb} GiB (last dump ${prev_gb} GiB x ${PC_BACKUP_SPACE_SAFETY}%) plus the ${PC_BACKUP_MIN_FREE_GB} GiB floor, but only ${avail_gb} GiB free; previous dump left intact"
    return 2
  fi

  dumperr=$(mktemp -t "pcbackup-$label-XXXXXX.err")
  if run_bounded_watched "$TIMEOUT_SEC" "$TIMEOUT_MAX_SEC" "$out.tmp" \
        sudo -n -u postgres env "PGAPPNAME=$HOST_BACKUP_APPLICATION_NAME" \
        pg_dump -h /var/run/postgresql -Fd -j "$JOBS" --compress=none \
          --exclude-schema="$DISPOSABLE_SCHEMA_PATTERN" "$@" -f "$out.tmp" "$db" 2>"$dumperr"; then

    # pg_dump chmods its -Fd output to 0700 postgres:postgres. Left that way the
    # dump is UNREADABLE BY KOPIA (which runs as the backup service user), so it would never
    # leave this box — a silently-useless backup, i.e. the very failure this
    # script exists to end, wearing a different mask. Hand it back to us.
    #
    # But note there are TWO readers, not one, and they are different users:
    #   * backup archiver + this script -> service user (gets it off the box, swaps it)
    #   * pg_restore, at RESTORE   -> postgres       (peer auth on the socket is the
    #                                 only superuser path here: the service user has no
    #                                 PG role and TCP is scram-only)
    # Chowning to the service user at 0700 served the first and locked out
    # the second, so the artifact was readable by the process that ARCHIVES it and
    # unreadable by the process that RESTORES it — a backup you cannot restore is
    # the same class of silently-useless backup as one that never leaves the box.
    # Measured 2026-08-11 (WI-37835) by actually running the restore drill:
    # `pg_restore: error: could not open input file ".../toc.dat": Permission
    # denied`, and note the files were already 0664 — it was the DIRECTORY's
    # missing group-traverse bit that blocked it, which is why the failure reads
    # as a file error. Group=postgres + g=rX serves both readers and still
    # excludes everyone else (o= also tightens the previously world-readable
    # members). Modes are set explicitly rather than via +X so the result does not
    # depend on what pg_dump happened to write.
    sudo -n chown -R "${BACKUP_USER}:postgres" "$out.tmp"
    sudo -n chmod -R u=rwX,g=rX,o= "$out.tmp"

    # VALIDATE THE ARTIFACT, don't trust the exit code. The whole EI-10733 bug
    # family is "reported success while producing nothing usable", so a dump is
    # only 'ok' if pg_restore can actually read its table of contents.
    if ! pg_restore -l "$out.tmp" >/dev/null 2>&1; then
      rm_tmp "$out.tmp"
      log "$label FAIL — dump completed but is NOT a valid archive (pg_restore -l could not read it); previous dump left intact"
      rm -f "$dumperr"
      return 1
    fi

    # Atomic swap, NO local ".prev". A previous version of this kept "$out.prev"
    # as last-known-good, but (a) kopia already versions every snapshot
    # (latest/hourly/daily/weekly/monthly) — the offsite repo IS the
    # previous-version store, so a local copy is pure redundancy that doubles
    # the on-disk footprint; and (b) each .prev inherited the dump's original
    # 0700 postgres:postgres perms, leaving a directory KOPIA COULD NOT READ and
    # erroring its snapshot of db-dumps every cycle (found 2026-07-12: errors:4).
    # On FAILURE we still leave the existing "$out" untouched (see the branch
    # above), so last-known-good survives a bad run without any .prev.
    if [ "$db" = "$BACKUP_MIGRATION_ADVISORY_DATABASE" ]; then
      if ! kopia_with_hold_lease "$db" kopia_install_dump_if_held "$out"; then
        log "$label FAIL — legal-hold rotation lease unavailable; previous dump preserved"
        rm -f "$dumperr"
        return 1
      fi
    else
      rm -rf "$out"
      mv -f "$out.tmp" "$out"
    fi
    sz=$(du -sb "$out" 2>/dev/null | cut -f1)
    log "$label ok ($(numfmt --to=iec "${sz:-0}" 2>/dev/null || echo "${sz:-0}") , $(pg_restore -l "$out" 2>/dev/null | grep -c '^[0-9]') objects)"
    rm -f "$dumperr"
    return 0
  else
    rc=$?
    rm_tmp "$out.tmp"
    # Say WHY. The old line logged "timeout ${TIMEOUT_SEC}s or dump error" and
    # discarded pg_dump's stderr entirely, so a failure was undiagnosable after
    # the fact — the same detector gap that let EI-10733 rot silently for 30
    # days. An unresolved OR is not a diagnosis: record the exit code and the
    # actual error text.
    detail=$(tr '\n' ' ' <"$dumperr" 2>/dev/null | tail -c 400)
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] || [ "$rc" -eq 143 ]; then
      log "$label FAIL — watchdog stopped dump after ${TIMEOUT_SEC}s floor / ${TIMEOUT_MAX_SEC}s max (exit $rc); previous dump left intact${detail:+ — stderr: $detail}"
    else
      log "$label FAIL — pg_dump exit $rc; previous dump left intact${detail:+ — stderr: $detail}"
    fi
    rm -f "$dumperr"
    return 1
  fi
}

# ── tier configuration — declared HERE because it decides the pass below ────
# These two live above the undifferentiated pass, not beside the tier pass that
# uses the rest of the tier config, because as of the 2026-09-05 cutover they
# DECIDE THIS PASS'S MEMBERSHIP: a tiered database is dumped as its tier pair
# INSTEAD of whole, not as well as. Moving them back down silently re-enables
# the double dump.
PC_BACKUP_TIERS_ENABLED="${PC_BACKUP_TIERS_ENABLED:-1}"
PC_BACKUP_TIER_DBS="${PC_BACKUP_TIER_DBS:-papercusp}"

# is_tiered <db> — true when THIS run dumps $db as a tier pair instead of whole.
# Setting PC_BACKUP_TIERS_ENABLED=0 is the escape hatch and it is complete: the
# database falls straight back into the undifferentiated pass below, so disabling
# tiers can never leave it undumped. That fallback is also why "$db" itself is NOT
# written into .kopiaignore — an ignore rule would survive the fallback and turn it
# into silent zero coverage, which is the failure this whole work-item repairs.
is_tiered() {
  [ "$PC_BACKUP_TIERS_ENABLED" = 1 ] || return 1
  case " $PC_BACKUP_TIER_DBS " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# db_presence <db> — prints "present", "absent", or "unknown" (WI-10006723).
#
# Asked only AFTER a dump failed, to tell "the database was dropped while this
# run was working through the list" apart from a real dump failure. "absent"
# also covers a database invalidated by an interrupted DROP since enumeration,
# because that is the same event caught half-way.
#
# The answer must never manufacture "absent": a failed or empty catalog read is
# "unknown", and the caller then counts the dump as FAILED. The query runs while
# connected to the postgres database, so a successful read always lists at least
# that one name; an empty list therefore means the read itself went wrong.
DB_PRESENT_SQL="SELECT datname FROM pg_database WHERE datconnlimit <> -2;"
db_presence() {
  local names
  names=$(sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc \
            "$DB_PRESENT_SQL" 2>/dev/null) || { echo unknown; return 0; }
  [ -n "$names" ] || { echo unknown; return 0; }
  if printf '%s\n' "$names" | grep -Fxq -- "$1"; then echo present; else echo absent; fi
}

for db in $DBS; do
  # RETIRED 2026-09-05 (WI-2146225): the undifferentiated papercusp dump. It was
  # 94G written every hour beside 95G of tiers covering the same rows — the same
  # data dumped twice, at double the dump budget, on a run already taking ~20min.
  # Authorized only after tier 1 was proven BOTH restorable (pg_restore rc=0, 590
  # tables, 95 FKs validated) AND inside a COMPLETE kopia snapshot at PATH level
  # (k4258cdeb). Neither half alone is sufficient: an enrolled-but-unsnapshotted
  # tier and a snapshotted-but-unrestorable one both read as "covered".
  if is_tiered "$db"; then
    log "$db dumped as tiers ($db-state + $db-transcript), not undifferentiated"
    continue
  fi
  # Guarded: when tiers are disabled the migration database itself lands here.
  if guarded_dump_one "$db" "$db"; then
    DUMPED+=("$db")
  elif [ "$(db_presence "$db")" = absent ]; then
    # Dropped after enumeration (WI-10006723): nothing is left to back up, so
    # this is not a backup failure. Its last good dump, if any, stays on disk.
    VANISHED_SKIPPED+=("$db")
    log "$db VANISHED — dropped after enumeration, so there is nothing left to dump; not counted as a failure (listed in STATUS.json vanishedSkipped)"
  else
    FAILED+=("$db")
  fi
done

# ── tiered dumps (WI-2146225) — AUTHORITATIVE PHASE ─────────────────────────
# MEASURED 2026-09-05 on the live 93 GiB papercusp dump, by attributing every
# -Fd data member to its table via the archive TOC: SIX append-only
# transcript/telemetry tables are 73 GiB of it (78%), and the state that
# actually has to come back to restart this system is the other 20 GiB.
#
#   session_archive_files 42G · session_turns 9.1G · tool_invocations 8.3G
#   session_turn_chunks 7.3G · session_turn_parts 5.6G · route_invocations 3.1G
#
# WHY THE SPLIT LIVES HERE AND NOT IN KOPIA. It was ratified as a kopia
# exclusion first; that is not expressible. A -Fd dump names its data members by
# pg_dump's internal dumpId, and dumpIds DRIFT between dump sets (measured:
# session_archive_files was 30053 in the live set and 30016 in a frozen one, +37
# on every row) while only the pg OID is stable. A filename exclusion would keep
# matching — silently, with no error — a DIFFERENT table on the next run. The
# producer is the only layer that can name a table by name.
#
# THE TIERS ARE NOW AUTHORITATIVE (cutover 2026-09-05, WI-2146225). This pass was
# additive-first on purpose while the undifferentiated dump still existed; it does
# not exist any more, so for a tiered database THIS is the entire backup — tier 1
# ($db-state) carries the state that has to come back to restart the system and is
# the tier enrolled in kopia; tier 2 ($db-transcript) is the local-only append-only
# archive. Together they are the whole database.
#
# TIER FAILURES NOW REDDEN THE BACKUP, and this inverted with the cutover. While an
# undifferentiated dump existed, reddening over a redundant artifact was a FALSE
# ALARM and this file warns twice that a false alarm is how a real one stops being
# believed. With that dump retired the same silence is the opposite defect: a failed
# tier means the database has NO fresh backup at all, and staying green over it is
# exactly the 30-day-unnoticed blindness EI-10733 exists to prevent. So each tier
# joins DUMPED/FAILED like any other database, AND keeps its own status field.
#
# ⚠ The consumer default travels with this: papercup-backup-health-check.sh asserts
# freshness over BACKUP_ARTIFACTS, whose default named pg/papercusp. Left stale it
# would have alarmed forever on a path nothing writes — the PERMANENT false alarm
# documented in that file's own header — while never once looking at the tiers.
PC_BACKUP_TRANSCRIPT_TABLES="${PC_BACKUP_TRANSCRIPT_TABLES:-harness_shared.session_archive_files harness_shared.session_turns harness_shared.tool_invocations harness_shared.session_turn_chunks harness_shared.session_turn_parts harness_shared.route_invocations}"
TIER_DUMPED=()
TIER_FAILED=()
TIER_NOT_DUE=()
# Tier databases whose transcript tier is due this run. Dumped LAST, after the
# shared backup lock is handed back (WI-10004870, local-only phase below).
TRANSCRIPT_DUE=()

# ── Transcript-tier cadence (WI-10004603) ────────────────────────────────────
# MEASURED 2026-10-01: the hourly run took 2822 / 2999 / 2995 / 3397 s, ~95% of
# its one-hour timer period. The target is one 7200 rpm HDD at ~72 MB/s, and the
# transcript tier alone is ~100 GB of it (the state tier ~58 GB). Once a run
# outlasts the period, the next timer start is a no-op on a running unit, so the
# backup becomes continuous and the STATE tier's recovery point slips with it.
#
# So the transcript tier is rewritten only when its existing artifact is at
# least PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC old, and the state tier stays hourly.
# 9000 s (2.5 h) is below a 3 h cadence on purpose: a run reaches the tier ~20-50
# min after its :10 start, so the artifact is ~1.3 h / 2.3 h / 3.3 h old at the
# next three checks and the third one dumps. That keeps the worst case near
# 3.75 h, under the health check's 6 h BACKUP_MAX_AGE_H with room for one
# deferred run. The age is the artifact DIRECTORY's mtime, the same instrument
# papercup-backup-health-check.sh alarms on, so the producer and the alarm can't
# disagree about how old the tier is.
#
# Not dumping a tier that is not due is NOT a failure: the previous validated
# artifact stays in place (dump_one only ever swaps a validated one in), and the
# tier is listed in tierNotDue[] so a reader can tell "not due" from "never ran".
# The tiers are separate pg_dump snapshots already (~20 min apart before this
# change); no FK crosses between them (checked 2026-10-01: 0 of 110 FKs touch a
# transcript table), so a wider skew restores the same way.
# 0 restores the old every-run behaviour.
PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC="${PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC:-9000}"
case "$PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC" in ''|*[!0-9]*) PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC=9000 ;; esac

# transcript_tier_age <artifact dir> — seconds since the artifact was written,
# or empty when there is no artifact to keep (never dumped, or removed).
transcript_tier_age() {
  local mtime
  [ -d "$1" ] || return 0
  mtime=$(stat -c %Y "$1" 2>/dev/null) || return 0
  [ -n "$mtime" ] || return 0
  echo $(( $(date +%s) - mtime ))
}

# ── Tier 2 (transcript) is NEVER enrolled in kopia — and that rule is TREE-OWNED
# The transcript tier is ~73G of high-churn session archive. The ratified ruling
# on WI-2146225 is "enroll tier 1, never tier 2": covering it would put tens of
# gigabytes of churning duplicate data into a repo whose volume capacity is the
# very wall that caused the dump relocation this work-item exists to repair.
#
# That exclusion previously lived ONLY as an operator-added line in an untracked
# .kopiaignore — the exact failure shape documented at the top of this file, and
# the one that already cost this system its dump coverage once: state kept
# outside the tree does not survive a relocation, and its absence raises no
# error anywhere. It would have failed silently and EXPENSIVELY here (a sweep
# would simply start uploading tier 2), so the producer provisions it.
#
# Derived from PC_BACKUP_TIER_DBS rather than hardcoded, so it cannot drift from
# the tier set actually being written. Tier 1 (<db>-state) is deliberately NOT
# excluded: it is the enrolled tier.
if [ "$PC_BACKUP_TIERS_ENABLED" = 1 ]; then
  for db in $PC_BACKUP_TIER_DBS; do
    ensure_kopiaignore_rule "$db-transcript" \
      "Tier 2 (transcript) is deliberately NOT backed up — ratified on WI-2146225. Tier 1 ($db-state) IS enrolled and must stay covered."
  done
fi

if [ "$PC_BACKUP_TIERS_ENABLED" = 1 ]; then
  for db in $PC_BACKUP_TIER_DBS; do
    # NO "did the undifferentiated dump succeed" GATE ANY MORE. It read
    # `case " ${DUMPED[*]} " in *" $db "*)` and skipped the tiers when the whole-db
    # dump had failed — correct while that dump was the backup and the tiers were a
    # redundant extra. After the cutover it inverts into the worst possible rule:
    # the tiered database is never in DUMPED (nothing dumps it whole), so the gate
    # would skip the ONLY backup this database has, on every single run, and report
    # a green "backup OK" while doing it. Deleted deliberately, not overlooked.

    # VERIFY EVERY CONFIGURED TABLE EXISTS FIRST — this is the recurrence guard
    # for the failure this split can have, and it is silent in BOTH directions:
    # `pg_dump --exclude-table-data=<pattern>` does NOT error when the pattern
    # matches nothing. A renamed or mistyped table therefore produces a "state"
    # tier that still carries the 42 GiB table, exits 0, validates under
    # pg_restore -l, and reports ok — while `--table=<same pattern>` produces a
    # transcript tier MISSING it. So one typo silently un-splits the state tier
    # and silently drops rows from the transcript tier at the same time, and
    # every signal downstream stays green. Size alone cannot catch it either:
    # both tiers are expected to change size run to run.
    # NOTE the connection: $PSQL is pinned to -d postgres, and to_regclass is
    # resolved per-DATABASE, so asking it there would report every table missing
    # and disable the tiers permanently. Ask the database being dumped.
    missing=""
    for t in $PC_BACKUP_TRANSCRIPT_TABLES; do
      [ "$(sudo -n -u postgres psql -h /var/run/postgresql -d "$db" -tAc \
             "SELECT to_regclass('$t') IS NOT NULL" 2>/dev/null | tr -d ' ')" = "t" ] \
        || missing="${missing:+$missing }$t"
    done
    if [ -n "$missing" ]; then
      TIER_FAILED+=("$db-state" "$db-transcript")
      FAILED+=("$db-state" "$db-transcript")
      log "$db tiers SKIPPED — configured transcript table(s) do not exist: $missing. Refusing to dump: pg_dump ignores a table pattern that matches nothing, so proceeding would silently leave those rows in the state tier AND out of the transcript tier."
      continue
    fi

    ex=(); inc=()
    for t in $PC_BACKUP_TRANSCRIPT_TABLES; do
      # --exclude-table-data keeps the DDL and drops the rows, so the state tier
      # restores to a working schema with empty transcript tables rather than to
      # a database missing them entirely.
      ex+=("--exclude-table-data=$t")
      inc+=("--table=$t")
    done

    # Each tier lands in BOTH ledgers: TIER_* so a consumer can still ask about the
    # split specifically, and DUMPED/FAILED because since the cutover these ARE the
    # database's backup and a failure has to reach ALERT-BACKUP-FAILING like any
    # other. Reporting a tier failure only in tierFailed[] would leave the run's
    # top-level "ok" true with the database wholly unbacked.
    if guarded_dump_one "$db" "$db-state" "${ex[@]}"; then
      TIER_DUMPED+=("$db-state"); DUMPED+=("$db-state")
    else
      TIER_FAILED+=("$db-state"); FAILED+=("$db-state")
    fi
    tx_age=$(transcript_tier_age "$PGOUT/$db-transcript")
    if [ -n "$tx_age" ] && [ "$tx_age" -ge 0 ] \
       && [ "$tx_age" -lt "$PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC" ]; then
      TIER_NOT_DUE+=("$db-transcript")
      log "$db-transcript not due: existing dump is ${tx_age}s old (< ${PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC}s, WI-10004603); kept as-is"
    else
      # Dumped in the local-only phase at the END of the run, after the shared
      # backup lock is handed back (WI-10004870) — see TRANSCRIPT_DUE below.
      TRANSCRIPT_DUE+=("$db")
    fi
  done
fi

# Backstop before oddsmith (another server) and the final bookkeeping: the
# rendezvous is held only inside guarded_dump_one, so it is never held here and
# this release is an idempotent no-op — unconditional on purpose, so no future
# edit can carry a held rendezvous across oddsmith again (WI-10008166). The EXIT
# trap still covers every abort.
release_migration_rendezvous
reap_own_stragglers   # nothing of ours may outlive this script holding locks

# ── oddsmith embedded Postgres (TCP 5544) — WI-39502 ────────────────────────
# The enumeration above CANNOT see this database, by construction: it asks the
# SYSTEM cluster over the unix socket, and oddsmith runs its own EMBEDDED
# postgres on TCP 5544 with a private data dir (ODDSMITH_PG_DATA_DIR =
# ~/.oddsmith/embedded-pg-data). Widening EXCLUDE_RE would not help — the DB is
# not in that cluster's pg_database at all. It therefore needs its own leg.
#
# WHY THIS EXISTS: on 2026-08-15 18:54 ~/.oddsmith was destroyed. papercusp was
# restored from kopia and came back fine; oddsmith could not be, because it was
# in NEITHER backup path — not dumped here (wrong cluster) and not a kopia
# source (~/.oddsmith is not in the policy). Two independent blind spots meeting
# on one database. Every row of simulation and evidence history was lost
# permanently. Dumping into $PGOUT puts it inside /mnt/data/Backup/db-dumps,
# which kopia ALREADY snapshots — so this needs no new kopia policy, and a live
# PG data dir never has to be snapshotted file-by-file (which is unsafe anyway).
#
# DELIBERATELY NOT FOLDED INTO OK/FAILED: the oddsmith sidecar is a restartable
# service that can legitimately be down, and letting a down sidecar redden the
# whole cluster's backup health would raise ALERT-BACKUP-FAILING on a perfectly
# good papercusp dump — the false-alarm trap this file already warns about
# twice. It gets its OWN status fields and its OWN staleness assertion in
# healthcheck.sh, so it is independently loud without being coupled.
#
# Runs as the backup service user over TCP (scram), NOT `sudo -u postgres`: peer auth is a
# SYSTEM-cluster concept and this server has its own roles. So the chown dance
# above is unnecessary here — this script already owns what it writes.
ODDSMITH_DISCOVERY="${ODDSMITH_DISCOVERY:-$BACKUP_HOME/.oddsmith/embedded-pg.json}"
ODDS_OK=false
ODDS_NOTE="not attempted"
odds_out="$PGOUT/oddsmith"

odds_url=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ODDSMITH_DISCOVERY" 2>/dev/null | head -1)
if [ -z "${odds_url:-}" ]; then
  # No discovery file = the sidecar has never booted on this box, or ~/.oddsmith
  # was wiped again. Either way there is nothing to dump and that is worth saying
  # out loud rather than silently recording a clean run.
  ODDS_NOTE="no discovery file at $ODDSMITH_DISCOVERY (sidecar never booted, or ~/.oddsmith was wiped)"
  log "oddsmith SKIP — $ODDS_NOTE"
else
  # Parse the URI into parts so the PASSWORD never reaches the process table (a
  # conninfo URI passed as an argv would show in `ps` for the whole dump).
  odds_rest=${odds_url#*://}
  odds_user=${odds_rest%%:*}
  odds_pass=${odds_rest#*:}; odds_pass=${odds_pass%%@*}
  odds_hostport=${odds_rest#*@}; odds_hostport=${odds_hostport%%/*}
  odds_host=${odds_hostport%%:*}
  odds_port=${odds_hostport##*:}
  odds_db=${odds_url##*/}

  # Tolerate a restart in flight rather than calling a 5-second blip a backup
  # failure: the sidecar has Restart=always and does bounce.
  odds_ready=false
  for _try in 1 2 3; do
    if pg_isready -h "$odds_host" -p "$odds_port" -U "$odds_user" -d "$odds_db" -t 5 >/dev/null 2>&1; then
      odds_ready=true; break
    fi
    [ "$_try" -lt 3 ] && sleep 5
  done

  if ! $odds_ready; then
    ODDS_NOTE="embedded PG unreachable at $odds_host:$odds_port after 3 probes (sidecar down?)"
    log "oddsmith SKIP — $ODDS_NOTE"
  else
    rm_tmp "$odds_out.tmp"
    odds_err=$(mktemp -t "pcbackup-oddsmith-XXXXXX.err")
    # PGPASSWORD is exported INSIDE a subshell so it is neither in argv nor in
    # this script's environment for anything else that runs after.
    (
      export PGPASSWORD="$odds_pass" PGAPPNAME="$HOST_BACKUP_APPLICATION_NAME"
      run_bounded "$TIMEOUT_SEC" pg_dump -h "$odds_host" -p "$odds_port" -U "$odds_user" \
        -Fd -j "$JOBS" --compress=none -f "$odds_out.tmp" "$odds_db"
    ) 2>"$odds_err"
    orc=$?
    if [ "$orc" -eq 0 ]; then
      # Same rule as the loop above: VALIDATE THE ARTIFACT, never the exit code.
      if pg_restore -l "$odds_out.tmp" >/dev/null 2>&1; then
        chmod -R u=rwX,g=rX,o= "$odds_out.tmp" 2>/dev/null || true
        rm -rf "$odds_out"
        mv -f "$odds_out.tmp" "$odds_out"
        osz=$(du -sb "$odds_out" 2>/dev/null | cut -f1)
        ODDS_OK=true
        ODDS_NOTE="ok"
        log "oddsmith ok ($(numfmt --to=iec "${osz:-0}" 2>/dev/null || echo "${osz:-0}"), $(pg_restore -l "$odds_out" 2>/dev/null | grep -c '^[0-9]') objects)"
      else
        rm_tmp "$odds_out.tmp"
        ODDS_NOTE="dump completed but is NOT a valid archive (pg_restore -l could not read it)"
        log "oddsmith FAIL — $ODDS_NOTE; previous dump left intact"
      fi
    else
      rm_tmp "$odds_out.tmp"
      # Say WHY, same as the system loop — and scrub anything password-shaped out
      # of the text before it reaches a log file or STATUS.json.
      odetail=$(tr '\n' ' ' <"$odds_err" 2>/dev/null | sed "s|${odds_pass}|***|g" | tail -c 300)
      if [ "$orc" -eq 124 ] || [ "$orc" -eq 137 ]; then
        ODDS_NOTE="TIMEOUT after ${TIMEOUT_SEC}s (exit $orc)${odetail:+ — $odetail}"
      else
        ODDS_NOTE="pg_dump exit $orc${odetail:+ — $odetail}"
      fi
      log "oddsmith FAIL — $ODDS_NOTE; previous dump left intact"
    fi
    rm -f "$odds_err"
    unset odds_pass
  fi
fi

# ── Local-only phase: transcript tiers, OUTSIDE the shared backup lock ───────
# WI-10004870. Every artifact Kopia snapshots is written by now (the state
# tiers, every undifferentiated database, oddsmith), so what is left is the
# transcript tier, which .kopiaignore keeps out of every snapshot (WI-2146225).
# Holding the host-wide Kopia lock for it bought nothing: MEASURED 2026-10-01 it
# was ~25 min of a 101G dump every ~2.5 h, during which the off-host hot sweep
# could not start. So the guard is asked to hand the lock back first.
#
# What the lock protected does not apply to this phase:
#   * snapshot consistency — neither papercusp-transcript nor its
#     papercusp-transcript.tmp work dir (*.tmp) is ever snapshotted;
#   * I/O contention — the sweep's long phase reads the workspace (NVMe) and
#     writes the repo on /mnt/data, while this dump writes /mnt/backup (HDD).
#     They overlap on that disk only during the sweep's ~12 min db-dumps read.
# What still serializes it is kept: this script's own single-instance lock
# (pg_dump vs pg_dump) and the migration rendezvous — re-acquired by
# guarded_dump_one for exactly this dump so no migration takes these tables
# mid-dump, and NOT held across oddsmith above (WI-10008166).
if [ ${#TRANSCRIPT_DUE[@]} -gt 0 ]; then
  release_shared_backup_lock "${TRANSCRIPT_DUE[*]}"
  inc=()
  for t in $PC_BACKUP_TRANSCRIPT_TABLES; do inc+=("--table=$t"); done
  for db in "${TRANSCRIPT_DUE[@]}"; do
    if guarded_dump_one "$db" "$db-transcript" "${inc[@]}"; then
      TIER_DUMPED+=("$db-transcript"); DUMPED+=("$db-transcript")
    else
      TIER_FAILED+=("$db-transcript"); FAILED+=("$db-transcript")
    fi
  done
  release_migration_rendezvous
  reap_own_stragglers   # nothing of ours may outlive this script holding locks
fi

ELAPSED=$(( $(date +%s) - START ))
OK=true; [ ${#FAILED[@]} -eq 0 ] || OK=false

# WI-10004603: a run that takes most of its timer period is one growth step from
# becoming continuous (the next hourly start is a no-op on a running unit). Warn
# at 75% here; kopia-healthcheck.sh pages on elapsedSec at its own threshold.
PC_BACKUP_PERIOD_SEC="${PC_BACKUP_PERIOD_SEC:-3600}"
case "$PC_BACKUP_PERIOD_SEC" in ''|*[!0-9]*|0) PC_BACKUP_PERIOD_SEC=3600 ;; esac
DUTY_WARN=false
if [ $(( ELAPSED * 4 )) -ge $(( PC_BACKUP_PERIOD_SEC * 3 )) ]; then
  DUTY_WARN=true
  log "WARNING: this run took ${ELAPSED}s, >= 75% of the ${PC_BACKUP_PERIOD_SEC}s timer period (WI-10004603). Not-due tiers: ${TIER_NOT_DUE[*]:-none}."
fi

# Carry the previous oddsmith success forward when this run did not produce one.
# Read it BEFORE the STATUS rewrite, and default explicitly: `$(sed ... || echo 0)`
# yields EMPTY when sed matches nothing (sed still exits 0), which would emit
# `"oddsmithLastSuccessEpoch": ,` — invalid JSON that a consumer reads as absence.
ODDS_PREV=$(sed -n 's/.*"oddsmithLastSuccessEpoch": *\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1)
[ -n "${ODDS_PREV:-}" ] || ODDS_PREV=0
$ODDS_OK && ODDS_LAST=$(date +%s) || ODDS_LAST="$ODDS_PREV"

# ── STATUS.json — the file healthcheck.sh actually asserts on ───────────────
# `printf '"%s",' "${ARR[@]}"` runs its format ONCE even with zero arguments, so
# an empty array serialised as [""] — a one-element array holding an empty
# string. Any consumer testing `.failed | length == 0` therefore read a clean
# run as a failure (observed 2026-07-26 on a fully green run). Emit nothing for
# an empty array instead.
json_arr() {
  [ "$#" -eq 0 ] && return 0
  printf '"%s",' "$@" | sed 's/,$//'
}

# Cluster identity of what we just dumped, so a consumer can prove a database it
# is looking at is THE SAME SERVER rather than a same-named database elsewhere.
# The per-workspace hook uses this to stand down (host-dump-coverage.ts); it
# connects over TCP while we use the unix socket, so host:port can never match
# textually and a name-only comparison would wrongly suppress a workspace's
# EMBEDDED Postgres dump. `tr -dc` guarantees the field is digits-or-empty, and
# empty reads as "no identity" ⇒ the hook keeps dumping.
SYSID=$($PSQL "SELECT system_identifier FROM pg_control_system()" 2>/dev/null | tr -dc '0-9' || true)
{
  printf '{\n'
  printf '  "ok": %s,\n' "$OK"
  printf '  "lastRunEpoch": %s,\n' "$(date +%s)"
  printf '  "lastRunIso": "%s",\n' "$(date -Iseconds)"
  $OK && printf '  "lastSuccessEpoch": %s,\n' "$(date +%s)" \
       || printf '  "lastSuccessEpoch": %s,\n' "$(sed -n 's/.*"lastSuccessEpoch": \([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1 || echo 0)"
  printf '  "elapsedSec": %s,\n' "$ELAPSED"
  printf '  "dumped": [%s],\n' "$(json_arr ${DUMPED[@]+"${DUMPED[@]}"})"
  printf '  "failed": [%s],\n' "$(json_arr ${FAILED[@]+"${FAILED[@]}"})"
  # WI-10003455: invalid (datconnlimit=-2) databases skipped — undumpable by
  # definition, so NOT a failure, but listed so an interrupted-DROP leak stays visible.
  printf '  "invalidSkipped": [%s],\n' "$(json_arr ${INVALID_SKIPPED[@]+"${INVALID_SKIPPED[@]}"})"
  # WI-10006723: databases dropped between enumeration and their dump. Nothing
  # was left to back up, so NOT a failure; listed so the skip is never silent.
  printf '  "vanishedSkipped": [%s],\n' "$(json_arr ${VANISHED_SKIPPED[@]+"${VANISHED_SKIPPED[@]}"})"
  printf '  "systemIdentifier": "%s",\n' "$SYSID"
  # WI-2146225 tiered dumps. These fields are now a NAMED VIEW of the split, not a
  # quarantine: since the 2026-09-05 cutover each tier ALSO appears in dumped[] /
  # failed[] and therefore does move "ok". That is the opposite of the additive
  # phase, when a tier was a redundant copy beside a green authoritative dump and
  # folding its failure into "ok" would have alarmed on a healthy backup. The tier
  # pair IS the backup now, so a consumer asserting only on dumped[]/failed[] gets
  # the right answer, and one that wants the split specifically still has these.
  printf '  "tiersEnabled": %s,\n' "$([ "$PC_BACKUP_TIERS_ENABLED" = 1 ] && echo true || echo false)"
  printf '  "tierDumped": [%s],\n' "$(json_arr ${TIER_DUMPED[@]+"${TIER_DUMPED[@]}"})"
  printf '  "tierFailed": [%s],\n' "$(json_arr ${TIER_FAILED[@]+"${TIER_FAILED[@]}"})"
  # WI-10004603: a tier whose previous artifact is younger than its cadence is
  # kept, not rewritten. Listed so "not due" is distinguishable from "not run".
  printf '  "tierNotDue": [%s],\n' "$(json_arr ${TIER_NOT_DUE[@]+"${TIER_NOT_DUE[@]}"})"
  printf '  "transcriptMinAgeSec": %s,\n' "$PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC"
  # Duty cycle against the hourly timer: kopia-healthcheck.sh alarms on
  # elapsedSec, and this flag says so to anyone reading the file by hand.
  printf '  "periodSec": %s,\n' "$PC_BACKUP_PERIOD_SEC"
  printf '  "dutyCycleWarn": %s,\n' "$DUTY_WARN"
  # WI-39502: the oddsmith embedded PG (5544) reports SEPARATELY from the system
  # cluster above — see the leg's comment for why coupling them would be a bug.
  # healthcheck.sh asserts oddsmithLastSuccessEpoch on its own threshold.
  printf '  "oddsmithOk": %s,\n' "$ODDS_OK"
  printf '  "oddsmithLastSuccessEpoch": %s,\n' "$ODDS_LAST"
  printf '  "oddsmithNote": "%s"\n' "$(printf '%s' "$ODDS_NOTE" | tr -d '\n' | sed 's/[\\"]/ /g' | tail -c 300)"
  printf '}\n'
} > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"

if $OK; then
  # Clear the failure marker on recovery. backup-alert.sh RAISES
  # "$DUMP/ALERT-BACKUP-FAILING" via OnFailure=, but nothing ever removed it
  # again — so one bad run left a permanent "BACKUP FAILING" file on disk
  # flatly contradicting a green STATUS.json (observed 2026-07-26: the marker
  # survived a clean 120s run in which all four databases dumped). A false
  # alarm is a bug in the alarm: a marker that never clears trains readers to
  # ignore the single signal meant to catch silent backup rot.
  rm -f "$DUMP/ALERT-BACKUP-FAILING"
  if [ -n "$BACKUP_REPO_ROOT" ] && [ -f "$BACKUP_REPO_ROOT/scripts/mcp-call.mjs" ]; then
    RECOVERY_BODY='{"to":["*"],"expects":"none","summary":"BACKUP RECOVERED: papercusp-db-backup succeeded","body":[{"text":"STATUS.json is green and ALERT-BACKUP-FAILING was cleared."}],"resolvesCondition":"papercusp-db-backup-failing"}'
    if ! (cd "$BACKUP_REPO_ROOT" && timeout 30 node scripts/mcp-call.mjs coord:send "$RECOVERY_BODY" \
        --client system-backup-alert --harness papercusp --workspace papercusp-workspace >/dev/null); then
      echo "BACKUP RECOVERY: coord:send leg FAILED — recovery condition remains open" >&2
    fi
  else
    echo "BACKUP RECOVERY: coord:send unavailable — recovery condition remains open" >&2
  fi
  log "backup OK in ${ELAPSED}s: ${DUMPED[*]}${VANISHED_SKIPPED[*]:+ (vanished after enumeration: ${VANISHED_SKIPPED[*]})}"
  exit 0
fi
log "backup FAILED in ${ELAPSED}s: ${FAILED[*]}"
exit 1
