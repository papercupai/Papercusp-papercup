#!/usr/bin/env bash
# Shared cache/log-directory bootstrap for the Kopia systemd scripts.
#
# A managed host may relocate ~/.cache/kopia by symlink. `mkdir -p
# ~/.cache/kopia` returns "File exists" when that symlink is dangling, so the
# callers must create the target rather than trying to replace the link. This
# helper is deliberately source-only: callers decide how a bootstrap failure
# should affect their operation.

# Ensure a cache/log directory exists and is usable without replacing a
# pre-existing symlink. A dangling symlink is repaired by creating its target;
# a symlink to a file, an ordinary file, or an unwritable target is rejected.
ensure_kopia_cache_dir() {
  local cache_dir="${1:-}" target=""

  if [ -z "$cache_dir" ]; then
    echo "Kopia cache directory is empty" >&2
    return 1
  fi

  if [ -L "$cache_dir" ]; then
    target="$(readlink -- "$cache_dir" 2>/dev/null)" || {
      echo "Unable to read Kopia cache symlink: $cache_dir" >&2
      return 1
    }
    if [ -z "$target" ]; then
      echo "Kopia cache symlink has an empty target: $cache_dir" >&2
      return 1
    fi
    if [[ "$target" != /* ]]; then
      target="$(dirname -- "$cache_dir")/$target"
    fi
    if ! mkdir -p -- "$target"; then
      echo "Unable to create Kopia cache symlink target: $target" >&2
      return 1
    fi
  elif [ -e "$cache_dir" ]; then
    if [ ! -d "$cache_dir" ]; then
      echo "Kopia cache path is not a directory: $cache_dir" >&2
      return 1
    fi
  elif ! mkdir -p -- "$cache_dir"; then
    echo "Unable to create Kopia cache directory: $cache_dir" >&2
    return 1
  fi

  if [ ! -d "$cache_dir" ]; then
    echo "Kopia cache path is not a usable directory: $cache_dir" >&2
    return 1
  fi
  if [ ! -w "$cache_dir" ]; then
    echo "Kopia cache directory is not writable: $cache_dir" >&2
    return 1
  fi
}

# Kopia's root-run CLI defaults logs to /root/.cache/kopia/cli-logs. On this host
# that path lands on the nearly full /mnt/data volume, so a log write can abort a
# snapshot before it flushes. The app's backup:diff tool already uses the supported
# KOPIA_LOG_DIR setting; keep systemd/manual root invocations on the separate backup
# volume too. Pass it through sudo explicitly because sudo drops caller environment.
kopia_as_root() {
  if [ "$#" -lt 2 ]; then
    echo "usage: kopia_as_root SUDO_BIN COMMAND [ARG ...]" >&2
    return 64
  fi

  local sudo_bin="$1" log_dir
  shift
  log_dir="${KOPIA_LOG_DIR:-/mnt/backup/kopia-cli-logs}"
  case "$log_dir" in
    /*) ;;
    *)
      echo "Kopia CLI log directory must be absolute: $log_dir" >&2
      return 64
      ;;
  esac
  case "$log_dir" in
    /mnt/backup|/mnt/backup/*)
      if ! mountpoint -q /mnt/backup; then
        echo "Kopia CLI log filesystem is not mounted: /mnt/backup" >&2
        return 1
      fi
      ;;
  esac
  if ! ensure_kopia_cache_dir "$log_dir"; then
    echo "Unable to prepare Kopia CLI log directory: $log_dir" >&2
    return 1
  fi

  "$sudo_bin" -n -- /usr/bin/env "KOPIA_LOG_DIR=$log_dir" "$@"
}

# EI-25985604292707665: every snapshot create expires older snapshots. Pin
# everything before capture, always pin its new manifest, then remove ONLY our
# pin under a fresh no-hold table lease. Capture never holds the table lock.
KOPIA_RETENTION_PIN='papercusp-legal-hold-retention'

kopia_retention_ids() {
  local sudo_bin="$1" kopia_bin="$2" raw
  raw=$(kopia_as_root "$sudo_bin" "$kopia_bin" snapshot list --all --json) || return
  /usr/bin/python3 -c 'import json,re,sys
rows=json.load(sys.stdin)
if not isinstance(rows,list) or any(not isinstance(r,dict) or not isinstance(r.get("id"),str) or not re.fullmatch("[a-f0-9]+",r["id"]) for r in rows):
 raise ValueError("malformed Kopia snapshot list; expiry refused")
print("\n".join(r["id"] for r in rows))' <<<"$raw"
}

kopia_retention_pin_all() {
  local sudo_bin="$1" kopia_bin="$2" operation="$3" ids id
  ids=$(kopia_retention_ids "$sudo_bin" "$kopia_bin") || return
  local -a batch=()
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    batch+=("$id")
    if [ "${#batch[@]}" -ge 100 ]; then
      kopia_as_root "$sudo_bin" "$kopia_bin" snapshot pin "--$operation=$KOPIA_RETENTION_PIN" "${batch[@]}" || return
      batch=()
    fi
  done <<<"$ids"
  [ "${#batch[@]}" -eq 0 ] || kopia_as_root "$sudo_bin" "$kopia_bin" snapshot pin "--$operation=$KOPIA_RETENTION_PIN" "${batch[@]}"
}

# Run a short filesystem/repository destructive callback while this SAME psql
# session holds SHARE on the hold table. INSERT/UPDATE/DELETE (even direct hold
# writers) wait until it exits. Any startup/query/malformed-state failure refuses
# the callback. The callback receives 't' for any active hold, otherwise 'f'.
kopia_with_hold_lease() (
  local database="$1" callback="$2" line="" held="" pid="" input="" output=""
  shift 2
  coproc KOPIA_HOLD_PSQL {
    exec "${KOPIA_HOLD_SUDO_BIN:-/usr/bin/sudo}" -n -u postgres \
      "${KOPIA_HOLD_PSQL_BIN:-/usr/bin/psql}" -X -q -v ON_ERROR_STOP=1 -At \
      -h /var/run/postgresql -d "$database"
  }
  pid="${KOPIA_HOLD_PSQL_PID:-}"
  input="${KOPIA_HOLD_PSQL[1]:-}"
  output="${KOPIA_HOLD_PSQL[0]:-}"
  [ -n "$pid" ] && [ -n "$input" ] && [ -n "$output" ] || return 1
  trap 'exec {input}>&-; wait "$pid" 2>/dev/null || true' EXIT
  printf '%s\n' 'BEGIN;' "SET LOCAL lock_timeout = '30s';" \
    'LOCK TABLE harness_shared.data_source_legal_holds IN SHARE MODE;' \
    'SELECT EXISTS (SELECT 1 FROM harness_shared.data_source_legal_holds WHERE released_at IS NULL);' \
    '\echo PAPERCUSP_HOLD_READY' >&"$input" || return 1
  while IFS= read -r -t 35 -u "$output" line; do
    case "$line" in
      t|f) held="$line" ;;
      PAPERCUSP_HOLD_READY) break ;;
      *) echo "backup retention: malformed hold lease response; refused" >&2; return 1 ;;
    esac
  done
  [ "$line" = PAPERCUSP_HOLD_READY ] && [ -n "$held" ] || {
    echo 'backup retention: legal holds unreadable; destructive operation refused' >&2
    return 1
  }
  "$callback" "$held" "$@"
)

kopia_retention_expire_if_unheld() {
  local held="$1" sudo_bin="$2" kopia_bin="$3"
  if [ "$held" = t ]; then
    echo 'backup retention: active legal hold; safety pins retained' >&2
    return 0
  fi
  kopia_retention_pin_all "$sudo_bin" "$kopia_bin" remove || return
  kopia_as_root "$sudo_bin" "$kopia_bin" snapshot expire --all --delete
}

kopia_retention_finish() {
  kopia_with_hold_lease "${KOPIA_HOLD_DATABASE:-papercusp}" kopia_retention_expire_if_unheld "$@"
}

# The directory producer must preserve its old dump even if it has never made
# it into Kopia. Move it into the same snapshotted tree under a hold; release
# permits ordinary rotation of these archives on the next successful dump.
kopia_install_dump_if_held() {
  local held="$1" out="$2" archive="$2.legal-hold" saved
  if [ "$held" = t ] && [ -e "$out" ]; then
    mkdir -p -- "$archive" || return
    saved=$(mktemp -d "$archive/held.XXXXXXXX") || return
    mv -- "$out" "$saved/dump" || return
  elif [ "$held" = f ]; then
    rm -rf -- "$archive" "$out" || return
  fi
  mv -f -- "$out.tmp" "$out"
}

# ── STOP KOPIA WITHOUT DISCARDING WHAT IT FINISHED (EI-25211496463956189) ─────
# This lives here because it is the one helper every Kopia entrypoint already
# sources and that is already linked into ~/.config/kopia; a new file would add
# an install step whose absence stops backups outright.
#
# Kopia commits a finished source's snapshot only when it FLUSHES: when the
# process exits, or at a 45-minute checkpoint. On SIGTERM it saves the source in
# progress as a partial snapshot, flushes everything, and exits 0. SIGKILL
# discards every snapshot since the last flush. Measured 2026-10-06 on a
# throwaway repo (two sources, signal sent 2s after the first finished): SIGTERM
# gave rc 0 after 5.7s with the first source committed; a second SIGTERM 0.3s
# later changed nothing; SIGKILL gave rc 137 after 27ms and `snapshot list` was
# EMPTY. The cleanups used to SIGKILL at once, so every stopped hot sweep threw
# away the sources it had finished: the 14:52 EDT sweep that day lost its
# /mnt/backup/db-dumps snapshot (Kopia had printed "Created snapshot" for it).
#
# kopia_stop_flushing PID GRACE_SEC — SIGTERM the exact Kopia PID, wait up to
# GRACE_SEC for it to exit, then SIGKILL. The caller must have validated PID with
# its kopia_pid_matches, and must define SUDO_BIN, KILL_BIN and PROC_ROOT.
# Returns 0 when Kopia exited after SIGTERM (its snapshots are flushed), 2 when
# it had to be SIGKILLed, and 1 when even SIGKILL failed. Prints nothing; the
# caller logs. GRACE_SEC must stay below the guard's KOPIA_BACKUP_STOP_GRACE_SEC
# (default 20), which SIGKILLs the calling script if its cleanup outlives that.
#
# Privileged calls are bounded by KOPIA_SUDO_SIGNAL_TIMEOUT_SEC (default 45), not 1 s.
# Measured 2026-10-14 (WI-6554700010011924): under memory+IO pressure a single sudo
# spent >=37 s before it even logged its command (journald itself was current), and
# in-sudo gaps of ~11 s recurred. A 1 s bound timed out BOTH the SIGTERM and the
# SIGKILL, so the stop-post cleanup delivered no signal and the root Kopia leaked.
# Worst case per cleanup is 3 bounded calls + GRACE_SEC, so each unit's
# TimeoutStopSec must exceed 3 x this bound + its grace.
kopia_sudo_signal_timeout() {
  local bound="${KOPIA_SUDO_SIGNAL_TIMEOUT_SEC:-45}"
  [[ "$bound" =~ ^[0-9]+$ ]] && [ "$bound" -ge 1 ] || bound=45
  printf '%s' "$bound"
}

# kopia_proc_stat_field PID INDEX — a field of /proc/<pid>/stat, counted from the
# first field AFTER the parenthesised comm (1 = state, 20 = starttime). stat is
# world-readable even for a root process, so identity needs no sudo.
kopia_proc_stat_field() {
  local stat="" idx="$2"
  local -a fields=()
  [[ "$idx" =~ ^[0-9]+$ ]] && [ "$idx" -ge 1 ] || return 1
  IFS= read -r stat 2>/dev/null <"$PROC_ROOT/$1/stat" || [ -n "$stat" ] || return 1
  [[ "$stat" == *") "* ]] || return 1
  read -r -a fields <<<"${stat##*) }"
  [ -n "${fields[$((idx - 1))]:-}" ] || return 1
  printf '%s' "${fields[$((idx - 1))]}"
}

# kopia_exact_snapshot_pid PID — true only for a live `"$KOPIA_BIN" snapshot create`
# process. The caller defines PROC_ROOT, KOPIA_BIN and SUDO_BIN. The world-readable
# cmdline is checked FIRST, so a non-Kopia cgroup member (the cleanup's own helper
# processes, the root sudo wrapper) costs no sudo at all. Only a process whose argv
# already IS a Kopia snapshot reaches the exe check, and sudo resolves the link only
# when the unprivileged readlink did not (a root-owned exe link is unreadable here,
# WI-10002636). That call is bounded like the signals.
kopia_exact_snapshot_pid() {
  local pid="$1" exe="" cmdline=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  cmdline="$(tr '\0' ' ' <"$PROC_ROOT/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == "$KOPIA_BIN snapshot create "* ]] || return 1
  exe="$(readlink -f "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  if [ "$exe" != "$KOPIA_BIN" ]; then
    exe="$(/usr/bin/timeout --kill-after=1s "$(kopia_sudo_signal_timeout)s" \
      "$SUDO_BIN" -n -- readlink -f -- "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  fi
  [ "$exe" = "$KOPIA_BIN" ]
}

kopia_stop_flushing() {
  local pid="$1" grace="${2:-15}" deadline=0 bound="" start0="" start1="" state=""
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=15
  bound="$(kopia_sudo_signal_timeout)"
  # Identity of the process validated by the caller: same PID + same starttime is the
  # same process, even after a PID wrap. Empty when stat is unreadable (fixtures).
  start0="$(kopia_proc_stat_field "$pid" 20 2>/dev/null || true)"
  /usr/bin/timeout --kill-after=1s "${bound}s" "$SUDO_BIN" -n -- "$KILL_BIN" -TERM "$pid" >/dev/null 2>&1 || true
  # Bound the grace by WALL-CLOCK time, never by a count of `sleep 0.2` ticks. Each
  # tick forks a sleep, and at host load ~280 every fork overran, so a "15 s" grace
  # outlived kopia-home-snapshot's 30 s TimeoutStopSec. systemd then killed the
  # cleanup mid-wait and the root Kopia leaked ('stop-post' timed out, 2026-10-13
  # 23:43 EDT, WI-6554700010011790).
  deadline=$((SECONDS + grace))
  while [ -d "$PROC_ROOT/$pid" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.2
  done
  [ -d "$PROC_ROOT/$pid" ] || return 0
  if [ -n "$start0" ]; then
    # No sudo here: a changed starttime is a recycled PID, and a zombie (state Z)
    # has already exited. Either way there is nothing of ours left to kill.
    start1="$(kopia_proc_stat_field "$pid" 20 2>/dev/null || true)"
    [ "$start1" = "$start0" ] || return 0
    state="$(kopia_proc_stat_field "$pid" 1 2>/dev/null || true)"
    [ "$state" != Z ] || return 0
  else
    # stat unreadable: fall back to the full exe+argv match. A zombie keeps its
    # /proc dir but no readable exe, so it fails the match: gone.
    kopia_pid_matches "$pid" || return 0
  fi
  /usr/bin/timeout --kill-after=1s "${bound}s" "$SUDO_BIN" -n -- "$KILL_BIN" -KILL "$pid" >/dev/null 2>&1 || return 1
  return 2
}
