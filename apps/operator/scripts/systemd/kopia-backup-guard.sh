#!/usr/bin/env bash
# Serialize every managed Kopia snapshot and keep scheduled work off an already
# pressured host. See serialize-and-slow-kopia-backups-2026-08-20#D-001.
set -uo pipefail

# Parse the complete runtime before starting work. These scripts are installed as
# symlinks to this canonical file, so a repository update can replace the source
# while a multi-hour child is running. Top-level code would resume parsing the
# changed file after that child exits and can observe a torn old/new program. A
# function body is parsed as one compound command before main starts; keep the
# invocation and exit in one parsed list for the same reason.
main() {
usage() {
  echo "usage: $0 --mode scheduled|wait [--label NAME] [--no-restart-safe] [--priority-on-contention] [--deadline-at-arrival] -- COMMAND [ARG ...]" >&2
  exit 64
}

mode=
label=kopia
# The priority-waiter handoff below TERMINATES a running scheduled child. That is
# only sound when the child is restart-safe: a content-addressed Kopia snapshot
# resumes cheaply, so preempting it costs almost nothing and unblocks a
# higher-priority producer. Default 1 keeps that behaviour byte-identical.
#
# --no-restart-safe marks a child for which the assumption is FALSE. The db-dump
# is the measured case (WI-10001467): `pg_dump -Fd` has no resume, and its only
# success record -- the `backup OK in Ns` log line and the STATUS.json write --
# lands at the very END. Preempting it discards the entire cycle and records
# nothing, so the failure is invisible to every artifact-based health check (a
# killed run still writes its dump directories, so mtime reads FRESH on exactly
# the runs that were killed). Measured 2026-09-16: the 00:00 cycle dumped
# papercusp-state (19G) and papercusp-transcript (83G), then was killed at
# 00:21:19 before recording success; hourly cadence had collapsed to 4-17h gaps.
restart_safe=1
# --priority-on-contention turns a transient obstacle at the tick into a bounded
# WAIT instead of a deferral, for a scheduled producer whose cadence equals its
# recovery-point deadline. For such a producer ANY deferral at the tick right
# after a success discards the whole hour: a successful run leaves that tick
# ~2000-2500s after the previous success, below max_defer=3600, so the floor does
# not arm; the tick after is past max_defer, arms the override and runs. The
# cadence therefore halves no matter WHICH obstacle deferred the tick. Both
# obstacles are measured (WI-10003884):
#
#   LOCK CONTENTION -- 2026-09-29: 'backup OK' only at even hours for 16h, every
#   odd-hour tick logging result=deferred reason=lock-held staleness_sec=2327..2527,
#   and the 1h dump-source freshness alarm firing between runs. The lock wait
#   registers a priority request, so a restart-safe hot sweep yields the lock.
#   A --no-restart-safe or wait-mode holder is intentionally waited out; reserve
#   wait mode for protected/manual snapshots that must finish before the caller
#   proceeds. The restart-safe daily full-home walk can exceed the hourly dump
#   cadence, so it uses scheduled mode and can yield to an overdue DB dump.
#
#   ADMISSION PRESSURE -- the first tick after the lock wait went live (13:00 EDT
#   2026-09-29) waited out the lock for 5s, then logged result=deferred
#   reason=io-pressure full_avg10=15.40 limit=10 staleness_sec=2003: the same
#   hour, lost to the other obstacle. See wait_out_admission_pressure.
#
# Default 0 keeps every other scheduled label byte-identical.
priority_on_contention=0
# --deadline-at-arrival gives a wait-mode producer a deadline: the moment it starts
# waiting. A wait-mode marker without one counts as due at once and stops even an
# overdue sweep that is still making progress (has_live_priority_waiter). With it,
# the earliest-deadline-first hold and the I/O-progress check apply exactly as they
# do to a scheduled waiter's .due, so the overdue sweep finishes first unless it
# stalls (EI-25211496463956189). The per-workspace DB hook passes it for ROUTINE
# interval dumps only; its pre_destructive / pre-deploy safety dumps omit it and stay
# due-now (WI-10004871, below). Measured
# 2026-10-06 09:57 EDT: a hook dump stopped the overdue hot sweep (no snapshot since
# 00:09 EDT) 3s after it began waiting, then was itself killed at its own 900s
# budget, so the sweep was lost for a dump that never completed. Default 0 keeps
# wait-mode labels such as protected-manual byte-identical.
deadline_at_arrival=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || usage
      mode="$2"
      shift 2
      ;;
    --label)
      [ "$#" -ge 2 ] || usage
      label="$2"
      shift 2
      ;;
    --no-restart-safe)
      restart_safe=0
      shift
      ;;
    --priority-on-contention)
      priority_on_contention=1
      shift
      ;;
    --deadline-at-arrival)
      deadline_at_arrival=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *) usage ;;
  esac
done

[ "$#" -gt 0 ] || usage
case "$mode" in scheduled|wait) ;; *) usage ;; esac
# A scheduled waiter's deadline comes from its own baseline; the flag is wait-only.
[ "$deadline_at_arrival" = 0 ] || [ "$mode" = wait ] || usage

is_number() {
  awk -v value="$1" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/) }'
}

memory_limit="${KOPIA_BACKUP_MEM_FULL_AVG10_MAX:-5}"
io_limit="${KOPIA_BACKUP_IO_FULL_AVG10_MAX:-10}"
monitor_interval="${KOPIA_BACKUP_MONITOR_INTERVAL_SEC:-5}"
stop_grace="${KOPIA_BACKUP_STOP_GRACE_SEC:-20}"
is_number "$memory_limit" || { echo "invalid KOPIA_BACKUP_MEM_FULL_AVG10_MAX=$memory_limit" >&2; exit 64; }
is_number "$io_limit" || { echo "invalid KOPIA_BACKUP_IO_FULL_AVG10_MAX=$io_limit" >&2; exit 64; }
is_number "$monitor_interval" || { echo "invalid KOPIA_BACKUP_MONITOR_INTERVAL_SEC=$monitor_interval" >&2; exit 64; }
is_number "$stop_grace" || { echo "invalid KOPIA_BACKUP_STOP_GRACE_SEC=$stop_grace" >&2; exit 64; }

# A pressure gate with no floor does not delay a backup, it CANCELS it, and says
# nothing while doing so.  On a host whose memory PSI sits permanently above the
# budget, every scheduled cycle defers, the next cycle defers for the same
# reason, and coverage stops with the service still reporting healthy.  Measured
# on this box 2026-09-05: /proc/pressure/memory full avg10=23.84 against the
# default limit of 5 -- 4.8x over, sustained -- no Kopia snapshot for 6h43m, and
# the newest recoverable dump 19h old (WI-2146225 defect B).
#
# Raising the limit is NOT the repair: a larger constant has the same unbounded
# shape and fails the same way on the next busy day.  The invariant that was
# missing is that pressure may DELAY a cycle but may not CANCEL it.  Past
# max_defer seconds since the last recorded success, the cycle is admitted
# regardless of pressure -- bounded, because the unit that runs this pins
# MemoryMax/MemorySwapMax and Kopia to --parallel=1, so an admitted run is
# capped by its cgroup rather than free to consume the host.
# Keep the override ahead of the primary six-hour freshness alarm. Pressure may
# defer a cycle, but it must not defer every cycle until the alarm fires.
max_defer="${KOPIA_BACKUP_MAX_DEFER_SEC:-3600}"
# A scheduled cycle that did not run is retryable, not successful. EX_TEMPFAIL
# makes the skipped work visible in systemd's recorded exit status while the
# scheduled units' SuccessExitStatus=75 keeps expected retries out of OnFailure;
# a completed child still returns its own status below.
scheduled_defer_exit=75
# A scheduled child may itself use EX_TEMPFAIL (for example, the immutable
# script snapshot wrapper). Do not let the unit-level SuccessExitStatus=75
# mistake that real failure for a guard deferral; normalize the collision to a
# distinct non-success status after retaining the original in the guard log.
scheduled_child_tempfail_exit=74
# ...and once escalated, do not escalate again on the very next timer tick.  A
# backup that fails for a non-pressure reason would otherwise ignore pressure on
# every 5-minute tick forever.  This is the retry floor between escalations.
escalation_retry="${KOPIA_BACKUP_ESCALATION_RETRY_SEC:-3600}"
is_number "$max_defer" || { echo "invalid KOPIA_BACKUP_MAX_DEFER_SEC=$max_defer" >&2; exit 64; }
is_number "$escalation_retry" || { echo "invalid KOPIA_BACKUP_ESCALATION_RETRY_SEC=$escalation_retry" >&2; exit 64; }
# Budget for a --priority-on-contention producer's admission-pressure wait, summed
# across the whole cycle. The staleness floor normally ends that wait first
# (~max_defer minus the tick's staleness, ~1100-1600s for the hourly dump); the
# budget only bounds the corner where the floor declines to re-arm because it
# escalated less than escalation_retry ago. One recovery-point deadline by default.
priority_pressure_wait_max="${KOPIA_BACKUP_PRIORITY_PRESSURE_WAIT_MAX_SEC:-$max_defer}"
is_number "$priority_pressure_wait_max" || { echo "invalid KOPIA_BACKUP_PRIORITY_PRESSURE_WAIT_MAX_SEC=$priority_pressure_wait_max" >&2; exit 64; }
# How long PAST a waiter's own deadline an overdue holder whose deadline passed
# EARLIER may keep that waiter waiting (earliest-deadline-first, WI-10004861).
# Bounded on purpose: a holder that never finishes must not starve the waiter, so
# a due waiter is never held more than one more recovery-point period. 0 restores
# the WI-10004741 rule (an overdue holder yields the moment the waiter is due).
priority_hold_extension="${KOPIA_BACKUP_PRIORITY_HOLD_EXTENSION_SEC:-$max_defer}"
is_number "$priority_hold_extension" || { echo "invalid KOPIA_BACKUP_PRIORITY_HOLD_EXTENSION_SEC=$priority_hold_extension" >&2; exit 64; }
# An overdue holder keeps the lock against a waiter only while its child is still
# doing work (EI-25211496463956189). The signal is the holder's own cgroup I/O
# counters: a Kopia sweep re-hashes ~124G per run, so a sweep that is progressing
# moves them every few seconds, and one that has not moved them for this long is
# stuck and should not keep a recovery-point-critical dump waiting. An unreadable
# counter is "unknown" and keeps the time-bounded hold above, never a yield.
progress_stall_sec="${KOPIA_BACKUP_PROGRESS_STALL_SEC:-600}"
is_number "$progress_stall_sec" || { echo "invalid KOPIA_BACKUP_PROGRESS_STALL_SEC=$progress_stall_sec" >&2; exit 64; }
progress_path="${KOPIA_BACKUP_PROGRESS_PATH:-}"
if [ -z "$progress_path" ]; then
  progress_cgroup=$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup 2>/dev/null) || progress_cgroup=
  [ -z "$progress_cgroup" ] || progress_path="/sys/fs/cgroup${progress_cgroup}/io.stat"
fi

state_dir="${KOPIA_BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/papercusp/kopia-backup-guard}"
# The label reaches this from the command line and becomes a path segment.
state_key=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')
# NOT named "last-success": this timestamp is also seeded on the first-ever
# evaluation, when no success has happened.  It is the instant staleness is
# measured FROM, and naming it for the thing it is not is how a later reader
# concludes a backup succeeded when none did.
deadline_base_path="$state_dir/$state_key.deadline-base"
escalation_path="$state_dir/$state_key.last-escalation"

# Every state read fails CLOSED to "unknown", and every state write is
# best-effort: a guard that cannot write its own bookkeeping must still run the
# backup.  Never let this bookkeeping fail a cycle.
read_stamp() {
  local recorded
  [ -r "$1" ] || return 1
  recorded=$(cat "$1" 2>/dev/null) || return 1
  is_number "$recorded" || return 1
  printf '%s' "$recorded"
}

write_stamp() {
  local path="$1" tmp
  mkdir -p "$state_dir" 2>/dev/null || return 0
  tmp="$path.tmp.$$"
  if printf '%s\n' "$(date +%s)" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

age_of() {
  local recorded
  recorded=$(read_stamp "$1") || return 1
  awk -v now="$(date +%s)" -v then="$recorded" 'BEGIN { printf "%d", now - then }'
}

# Arm the override for this whole cycle, BEFORE and INDEPENDENTLY of admission.
#
# Admission is not where most cycles die, and building the floor only into the
# admission check would have left the dominant failure untouched.  Measured over
# 48h on this host (label=hot, from this guard's own journal): 51 cycles STARTED
# and 46 of them were retired mid-run by `deferred-during-run`; only 6 ever
# reached `finished rc=0`, the last 30 hours before this was written.  Those 46
# passed admission cleanly during a lull and were then killed seconds in by a
# transient crossing -- typically by a hair (io 10.06 against a limit of 10,
# memory 5.09 against 5).  A sweep visits its sources in order with
# --parallel=1, so a cycle killed at 46s covers whichever sources happen to come
# first and silently leaves the rest uncovered; which sources those are depends
# on where the kill lands.  That is why the override has to cover the run, not
# just its admission: pressure may DELAY a cycle, and may not CANCEL it, in
# either half of the cycle.
staleness_override_reason=
pressure_escalated=0
# Epoch at which THIS label's staleness floor armed (deadline-base + max_defer).
# Set only when the override arms; has_live_priority_waiter compares it against a
# waiter's published .due to decide which overdue producer goes first.
holder_due=
arm_staleness_override() {
  local age escalated_age
  if ! age=$(age_of "$deadline_base_path"); then
    # No baseline yet.  Seed the clock from now rather than arming immediately:
    # enabling this must not make every label on the host ignore pressure at
    # once on its first tick.
    write_stamp "$deadline_base_path"
    staleness_override_reason="staleness_sec=unknown-seeded max_defer_sec=$max_defer"
    return 1
  fi
  staleness_override_reason="staleness_sec=$age max_defer_sec=$max_defer"
  [ "$age" -ge "$max_defer" ] || return 1
  # Once armed, do not arm again on the very next tick.  A backup failing for a
  # NON-pressure reason would otherwise ignore pressure on every tick forever.
  if escalated_age=$(age_of "$escalation_path") && [ "$escalated_age" -lt "$escalation_retry" ]; then
    staleness_override_reason="$staleness_override_reason escalation_retry_in_sec=$((escalation_retry - escalated_age))"
    return 1
  fi
  write_stamp "$escalation_path"
  pressure_escalated=1
  holder_due=$(( $(date +%s) - age + max_defer ))
  guard_log "result=staleness-override-armed $staleness_override_reason"
  return 0
}

# /run/lock is the host-global lock namespace shared by the user systemd units
# and root-launched maintenance (for example, sudo systemd-run). Keep the lock
# in a dedicated non-sticky subdirectory: fs.protected_regular rejects root
# opening a user-owned file directly in sticky /run/lock. Do not derive the
# default from XDG_RUNTIME_DIR: that silently creates one lock per effective UID
# and lets privileged maintenance bypass the user-service guard.
lock_path="${KOPIA_BACKUP_LOCK_PATH:-/run/lock/papercusp/kopia-global.lock}"
# Both a user service and root maintenance may create the file first. Keep the
# inode writable by either identity, and append-open so acquiring the flock does
# not truncate any diagnostic bytes a deployment may leave in the file.
lock_umask=$(umask)
umask 000
mkdir -p "$(dirname "$lock_path")" || exit 73
exec 9>>"$lock_path" || exit 73
umask "$lock_umask"

# The workspace dump hook can read this PID-scoped receipt while the db-dump
# guard is waiting for the shared Kopia lock, before the host script starts.
# It is advisory only: failures writing the marker never fail or defer a backup.
guard_progress_path=
guard_progress_started_at=
guard_progress_start_ticks=
if [ "$label" = "db-dump" ]; then
  guard_progress_path="${lock_path}.db-dump.$$.run"
  guard_progress_started_at=$(date +%s)
  # /proc/<pid>/stat field 22, after stripping the variable-width comm field.
  guard_progress_start_ticks=$(awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$$/stat" 2>/dev/null)
fi
write_guard_progress() {
  local phase="$1" tmp
  [ -n "$guard_progress_path" ] || return 0
  [[ "$guard_progress_start_ticks" =~ ^[0-9]+$ ]] || return 0
  [[ "$guard_progress_started_at" =~ ^[0-9]+$ ]] || return 0
  tmp="${guard_progress_path}.tmp.$$"
  if ! printf '{"pid":%s,"processStartTicks":"%s","startedAtEpoch":%s,"phase":"%s"}\n' \
      "$$" "$guard_progress_start_ticks" "$guard_progress_started_at" "$phase" >"$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  mv -f "$tmp" "$guard_progress_path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}
cleanup_guard_progress() {
  [ -z "$guard_progress_path" ] || rm -f "$guard_progress_path" "${guard_progress_path}.tmp.$$" 2>/dev/null || true
}
trap cleanup_guard_progress EXIT
write_guard_progress guard-queued

priority_request_path=
priority_due_path=
cleanup_priority_request() {
  [ -z "$priority_request_path" ] || rm -f "$priority_request_path" 2>/dev/null || true
  [ -z "$priority_due_path" ] || rm -f "$priority_due_path" 2>/dev/null || true
}

# A restart-safe holder that YIELDS to a priority waiter stamps this note just
# before it releases the lock, and the next acquirer consumes it (WI-10004741).
# The acquirer judges the handoff by the note's age, not by its own total lock
# wait: a waiter can spend most of that wait behind a holder that never yields
# (the daily home snapshot runs 18-106 min) and still receive the lock from a
# sweep that was stopped for it seconds ago. Measured 2026-10-01 09:05Z: the
# db-dump waited 1154s, the overdue hot sweep took the lock and yielded to it 5s
# later, and the dump then released the lock to re-wait on pressure.
handoff_note_path="${lock_path}.handoff"
write_handoff_note() {
  printf '%s\n' "$(date +%s)" >"$handoff_note_path" 2>/dev/null || true
}
# Print the note's age in seconds and consume it; fail when there is none.
take_handoff_note() {
  local stamped
  stamped=$(cat "$handoff_note_path" 2>/dev/null) || return 1
  rm -f "$handoff_note_path" 2>/dev/null || true
  is_number "$stamped" || return 1
  printf '%d' "$(( $(date +%s) - stamped ))"
}

# A blocking waiter must be able to hand the shared lock back from a long hot
# sweep. POSIX flock does not promise that a waiter will outrank a holder's
# next work, and a single multi-hour `kopia snapshot create` otherwise leaves
# the hourly DB backup parked indefinitely. The marker is adjacent to the
# shared lock so user and root guards use the same request namespace.
#
# A scheduled waiter also publishes WHEN its own staleness floor arms, in a
# sibling .due file (WI-10004741). An OVERDUE restart-safe holder keeps the lock
# until that instant instead of yielding at once (see has_live_priority_waiter).
# Measured 2026-10-01: with the hourly dump preempting it, the hot sweep went from
# 23:50Z to past 09:30Z without one finished run, each attempt stopped 5s-37min in
# by a dump that was not itself late. Waiting until the dump's floor never holds
# the dump past the point where its own override would force it through anyway.
# The .due is written BEFORE the .wait marker, so a holder never sees a marker
# without its deadline. A marker with no .due -- a wait-mode producer, an
# unknown baseline, or a guard from before this change -- counts as due now.
# Wait-mode stays due-now on purpose (WI-10004871): its callers are the workspace
# dumps taken before a deploy, a boot migration or db:migrate (plus the workspace
# backup scheduler), and they give up
# after KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC (900s in packages/backup's hook),
# which then abandons the dump (resolves ok:false). Holding an overdue sweep against
# one for up to the EDF extension would cost that safety dump for sweep progress.
# The exception is opt-in: --deadline-at-arrival, which that hook passes only for its
# routine interval dumps (EI-25211496463956189), never for a safety dump.
# Its guard lines reach the host's journal via the hook's stderr forwarder, so
# each such preemption is attributable.
register_priority_request() {
  local base due
  priority_request_path="${lock_path}.${state_key}.$$.wait"
  priority_due_path=
  trap 'cleanup_priority_request; cleanup_guard_progress' EXIT
  if [ "$mode" = scheduled ] && base=$(read_stamp "$deadline_base_path"); then
    due=$(awk -v base="$base" -v defer="$max_defer" 'BEGIN { printf "%d", base + defer }')
    priority_due_path="${lock_path}.${state_key}.$$.due"
    printf '%s\n' "$due" >"$priority_due_path" 2>/dev/null || priority_due_path=
  elif [ "$mode" = wait ] && [ "$deadline_at_arrival" = 1 ]; then
    priority_due_path="${lock_path}.${state_key}.$$.due"
    printf '%s\n' "$(date +%s)" >"$priority_due_path" 2>/dev/null || priority_due_path=
  fi
  if ! printf '%s\n' "$$" >"$priority_request_path" 2>/dev/null; then
    priority_request_path=
    return 0
  fi
}

# Validate the marker's owner before honoring it. A SIGKILL can bypass the EXIT
# trap, and a stale PID must never make every scheduled snapshot self-cancel.
#
# A holder whose own staleness floor armed this cycle (pressure_escalated) is
# itself overdue, so it honors a waiter only once that waiter is due as well:
# its .due deadline has passed, or it published none (see
# register_priority_request). A holder that is not overdue honors every live
# waiter at once, exactly as before. Declining is logged once per waiter and reason.
#
# Once BOTH are overdue, the producer whose deadline passed FIRST goes first
# (earliest-deadline-first), for at most priority_hold_extension past the waiter's
# own deadline (WI-10004861). The WI-10004741 rule alone could not finish a sweep:
# measured 2026-10-01, the hourly dump ran 23-62 min (mostly 42-56) under the
# shared lock, so the gap between one dump finishing and the next becoming due was
# minutes, while a sweep must re-hash the ~93 GB of dumps rewritten since the
# previous one. Every sweep since 2026-09-30 23:50Z was stopped at that deadline,
# 12 of 14 by the hourly dump, and the dumps went 18h without an off-host copy.
# Under EDF the 13h-overdue sweep finishes before a 0h-overdue dump, then the
# finished sweep's fresh deadline sends the next dump first: the two alternate
# instead of one starving. The extension bounds the dump's wait if a sweep never
# finishes.
not_due_waiter_logged=
# The earliest-deadline hold is bounded from the LATER of the waiter's deadline and
# the moment it started waiting (its .wait marker's mtime), EI-25211496463956189.
# Anchoring at the deadline alone gave an earlier-deadline holder no protection at
# all against a waiter that had been overdue for longer than the extension before
# it ever arrived -- which is exactly the waiter a FAILED previous dump produces.
# Measured 2026-10-06: the dump's runs at 09:16 and 11:19 EDT failed, so at the
# 10:10 and 12:11 ticks it arrived 4.4h and 6.4h overdue, past
# due+extension, and stopped a sweep 11-13h overdue after 5s and after 52 min. The
# waiter still waits at most one extension past its arrival.
# Print the epoch the hold window is measured from, for a waiter due at $1 whose
# marker is $2.
hold_window_base() {
  local waiter_due="${1%.*}" arrived
  arrived=$(stat -c %Y -- "$2" 2>/dev/null) || arrived=
  if [[ "$arrived" =~ ^[0-9]+$ ]] && [ "$arrived" -gt "$waiter_due" ]; then
    printf '%d' "$arrived"
  else
    printf '%d' "$waiter_due"
  fi
}
# Print why this escalated holder keeps the lock against a waiter due at $1 whose
# hold window starts at $2, and succeed; fail when the holder must yield.
overdue_holder_hold_reason() {
  local waiter_due="${1%.*}" window_base="${2%.*}" now
  now=$(date +%s)
  if [ "$now" -lt "$waiter_due" ]; then
    printf 'holder-overdue'
    return 0
  fi
  if [ -n "$holder_due" ] && [ "$holder_due" -lt "$waiter_due" ] &&
    [ "$now" -lt $(( window_base + priority_hold_extension )) ]; then
    printf 'holder-earlier-deadline'
    return 0
  fi
  return 1
}
# Sum of the holder cgroup's read+write bytes; fails when the counter is unreadable.
read_progress_counter() {
  [ -r "$1" ] || return 1
  awk '
    {
      for (i = 2; i <= NF; i++) {
        split($i, kv, "=")
        if (kv[1] == "rbytes" || kv[1] == "wbytes") sum += kv[2]
      }
    }
    END { printf "%.0f", sum + 0 }
  ' "$1" 2>/dev/null
}
last_progress_value=
last_progress_at=
# Called once per monitor tick while the child runs.
sample_holder_progress() {
  local value
  [ -n "$progress_path" ] || return 0
  value=$(read_progress_counter "$progress_path") || return 0
  if [ "$value" != "$last_progress_value" ]; then
    last_progress_value=$value
    last_progress_at=$(date +%s)
  fi
}
# Print how long the child's I/O has not moved and succeed when that is at least
# progress_stall_sec; fail while it is moving or the counter is unknown.
holder_stalled_sec() {
  local stalled
  [ -n "$last_progress_at" ] || return 1
  stalled=$(( $(date +%s) - last_progress_at ))
  [ "$stalled" -ge "${progress_stall_sec%.*}" ] || return 1
  printf '%d' "$stalled"
}
waiter_mode_of() {
  case "$1" in
    *--mode\ wait*) printf 'wait' ;;
    *--mode\ scheduled*) printf 'scheduled' ;;
    *) printf 'unknown' ;;
  esac
}
yield_waiter_logged=
has_live_priority_waiter() {
  local request pid cmd due_path due hold_reason now window_base stalled yield_reason
  for request in "${lock_path}".*.wait; do
    [ -f "$request" ] || continue
    due_path="${request%.wait}.due"
    pid=$(cat "$request" 2>/dev/null || true)
    if ! [[ "$pid" =~ ^[0-9]+$ ]] || [ ! -r "/proc/$pid/cmdline" ]; then
      rm -f "$request" "$due_path" 2>/dev/null || true
      continue
    fi
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    # A scheduled-mode marker is only written after the staleness floor arms;
    # it is therefore a priority waiter too. Ignoring it lets a hot sweep keep
    # the lock while the recovery-point-critical DB dump is already waiting.
    if [[ "$cmd" == *kopia-backup-guard.sh*--mode\ wait* ||
          "$cmd" == *kopia-backup-guard.sh*--mode\ scheduled* ]]; then
      if [ "$pressure_escalated" = 1 ] && due=$(read_stamp "$due_path"); then
        window_base=$(hold_window_base "$due" "$request")
        if hold_reason=$(overdue_holder_hold_reason "$due" "$window_base"); then
          if stalled=$(holder_stalled_sec); then
            guard_log "result=yielding-to-priority-waiter reason=holder-stalled waiter=${request##*/} would_hold=$hold_reason stalled_sec=$stalled stall_limit_sec=$progress_stall_sec progress_path=$progress_path"
            return 0
          fi
          if [ "$not_due_waiter_logged" != "$request:$hold_reason" ]; then
            not_due_waiter_logged="$request:$hold_reason"
            now=$(date +%s)
            if [ "$hold_reason" = holder-overdue ]; then
              guard_log "result=holding-against-priority-waiter reason=holder-overdue waiter=${request##*/} waiter_due_in_sec=$(( ${due%.*} - now )) $staleness_override_reason"
            else
              guard_log "result=holding-against-priority-waiter reason=holder-earlier-deadline waiter=${request##*/} waiter_overdue_sec=$(( now - ${due%.*} )) holder_overdue_sec=$(( now - holder_due )) hold_ends_in_sec=$(( window_base + priority_hold_extension - now )) $staleness_override_reason"
            fi
          fi
          continue
        fi
      fi
      # Name the waiter this holder honors, once per waiter and reason; the caller's
      # next line says what it did about it (stopping-during-run, or holding for a
      # child that is not restart-safe). Before this line the holder's journal said
      # only "stopping-during-run reason=priority-waiter", so a preemption by a
      # waiter that logs nowhere the host can read (2026-10-06 15:19:44 EDT: an
      # overdue sweep stopped while the only logged waiter was 33 min from due)
      # could not be attributed afterwards.
      if [ "$pressure_escalated" != 1 ]; then
        yield_reason=holder-not-overdue
      elif ! due=$(read_stamp "$due_path"); then
        yield_reason=waiter-due-now
      else
        yield_reason="waiter-due waiter_overdue_sec=$(( $(date +%s) - ${due%.*} ))"
      fi
      if [ "$yield_waiter_logged" != "$request:${yield_reason%% *}" ]; then
        yield_waiter_logged="$request:${yield_reason%% *}"
        guard_log "result=honoring-priority-waiter reason=$yield_reason waiter=${request##*/} waiter_pid=$pid waiter_mode=$(waiter_mode_of "$cmd")"
      fi
      return 0
    fi
    rm -f "$request" "$due_path" 2>/dev/null || true
  done
  return 1
}

guard_log() {
  if [ "${KOPIA_BACKUP_GUARD_LOG_STDERR:-0}" = 1 ]; then
    printf 'KOPIA_BACKUP_GUARD timestamp=%s label=%s %s\n' "$(date -Iseconds)" "$label" "$*" >&2
  else
    printf 'KOPIA_BACKUP_GUARD timestamp=%s label=%s %s\n' "$(date -Iseconds)" "$label" "$*"
  fi
}

signal_hook_ready() {
  [ "${KOPIA_BACKUP_GUARD_READY_FD:-}" = 3 ] || return 0
  if ! printf 'KOPIA_BACKUP_GUARD_READY\n' >&3 2>/dev/null; then
    guard_log "result=failed mode=wait reason=readiness-signal"
    return 1
  fi
  exec 3>&-
}

# The workspace hook uses a two-way handshake around its cross-process
# migration rendezvous. READY means this process owns the shared Kopia flock;
# pg_dump must not start until the parent has reacquired the advisory lock and
# rechecked whether the host dump already covered the database.
hook_ack=
wait_for_hook_ack() {
  [ "${KOPIA_BACKUP_GUARD_READY_FD:-}" = 3 ] || return 0
  [ "${KOPIA_BACKUP_GUARD_ACK_FD:-}" = 4 ] || return 0
  local timeout_sec="${KOPIA_BACKUP_GUARD_ACK_TIMEOUT_SEC:-1805}"
  is_number "$timeout_sec" || {
    echo "invalid KOPIA_BACKUP_GUARD_ACK_TIMEOUT_SEC=$timeout_sec" >&2
    return 1
  }
  awk -v value="$timeout_sec" 'BEGIN { exit !(value > 0) }' || {
    echo "invalid KOPIA_BACKUP_GUARD_ACK_TIMEOUT_SEC=$timeout_sec" >&2
    return 1
  }
  if ! IFS= read -r -t "$timeout_sec" hook_ack <&4; then
    guard_log "result=failed mode=wait reason=ack-timeout timeout_sec=$timeout_sec"
    return 1
  fi
  exec 4<&-
  case "$hook_ack" in
    PROCEED) return 0 ;;
    SKIP) return 2 ;;
    *)
      guard_log "result=failed mode=wait reason=invalid-ack"
      return 1
      ;;
  esac
}

read_full_avg10() {
  local path="$1"
  [ -r "$path" ] || return 1
  awk '
    $1 == "full" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^avg10=/) {
          value = substr($i, 7)
          if (value ~ /^[0-9]+([.][0-9]+)?$/) {
            print value
            found = 1
            exit
          }
        }
      }
    }
    END { if (!found) exit 1 }
  ' "$path"
}

at_or_above() {
  awk -v value="$1" -v limit="$2" 'BEGIN { exit !(value >= limit) }'
}

# A scheduled backup can START on a quiet host and CREATE pressure minutes later.
# The admission check below cannot see that future state.  Keep watching the same
# authoritative PSI files for the child lifetime and retire only this scheduled
# invocation if it crosses either budget.  Kopia snapshots are content-addressed
# and restart-safe; the next timer run reuses uploaded content.  The child script's
# EXIT trap also kills its exact root-owned Kopia PID, so stopping the user-owned
# wrapper cannot leave an unbounded root process behind.
runtime_abort_reason=
run_scheduled_command() {
  # FD 9 is the guard's ownership token, not part of the command contract.
  # Never let the child inherit it. If this wrapper is SIGKILLed, an otherwise
  # healthy/blocked child can outlive us; inheriting the open file description
  # made that orphan retain the global flock indefinitely (WI-10000839).
  # Keeping the descriptor only in this supervising shell makes wrapper death
  # release the lock immediately, while normal runs remain serialized for the
  # full child lifetime because this shell waits below.
  #
  # EARLY RELEASE (WI-10004870). The child cannot release a lock it does not
  # hold, so it ASKS: creating $KOPIA_BACKUP_GUARD_RELEASE_PATH tells this shell
  # that the rest of the child's work no longer needs the shared lock, and the
  # loop below unlocks fd 9 while it goes on waiting for the child exactly as
  # before. The hourly db-dump uses it once every enrolled artifact is written:
  # its last ~25 min (the 101G transcript tier, which .kopiaignore keeps out of
  # every snapshot) used to hold the lock against the hot sweep for nothing.
  # The path carries this guard's pid, so a stale request left by a killed
  # guard can never release a later one. A child that never asks keeps the old
  # whole-lifetime hold, so every other label is unchanged.
  release_request_path="${lock_path}.release.$$"
  rm -f "$release_request_path" 2>/dev/null || true
  export KOPIA_BACKUP_GUARD_RELEASE_PATH="$release_request_path"
  "$@" 9>&- &
  child_pid=$!

  local declined_handoff_logged=0
  local lock_released_early=0
  local lock_held_since
  lock_held_since=$(date +%s)

  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$monitor_interval"
    kill -0 "$child_pid" 2>/dev/null || break

    if [ "$lock_released_early" -eq 0 ] && [ -e "$release_request_path" ]; then
      flock -u 9
      lock_released_early=1
      guard_log "result=released-early child_pid=$child_pid held_sec=$(( $(date +%s) - lock_held_since ))"
    fi
    # Nothing below applies to a lock this shell no longer holds: a priority
    # waiter simply acquires it, so there is nothing left to yield.
    [ "$lock_released_early" -eq 0 ] || continue

    sample_holder_progress
    # A protected/manual wait-mode producer has priority over a hot sweep. Terminate only
    # this scheduled child and release the flock; content-addressed Kopia
    # snapshots are restart-safe, while leaving the waiter blocked is not.
    #
    # ...but ONLY when this child really is restart-safe. For a
    # --no-restart-safe child (see restart_safe above) the trade inverts: the
    # waiter loses at most this child's remaining runtime, which is bounded,
    # whereas the child loses ALL of its work and writes no success record. We
    # hold the lock and log it ONCE, so declining to yield stays observable
    # instead of looking like a guard that forgot to check.
    if has_live_priority_waiter; then
      if [ "$restart_safe" -eq 1 ]; then
        runtime_abort_reason="priority-waiter shared-guard handoff"
        break
      fi
      if [ "$declined_handoff_logged" -eq 0 ]; then
        declined_handoff_logged=1
        guard_log "result=holding-against-priority-waiter reason=child-not-restart-safe child_pid=$child_pid"
      fi
    fi

    # NO MID-RUN PRESSURE CANCELLATION.  Both candidate signals were measured on
    # this host 2026-09-05 and NEITHER describes a harm this backup can relieve:
    #
    #   HOST-WIDE /proc/pressure/memory is fleet-driven, not backup-driven.
    #   Sampled at 2s for 2.7 minutes with ZERO kopia processes running it ranged
    #   0.02-41.91 and sat at or above the limit of 5 in 52.4% of 82 samples.  The
    #   mid-run check aborts on the FIRST crossing, so a run needs an unbroken
    #   sub-limit streak for its whole duration: 1024s-2332s required against a
    #   40s longest observed.  Result: 20 of 20 ordinary cycles killed after
    #   passing admission (10s-426s in), zero coverage.
    #
    #   PER-CGROUP memory.pressure is real and isolated -- a fresh cgroup starts
    #   at total=0 and tracks only its own stalls -- but what it measures is the
    #   backup's OWN page-cache reclaim, which is what reading the filesystem IS.
    #   Measured on the 23:00 cycle: the cgroup rose 1.71 -> 2.47 -> 5.36 in 25s
    #   at 1.4G RSS (nowhere near MemoryHigh=8G) while root read 19.50 -> 9.93,
    #   independent numbers, and the run was killed at 30s.  A threshold of 5 on
    #   that signal means "this job is doing I/O", not "the host is hurting".
    #
    # So a per-sample threshold cancels a data-safety job either for someone
    # else's load or for its own normal operation, and zero coverage is the larger
    # harm.  What actually bounds this backup is what always did: the unit's
    # MemoryHigh=8G / MemoryMax=12G with MemorySwapMax=0, Nice=10, ionice
    # best-effort 7, and Kopia's --parallel=1.  Direct evidence that running
    # ungated is safe here: the two cycles that skipped this check entirely (the
    # staleness-override path) both completed, with no host incident in either
    # window.  Admission still defers on the host-wide signal, so a genuinely
    # burning box still delays the START of a cycle; the priority-waiter handoff
    # above still preempts a hot sweep for a higher-priority producer.
  done

  if [ -n "$runtime_abort_reason" ] && kill -0 "$child_pid" 2>/dev/null; then
    guard_log "result=stopping-during-run reason=$runtime_abort_reason child_pid=$child_pid"
    kill -TERM "$child_pid" 2>/dev/null || true
    # printf "%.3f", NOT a bare `print`: awk's default OFMT is %.6g, so a ~1.79e9 epoch
    # deadline prints as "1.78836e+09" — ~3700s SHORT of the real value. The deadline then
    # lands in the past, the grace loop below exits on its first evaluation, and the child is
    # SIGKILLed immediately no matter what KOPIA_BACKUP_STOP_GRACE_SEC says. That defeats the
    # child's EXIT trap, which is what reaps the root-owned Kopia PID (see the header note),
    # and it surfaces as a bash job-control notice on the guard's stderr.
    stop_deadline=$(awk -v now="$(date +%s.%N)" -v grace="$stop_grace" 'BEGIN { printf "%.3f", now + grace }')
    while kill -0 "$child_pid" 2>/dev/null &&
      awk -v now="$(date +%s.%N)" -v deadline="$stop_deadline" 'BEGIN { exit !(now < deadline) }'; do
      sleep 0.1
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      guard_log "result=killing-after-grace reason=$runtime_abort_reason child_pid=$child_pid grace_sec=$stop_grace"
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi

  wait "$child_pid"
  child_rc=$?
  rm -f "$release_request_path" 2>/dev/null || true
  if [ -n "$runtime_abort_reason" ]; then
    # The child is reaped; the lock is released when this guard exits.
    write_handoff_note
    guard_log "result=deferred-during-run reason=$runtime_abort_reason child_rc=$child_rc"
    # The escalation retry exists so a backup that FAILS for a non-pressure reason
    # cannot override pressure on every tick forever. A cycle that yielded to a
    # priority waiter did not fail, so it must not spend the once-per-retry
    # override. Measured 2026-09-29 (WI-10003884): the hourly db-dump preempted the
    # overdue hot sweep at every :00 tick, each preemption spent the escalation, and
    # the :30 tick then deferred on pressure -- label=hot went 18,958s unfinished.
    if [ "$pressure_escalated" -eq 1 ]; then
      rm -f "$escalation_path" 2>/dev/null || true
      guard_log "result=escalation-refunded reason=$runtime_abort_reason"
    fi
    return "$scheduled_defer_exit"
  fi
  return "$child_rc"
}

# Take the shared lock for a scheduled cycle, or exit with the deferral status.
# Called once before admission and again after every admission-pressure wait, so
# a re-acquire follows exactly the same three branches as the first acquire.
#
# lock_handoff_requested / lock_waited_sec record whether this cycle took the lock
# by registering a priority request (which makes a running restart-safe hot sweep
# STOP) and how long that took. The admission loop below reads them: see
# handoff_fresh_sec.
lock_handoff_requested=0
lock_waited_sec=0
handoff_note_age=
acquire_scheduled_lock() {
  local lock_wait_started
  write_guard_progress guard-queued
  lock_handoff_requested=0
  lock_waited_sec=0
  handoff_note_age=
  if flock -n 9; then
    # No request was registered, so no sweep yielded for this cycle: drop any note.
    rm -f "$handoff_note_path" 2>/dev/null || true
    write_guard_progress guard-running
    return 0
  fi
  if [ "$pressure_escalated" = 1 ]; then
    register_priority_request
    guard_log "result=waiting reason=staleness-override-lock $staleness_override_reason"
  elif [ "$priority_on_contention" = 1 ]; then
    register_priority_request
    guard_log "result=waiting reason=priority-on-contention $staleness_override_reason"
  else
    guard_log "result=deferred reason=lock-held $staleness_override_reason"
    exit "$scheduled_defer_exit"
  fi
  lock_handoff_requested=1
  lock_wait_started=$(date +%s)
  flock 9 || exit "$scheduled_defer_exit"
  write_guard_progress guard-running
  lock_waited_sec=$(( $(date +%s) - lock_wait_started ))
  handoff_note_age=$(take_handoff_note) || handoff_note_age=
  cleanup_priority_request
}

# How long a restart-safe holder can take to yield to a priority request: it
# polls for the marker every monitor_interval, then gives its child stop_grace
# before SIGKILL. A lock acquired through a request within this window means the
# admission reading taken just before the request is still current, and that a
# running sweep has most likely just been stopped for this cycle. Re-checking
# pressure then and RELEASING the lock to wait again would throw that stopped
# sweep's work away for a cycle that does not run (WI-10004666). A longer wait
# means the holder ran to its own end, so the reading is stale and the loop
# re-checks as before.
handoff_fresh_sec=$(awk -v m="$monitor_interval" -v g="$stop_grace" 'BEGIN { printf "%d", m + g + 5 }')

# Evaluate every admission signal before taking ONE deferral decision. The
# staleness floor applies to all of them. An unreadable PSI file defers exactly
# like real pressure and so must escalate exactly like it: otherwise a host that
# stops publishing pressure never backs up again either.
evaluate_admission() {
  admission_block_reason=
  memory_psi=$(read_full_avg10 "$memory_path") || memory_psi=
  io_psi=$(read_full_avg10 "$io_path") || io_psi=
  if [ -z "$memory_psi" ]; then
    admission_block_reason="pressure-unavailable signal=memory path=$memory_path"
  elif [ -z "$io_psi" ]; then
    admission_block_reason="pressure-unavailable signal=io path=$io_path"
  elif at_or_above "$memory_psi" "$memory_limit"; then
    admission_block_reason="memory-pressure full_avg10=$memory_psi limit=$memory_limit"
  elif at_or_above "$io_psi" "$io_limit"; then
    admission_block_reason="io-pressure full_avg10=$io_psi limit=$io_limit"
  fi
}

# A --priority-on-contention producer whose admission is blocked WAITS for the
# block to lift instead of exiting (see priority_on_contention above for why a
# deferral costs such a producer a whole hour). The wait is bounded three ways,
# and every exit is logged:
#   - pressure clears on any one sample   -> return 0, admit normally;
#   - the staleness floor arms meanwhile  -> return 0, admitted-despite-pressure,
#     which is exactly what the NEXT tick would have done ~1h later, with the
#     same cgroup caps -- so waiting never admits a run the floor would not;
#   - the cycle's wait budget runs out    -> return 1, the caller defers as before.
# The caller releases the shared lock BEFORE calling this. Holding it here would
# block every wait-mode producer (the daily home snapshot, the workspace dump)
# for the whole wait, although those producers ignore pressure by design.
pressure_wait_started=
pressure_waited_sec=0
wait_out_admission_pressure() {
  [ -n "$pressure_wait_started" ] || pressure_wait_started=$(date +%s)
  guard_log "result=waiting reason=priority-on-pressure $admission_block_reason $staleness_override_reason"
  while :; do
    pressure_waited_sec=$(( $(date +%s) - pressure_wait_started ))
    if at_or_above "$pressure_waited_sec" "$priority_pressure_wait_max"; then
      return 1
    fi
    sleep "$monitor_interval"
    evaluate_admission
    if [ -z "$admission_block_reason" ]; then
      pressure_waited_sec=$(( $(date +%s) - pressure_wait_started ))
      guard_log "result=pressure-cleared waited_sec=$pressure_waited_sec"
      return 0
    fi
    # Logs result=staleness-override-armed itself when it arms.
    arm_staleness_override && return 0
  done
}

if [ "$mode" = scheduled ]; then
  # Lock contention is another deferral path. Arm the staleness floor before
  # the nonblocking flock so a scheduled producer cannot defer forever without
  # ever recording that it has crossed its recovery-point deadline. Once the
  # floor is armed, become a priority waiter: the hot-sweep handoff recognizes
  # this marker and yields the shared lock instead of starving this producer.
  arm_staleness_override || true

  # WHY THE CGROUP AND NOT /proc/pressure -- measured on this host 2026-09-05.
  #
  # The host-wide files do not measure this backup.  They measure the box, and
  # this box runs a large agent fleet: sampled at 2s for 2.7 minutes with ZERO
  # kopia processes running, /proc/pressure/memory full avg10 swung 0.02 -> 41.91
  # and sat AT OR ABOVE the limit of 5 for 52.4% of samples, at load average 162
  # across 128 cores with 79 agent processes alive.
  #
  # The mid-run gate aborts on the FIRST sample at or above the limit, so a run
  # survives only on an unbroken sub-limit streak lasting its whole duration.
  # Required: 1024s and 2332s -- the two runtimes that actually completed.
  # Longest sub-limit window observed: 40 SECONDS.  That 25-58x gap is why 19 of
  # 19 ordinary cycles died on 2026-09-05 (10s-426s each) while the only two
  # successes were both staleness-override-armed: the escape hatch had become
  # the schedule.
  #
  # Raising the limit was rejected above for the right reason (a larger constant
  # has the same unbounded shape).  Hysteresis was considered and rejected too:
  # the crossings are real and sustained, not transient hair-crossings, so
  # smoothing cannot help when the signal itself is the wrong one.  The defect is
  # that the backup was CANCELLED for pressure it did not create, cannot relieve,
  # and is already isolated from -- it runs at nice 19, ionice idle, capped by the
  # unit at MemoryHigh=8G/MemoryMax=12G with MemorySwapMax=0.  Those caps, not a
  # host-wide reading, are what protect the host from the backup.  The question
  # the gate should ask is "is THIS BACKUP thrashing", and the cgroup answers it.
  # ADMISSION reads the HOST-WIDE files deliberately, and the per-cgroup files
  # are not a usable substitute HERE even though they are real.  This unit is
  # Type=oneshot, so at admission its cgroup is seconds old and reads
  # "full avg10=0.00 total=0" every time -- an admission gate gated on it would
  # never defer anything, which is worse than no gate because it would still
  # LOOK like one.  Admission asks "is the box already in trouble before we add
  # load", and only /proc/pressure answers that.  (The per-cgroup signal is
  # genuinely isolated and does describe this backup once it is running -- see
  # the mid-run note in run_scheduled_command for why acting on it there is
  # still wrong.)
  psi_scope=host
  default_memory_path=/proc/pressure/memory
  default_io_path=/proc/pressure/io
  memory_path="${KOPIA_BACKUP_MEM_PSI_PATH:-$default_memory_path}"
  io_path="${KOPIA_BACKUP_IO_PSI_PATH:-$default_io_path}"
  # Report the scope we ACTUALLY read, not the one we would have picked.  An
  # explicit override (the test harness, or a host-specific unit drop-in) means
  # the reading is neither this cgroup's nor the host's, and a log line claiming
  # otherwise would be a label that does not mean what it says.
  if [ "$memory_path" != "$default_memory_path" ] || [ "$io_path" != "$default_io_path" ]; then
    psi_scope=override
  fi
  guard_log "result=psi-scope scope=$psi_scope memory_path=$memory_path io_path=$io_path"

  # A priority producer waits out its OWN admission pressure BEFORE it contends
  # for the lock -- without the lock and without a priority marker. Contending
  # first registers the marker that makes a running restart-safe hot sweep stop,
  # and only then learning that this cycle may not start yet stopped that sweep
  # for nothing. Measured 2026-10-01 (WI-10004666): the 07:10Z db-dump tick
  # stopped a hot sweep 36 min in (154.5G read), then logged
  # priority-on-pressure io full_avg10=24.08 and did not run; the sweep restarted
  # at 07:30Z and was stopped again at 07:34Z when the dump's floor armed. Host io
  # full avg10 sits above the limit most of the time, so that was the usual
  # outcome of a tick, and the sweep had not completed since 2026-09-29.
  if [ "$priority_on_contention" = 1 ] && [ "$pressure_escalated" != 1 ]; then
    evaluate_admission
    if [ -n "$admission_block_reason" ] && ! wait_out_admission_pressure; then
      guard_log "result=deferred reason=$admission_block_reason $staleness_override_reason waited_sec=$pressure_waited_sec"
      exit "$scheduled_defer_exit"
    fi
  fi
  acquire_scheduled_lock

  # The staleness floor was armed once before lock acquisition and applies to
  # every admission signal (see evaluate_admission).
  evaluate_admission
  while [ -n "$admission_block_reason" ]; do
    if [ "$pressure_escalated" = 1 ]; then
      guard_log "result=admitted-despite-pressure reason=$admission_block_reason $staleness_override_reason"
      break
    fi
    if [ "$priority_on_contention" != 1 ]; then
      guard_log "result=deferred reason=$admission_block_reason $staleness_override_reason"
      exit "$scheduled_defer_exit"
    fi
    # The lock came through a handoff seconds after admission cleared: keep it
    # (see handoff_fresh_sec). The cgroup caps bound this run exactly as they
    # bound an admitted-despite-pressure one.
    # A long total wait still counts when the lock came from a sweep that yielded
    # for it moments ago (the handoff note, see write_handoff_note).
    if [ "$lock_handoff_requested" = 1 ] &&
      { [ "$lock_waited_sec" -le "$handoff_fresh_sec" ] ||
        { [ -n "$handoff_note_age" ] && [ "$handoff_note_age" -le "$handoff_fresh_sec" ]; }; }; then
      guard_log "result=admitted-after-handoff reason=$admission_block_reason lock_waited_sec=$lock_waited_sec handoff_note_age_sec=${handoff_note_age:-none} $staleness_override_reason"
      break
    fi
    # Priority producer: pressure DELAYS this cycle and may not cancel it. Never
    # wait on pressure while holding the shared lock (see
    # wait_out_admission_pressure), then re-take it through the same branches
    # and re-check: a long lock wait can outlast the lull that ended the
    # pressure wait. The budget spans every pass, so this loop terminates.
    write_guard_progress guard-queued
    flock -u 9
    if ! wait_out_admission_pressure; then
      guard_log "result=deferred reason=$admission_block_reason $staleness_override_reason waited_sec=$pressure_waited_sec"
      exit "$scheduled_defer_exit"
    fi
    acquire_scheduled_lock
    evaluate_admission
  done
else
  write_guard_progress guard-queued
  register_priority_request
  guard_log "result=waiting reason=lock"
  guard_lock_wait_timeout_sec="${KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC:-900}"
  is_number "$guard_lock_wait_timeout_sec" || {
    echo "invalid KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC=$guard_lock_wait_timeout_sec" >&2
    exit 64
  }
  awk -v value="$guard_lock_wait_timeout_sec" 'BEGIN { exit !(value > 0) }' || {
    echo "invalid KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC=$guard_lock_wait_timeout_sec" >&2
    exit 64
  }
  if ! flock -w "$guard_lock_wait_timeout_sec" 9; then
    guard_log "result=failed mode=wait reason=lock-timeout timeout_sec=$guard_lock_wait_timeout_sec"
    exit 75
  fi
  write_guard_progress guard-running
  signal_hook_ready || exit 74
  if wait_for_hook_ack; then
    :
  else
    hook_ack_status=$?
    if [ "$hook_ack_status" -eq 2 ]; then
      rm -f "$handoff_note_path" 2>/dev/null || true
      cleanup_priority_request
      guard_log "result=finished mode=wait rc=0 skipped=parent-covered"
      exit 0
    fi
    exit 74
  fi
  # A note left by a sweep that yielded to this wait-mode producer is spent here.
  rm -f "$handoff_note_path" 2>/dev/null || true
  cleanup_priority_request
fi

export KOPIA_BACKUP_GUARD_ACTIVE=1
guard_log "result=started mode=$mode"
if [ "$mode" = scheduled ]; then
  run_scheduled_command "$@"
  rc=$?
  # Same contract as an admission-time pressure deferral: the scheduled cycle
  # intentionally did no complete snapshot, so preserve its retryable
  # EX_TEMPFAIL status for systemd. The scheduled units classify that code as an
  # expected retry; a completed child keeps its own status, including genuine
  # failures that must still reach OnFailure.
  if [ -n "$runtime_abort_reason" ]; then
    return "$rc"
  fi
  if [ "$rc" -eq "$scheduled_defer_exit" ]; then
    guard_log "result=finished mode=$mode rc=$rc normalized_rc=$scheduled_child_tempfail_exit"
    rc="$scheduled_child_tempfail_exit"
  else
    guard_log "result=finished mode=$mode rc=$rc"
  fi
else
  # Same ownership boundary as the scheduled path above. In particular, the
  # workspace pg_dump hook has its own watchdog; killing this wait-mode wrapper
  # must not leave pg_dump holding our flock after it is reparented to systemd.
  "$@" 9>&-
  rc=$?
  guard_log "result=finished mode=$mode rc=$rc"
fi
# Only a run that actually completed resets the staleness clock.  A deferral
# never reaches here, and the scheduled runtime-abort path returns above, so
# neither can be mistaken for coverage.
if [ "$rc" -eq 0 ]; then
  write_stamp "$deadline_base_path"
fi
return "$rc"
}

main "$@"; exit $?
