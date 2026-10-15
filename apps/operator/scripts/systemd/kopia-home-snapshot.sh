#!/usr/bin/env bash
# Daily snapshot of the CURATED full home directory.
#
# Plan: kopia-curated-home-coverage-2026-08-16
#
# WHY THIS IS A SEPARATE SCRIPT AND TIMER, NOT ANOTHER SOURCE IN snapshot-all.sh:
# snapshot-all.sh runs every 30 MINUTES and discovers its sources dynamically, so a
# $HOME source would be swept every 30 minutes automatically. That walks
# the entire home tree and would undo the 2026-08-07 thermal fix that cut that timer
# from 5 min to 15 (this box idles at 90-92 C against a ~94 C limit). snapshot-all.sh
# filters this path out via its COLD_SOURCES array; this unit owns it instead, daily.
#
# The 12 existing in-home sources keep their 30-minute cadence and are NOT excluded
# from this snapshot — kopia dedups by content hash, so re-including them costs ~0
# bytes. The payoff is that ONE snapshot restores the whole home directory.

set -uo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=kopia-cache-bootstrap.sh
source "$script_dir/kopia-cache-bootstrap.sh"
HOME_SRC="$HOME"
# windows-vm REMOVED [owner 2026-09-16]: 23 daily snapshots of a
# LIVE 247GB image (98.7->247GB in one month) bought a crash-consistent copy that may
# not boot on restore. ~/.kopiaignore already excludes it from the curated HOME source,
# so this dedicated source was the only thing holding those blobs. Its
# PROTECTED_VM_REQUESTS assertion in kopia-healthcheck.sh was dropped in the same
# change, or the healthcheck would alarm forever on a source we deliberately retired.
VM_REQUESTED=( "$HOME_SRC/macos-vm" )
LOG_DIR="${KOPIA_HOME_SNAPSHOT_LOG_DIR:-$HOME/.cache/kopia}"
PID_FILE="$LOG_DIR/home-snapshot.kopia.pid"
PROC_ROOT="${KOPIA_HOME_SNAPSHOT_PROC_ROOT:-/proc}"
SUDO_BIN="${KOPIA_HOME_SNAPSHOT_SUDO:-/usr/bin/sudo}"
KILL_BIN="${KOPIA_HOME_SNAPSHOT_KILL:-/usr/bin/kill}"
KOPIA_BIN="${KOPIA_HOME_SNAPSHOT_BIN:-/usr/bin/kopia}"
if ! ensure_kopia_cache_dir "$LOG_DIR"; then
  echo "FATAL: unable to bootstrap Kopia home-snapshot log directory: $LOG_DIR" >&2
  exit 1
fi
LOG="$LOG_DIR/home-snapshot.log"
# A successful `kopia snapshot create` also means "no files changed".  Persist
# that verification separately from the snapshot timestamp so the healthcheck
# can distinguish a healthy unchanged source from a dead timer.  The marker is
# source-bound and written atomically only after the protected VM leg succeeds.
VM_VERIFY_MARKER="${KOPIA_VM_VERIFY_MARKER:-$LOG_DIR/macos-vm-verified}"

write_vm_verification_marker() {
  local source="$1" tmp="${VM_VERIFY_MARKER}.$$"
  if ! {
    printf 'verified_at=%s\n' "$(date +%s)"
    printf 'source=%s\n' "$source"
  } >"$tmp" || ! mv -f -- "$tmp" "$VM_VERIFY_MARKER"; then
    rm -f -- "$tmp"
    echo "WARN: unable to persist protected VM verification marker: $VM_VERIFY_MARKER" >&2
    return 1
  fi
}

# systemd's user manager cannot reliably kill a root-owned sudo child when it
# tears down this user unit (the historical OOM left PID 2701540 behind). Keep
# the PID file deliberately narrow: it names the one Kopia process started by
# this invocation, and cleanup validates both /proc/<pid>/exe and argv before
# using sudo to kill that exact PID. Never use pkill/killall here.
kopia_pid_matches() {
  # Shared exe+argv validator (kopia-cache-bootstrap.sh). The Kopia child runs as
  # ROOT, so its exe link is unreadable here and is resolved with a bounded sudo
  # (WI-10002636), but only after the world-readable cmdline already matched, so a
  # non-Kopia cgroup member costs no sudo (WI-6554700010011924).
  kopia_exact_snapshot_pid "$1"
}

# Every root Kopia this unit starts stays in the unit's cgroup until it exits. The
# user manager cannot signal it ("Failed to kill control group"), and a restart only
# logs "Found left-over process ... Ignoring". The PID file names just the LAST
# run's child, so a leftover from an earlier failed attempt was never reaped. On
# 2026-10-14 three concurrent home walks (19h, 17h and 52m old) were writing to the
# repository (WI-6554700010011790). cgroup membership is exact (a recycled PID lands
# in another cgroup), and every candidate is still validated by exe and argv, so this
# never touches an unrelated process.
CGROUP_ROOT="${KOPIA_HOME_SNAPSHOT_CGROUP_ROOT:-/sys/fs/cgroup}"
SELF_CGROUP_FILE="${KOPIA_HOME_SNAPSHOT_SELF_CGROUP:-/proc/self/cgroup}"
UNIT_CGROUP_LEAF="kopia-home-snapshot.service"

# Lists this unit's cgroup members UNVALIDATED; the caller skips PIDs it already
# validated before calling kopia_pid_matches, so no PID costs a second sudo.
unit_cgroup_pids() {
  local line="" path="" procs="" pid=""
  line="$(grep -m1 '^0::' "$SELF_CGROUP_FILE" 2>/dev/null || true)"
  path="${line#0::}"
  # Only inside this unit's own cgroup: a manual --cleanup run from a terminal or
  # another unit must never reap that scope's processes.
  [ "${path##*/}" = "$UNIT_CGROUP_LEAF" ] || return 0
  procs="$CGROUP_ROOT$path/cgroup.procs"
  [ -r "$procs" ] || return 0
  while read -r pid; do
    [ -n "$pid" ] && [ "$pid" != "$$" ] || continue
    printf '%s\n' "$pid"
  done <"$procs"
}

stop_kopia_pid_logged() {
  local pid="$1" rc=0
  # SIGTERM first so Kopia flushes a partial snapshot of the home walk, which the
  # next run resumes from; SIGKILL discarded it (kopia_stop_flushing,
  # EI-25211496463956189).
  kopia_stop_flushing "$pid" "${KOPIA_HOME_SNAPSHOT_FLUSH_GRACE_SEC:-15}"
  rc=$?
  case "$rc" in
    0) echo "CLEANUP: Kopia PID $pid exited after SIGTERM; its progress was flushed" >>"$LOG" ;;
    2) echo "CLEANUP: killed exact Kopia PID $pid after SIGTERM grace" >>"$LOG" ;;
    *) echo "WARN: failed to kill exact Kopia PID $pid" >>"$LOG" ;;
  esac
}

cleanup_kopia_pid() {
  local recorded="" pid="" seen=" "
  local -a targets=() waits=()
  if [ -s "$PID_FILE" ]; then
    recorded="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
    if kopia_pid_matches "$recorded"; then
      targets+=("$recorded")
      seen+="$recorded "
    else
      echo "INFO: stale/non-Kopia PID file $PID_FILE; refusing to kill PID ${recorded:-<empty>}" >>"$LOG"
    fi
  fi
  while read -r pid; do
    [ -n "$pid" ] || continue
    case "$seen" in *" $pid "*) continue ;; esac
    seen+="$pid "
    kopia_pid_matches "$pid" || continue
    echo "CLEANUP: leftover Kopia PID $pid found in this unit's cgroup" >>"$LOG"
    targets+=("$pid")
  done < <(unit_cgroup_pids)
  # Stop them in parallel, so any number of leftovers shares ONE flush grace inside
  # the unit's TimeoutStopSec instead of N graces in sequence.
  for pid in "${targets[@]}"; do
    stop_kopia_pid_logged "$pid" &
    waits+=("$!")
  done
  for pid in "${waits[@]}"; do wait "$pid" || true; done
  rm -f -- "$PID_FILE"
}

# ExecStartPre and ExecStopPost call this same script: after systemd-oomd or a
# stop kills the main shell, and again before each (re)start so a new walk never
# runs beside a leftover one. It is also the safe, non-snapshot test seam for the
# exact-PID guard. With no PID file and no leftover in the cgroup it is a no-op.
if [ "${1:-}" = "--cleanup" ]; then
  cleanup_kopia_pid
  exit 0
fi

# D-001: daily home/VM work waits for the SAME lock as the hot and protected
# entrypoints. The service enters it first; this self-wrap protects direct runs.
# Cleanup stays above this block so ExecStopPost can never wait on backup work.
if [ "${KOPIA_BACKUP_GUARD_ACTIVE:-0}" != 1 ]; then
  guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
  # The daily full-home walk is restart-safe but may run for hours. Keep it in
  # scheduled mode so an overdue DB dump can preempt it; wait mode is reserved
  # for protected/manual snapshots that must finish before their caller proceeds.
  exec "$guard" --mode scheduled --label daily-home-vm --priority-on-contention -- "$0" "$@"
fi

run_kopia_snapshot() {
  local output_file="$LOG_DIR/home-snapshot-output.$$" sudo_pid="" rc=0
  kopia_retention_pin_all "$SUDO_BIN" "$KOPIA_BIN" add || return
  rm -f -- "$PID_FILE" "$output_file"

  # The root helper records its own PID before exec'ing Kopia. `$!` would be
  # sudo's unprivileged parent, not the root Kopia process that can be orphaned.
  kopia_as_root "$SUDO_BIN" /usr/bin/bash -c '
    pid_file="$1"
    shift
    printf "%s\n" "$$" >"$pid_file"
    exec "$@"
  ' bash "$PID_FILE" "$KOPIA_BIN" snapshot create "--pin=$KOPIA_RETENTION_PIN" "--parallel=1" "$@" >"$output_file" 2>&1 &
  sudo_pid=$!
  wait "$sudo_pid"
  rc=$?
  [ "$rc" -ne 0 ] || kopia_retention_finish "$SUDO_BIN" "$KOPIA_BIN" || rc=$?
  cat "$output_file"
  rm -f -- "$output_file" "$PID_FILE"
  return "$rc"
}

# Background priority. Children inherit both. This walk is long and must never
# compete with agent sessions, git-sync, or the 30-minute hot sweep.
renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

rc=0
{
  echo "=== $(date -Iseconds) home snapshot start ==="

  # ── GUARD: never snapshot home without its exclusion file ──────────────────
  # Without .kopiaignore this source walks ~1 TB — VM images (314 GB), Rust build
  # targets (77 GB), Android SDK (44 GB) — against 650 GB of free space on a disk
  # already 92% full. Failing loudly here beats filling the disk overnight and
  # discovering it from a wedged machine. This is the recurrence guard for the
  # whole "someone removed/renamed the ignore file" class.
  if [ ! -f "$HOME_SRC/.kopiaignore" ]; then
    echo "FATAL: $HOME_SRC/.kopiaignore is MISSING — refusing to snapshot."
    echo "       Restore it before this unit can run; see plan"
    echo "       kopia-curated-home-coverage-2026-08-16 (P-001) for its contents."
    echo "=== $(date -Iseconds) home snapshot ABORTED (no ignore file) ==="
    exit 78   # EX_CONFIG — distinguishes misconfiguration from a kopia failure
  fi

  VM_SRCS=()
  vm_missing=0
  for requested in "${VM_REQUESTED[@]}"; do
    if [ ! -d "$requested" ]; then
      echo "FATAL: owner-protected VM path is MISSING: $requested"
      vm_missing=1
    else
      VM_SRCS+=( "$(readlink -f "$requested")" )
    fi
  done

  if [ "$vm_missing" -ne 0 ]; then
    echo "FATAL: refusing the daily snapshot while an owner-protected VM path is missing"
    rc=78   # EX_CONFIG — the existence assertion must fail loudly
  else
    home_out=$(run_kopia_snapshot "$HOME_SRC")
    home_rc=$?
    printf '%s\n' "$home_out" | tail -6

    # The VM paths are explicit sources because .kopiaignore intentionally
    # excludes them from the curated HOME source. Keep them daily, not hot.
    vm_out=$(run_kopia_snapshot "${VM_SRCS[@]}")
    vm_rc=$?
    printf '%s\n' "$vm_out" | tail -6

    rc=0
    [ "$home_rc" -eq 0 ] || rc="$home_rc"
    [ "$vm_rc" -eq 0 ] || rc="$vm_rc"

    if [ "$vm_rc" -eq 0 ]; then
      # Kopia exits 0 both when it writes a new snapshot and when it reports
      # "no files have been changed".  Both are successful verifications, but
      # only this marker makes the latter observable to the healthcheck.
      if ! write_vm_verification_marker "${VM_SRCS[0]}"; then
        rc=1
      fi
    fi

    # Loud on failure. This system's recurring bug is the silent success-looking
    # failure (EI-10733: a healthcheck that exit-1'd every run for weeks unnoticed),
    # so say plainly which way it went rather than leaving it to be inferred.
    if [ "$rc" -ne 0 ]; then
      echo "ERROR: kopia snapshot create failed (home_rc=$home_rc vm_rc=$vm_rc) — protected sources are NOT fully backed up this cycle"
    else
      echo "OK: curated home and owner-protected VM snapshots created"
    fi
  fi

  echo "=== $(date -Iseconds) home snapshot end (rc=$rc) ==="
} >> "$LOG" 2>&1

exit "$rc"
