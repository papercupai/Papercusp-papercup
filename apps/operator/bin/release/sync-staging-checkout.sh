#!/usr/bin/env bash
# sync-staging-checkout.sh — isolated-staging-tier-2026-06-21 (su, session e24ec9b4).
#
# Auto-advances the ISOLATED staging checkout to the latest COMMITTED `staging`
# HEAD by preparing a unique immutable generation, building it completely, then
# atomically publishing it through a stable sibling alias. The live :3170
# process keeps its physical source root for its entire lifetime.
#
# Reuses the release system's standalone setup-release-checkout.sh (worktree +
# git-archive submodules + hardlinked node_modules + SPA build) — no parallel
# checkout machinery. Driven by papercup-staging-sync.timer (systemd --user).
#
# Fail-safe by construction:
#   - HEAD-moved gate: no move → no rebuild, no restart (cheap no-op).
#   - relevance gate (WI-5710): the branch moving is NOT the same thing as the
#     RUNNING process's code changing — skip the restart when every changed
#     path is provably not server code.
#   - live-session deferral (WI-5710): don't cut a live :3170 session's legs
#     out from under it just because the timer ticked; wait for it to go idle,
#     bounded by a staleness ceiling.
#   - flock: never overlaps itself or a manual run.
#   - setup-release-checkout.sh aborts NON-ZERO (workspace-resolution gate /
#     SPA-build failure) BEFORE any restart, so a bad staging commit can never
#     cut :3170 over to a tree that would crash-loop — the previous good
#     checkout keeps serving.
#   - post-restart source readiness is verified with a bounded wall-clock
#     budget, long enough for request-only startup migrations but never an
#     unbounded wait.
#
# Reverse the whole tier: stop+disable papercup-staging-sync.timer, delete the
# 50-staging-checkout.conf drop-in, daemon-reload, restart papercusp-staging-api.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sync-staging-checkout.sh

Advance the isolated staging checkout to the committed staging HEAD and,
when needed, request a coordinated :3170 restart.

Options:
  -h, --help  Show this help and exit without inspecting or mutating staging.
  --cleanup-only  Run bounded retired-generation cleanup without preparing or restarting staging.

Configuration is supplied through the PAPERCUSP_* environment variables used
by the staging sync timer; this command accepts no positional arguments.

PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC controls the bounded health
readiness wait after a coordinated restart (default: 300 seconds).
USAGE
}

# Parse arguments before any repository, service, network, or lock inspection.
# This script is also used for usage discovery, so --help must be a genuinely
# side-effect-free operation rather than an argument that falls through into
# the live sync workflow.
STAGING_SYNC_CLEANUP_ONLY=0
if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      if [ "$#" -ne 1 ]; then
        printf 'sync-staging-checkout.sh: --help does not accept additional arguments\n' >&2
        usage >&2
        exit 2
      fi
      usage
      exit 0
      ;;
    --cleanup-only)
      if [ "$#" -ne 1 ]; then
        printf 'sync-staging-checkout.sh: --cleanup-only does not accept additional arguments\n' >&2
        usage >&2
        exit 2
      fi
      STAGING_SYNC_CLEANUP_ONLY=1
      ;;
    *)
      printf 'sync-staging-checkout.sh: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

# Default to the checkout this script actually lives in — never one box's path
# (WI-4419: a hardcoded /home/<user>/… default is wrong on every other machine
# AND ships the owner's identity inside the release source drop).
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_DEFAULT="$(git -C "$_HERE" rev-parse --show-toplevel 2>/dev/null || (cd "$_HERE/../../../.." && pwd))"
INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-$_REPO_DEFAULT}"
LEGACY_STAGING_ROOT="${PAPERCUSP_STAGING_ROOT:-$(dirname "$INTEGRATION_ROOT")/papercusp-staging}"
STAGING_ROOT="${LEGACY_STAGING_ROOT}.current"
STAGING_GENERATIONS_ROOT="${LEGACY_STAGING_ROOT}.generations"
# Measured on-disk size of the last published generation (WI-6554700010029252).
STAGING_GENERATION_BYTES_FILE="${STAGING_GENERATION_BYTES_FILE:-$STAGING_GENERATIONS_ROOT/.generation-bytes}"
UNIT="${PAPERCUSP_STAGING_UNIT:-papercusp-staging-api.service}"
HEALTH_URL="${PAPERCUSP_STAGING_HEALTH_URL:-http://127.0.0.1:3170/api/health}"
BRANCH="${PAPERCUSP_INTEGRATION_BRANCH:-staging}"
STAGING_BUNDLE_SCRIPT="${PAPERCUSP_STAGING_BUNDLE_SCRIPT:-$STAGING_ROOT/apps/operator/bin/bundle-host.sh}"
STAGING_CANDIDATE_HOME=""
STAGING_CANDIDATE_ROOT=""
STAGING_CANDIDATE_PUBLISHED=0

# WI-5710. The port we watch for live client connections — derived from
# HEALTH_URL so the two can never disagree, overridable for tests.
STAGING_PORT="${PAPERCUSP_STAGING_PORT:-$(printf '%s' "$HEALTH_URL" | sed -n 's#.*://[^:/]*:\([0-9]\{1,\}\).*#\1#p')}"
[ -n "$STAGING_PORT" ] || STAGING_PORT=3170
# How stale the code :3170 serves may get while we wait for a live session to
# finish. Past this, the restart lands even with clients attached — a deferral
# is a courtesy, never an indefinite freeze.
MAX_STALE_SEC="${PAPERCUSP_STAGING_SYNC_MAX_STALE_SEC:-1800}"

log() { echo "[staging-sync] $(date -Is) $*"; }

# Milestones are diagnostics only. Each preparation command has its own finite
# GNU timeout, which survives systemd manager reloads without deadline extensions.
staging_sync_checkpoint() {
  [[ -n "${NOTIFY_SOCKET:-}" ]] || return 0
  systemd-notify --status="staging-sync: $1"
}

finish_staging_sync() {
  local status=$?
  trap - EXIT
  cleanup_staging_candidate || true
  staging_sync_lock_release || true
  # A timer invocation may already have started under the previous notify unit
  # when its drop-in is reloaded. Complete that inherited contract as well.
  if [[ "$status" -eq 0 && -n "${NOTIFY_SOCKET:-}" ]]; then
    systemd-notify --ready --status="staging-sync complete" || status=$?
  fi
  exit "$status"
}

# Lock diagnostics are fail-open. The helper writes bounded records to stderr
# (captured by journald); a missing helper must not change sync admission.
STAGING_LOCK_ATTRIBUTION_HELPER="$INTEGRATION_ROOT/apps/operator/scripts/systemd/staging-lock-attribution.sh"
if [[ -r "$STAGING_LOCK_ATTRIBUTION_HELPER" ]]; then
  . "$STAGING_LOCK_ATTRIBUTION_HELPER" || log "lock-attribution helper could not be loaded; recording unknown holder evidence"
else
  log "lock-attribution helper is unavailable; recording unknown holder evidence"
fi
if ! declare -F staging_lock_log >/dev/null 2>&1; then
  staging_lock_log() { log "lock-attribution-unavailable $*"; }
  staging_lock_attempt_id() { printf '%s' "${INVOCATION_ID:-unavailable}"; }
  staging_lock_now_ms() { printf '%s' unknown; }
  staging_lock_elapsed_ms() { printf '%s' unknown; }
  staging_lock_holder_fields() { printf '%s' 'holder_pid=unknown holder_comm=unknown'; }
fi

# Keep the checkout flock in a dedicated coprocess. A shell fd opened with
# `exec 9>...` is inherited by every child, so an unrelated child can keep the
# staging barrier alive after this script exits (the android-ci failure mode).
# The keeper owns the writer lease on fd 8 and generation barrier on fd 9,
# receiving mode changes over a pipe. No workflow child inherits either fd.
# Bash owns STAGING_SYNC_LOCK_KEEPER_PID and unsets it when the coprocess exits.
# Keep our cleanup receipt separately so cleanup is safe even after reaping.
STAGING_SYNC_LOCK_PROCESS_PID=""
STAGING_SYNC_LOCK_READ_FD=""
STAGING_SYNC_LOCK_WRITE_FD=""
STAGING_SYNC_LOCK_OWNER_PID="$$"

staging_sync_lock_next_command() {
  local command_line="" command_chunk="" read_status
  while kill -0 "$STAGING_SYNC_LOCK_OWNER_PID" 2>/dev/null; do
    command_chunk=""
    if IFS= read -r -t 1 command_chunk; then read_status=0; else read_status=$?; fi
    # read -t consumes partial input even when it times out. Preserve it until
    # the newline arrives rather than silently discarding a lock command.
    command_line+="$command_chunk"
    ((${#command_line} <= 128)) || return 2
    if ((read_status == 0)); then
      IFS=' ' read -r staging_lock_command staging_lock_budget <<< "$command_line"
      return 0
    fi
    # Timeouts allow a liveness check; EOF must end the keeper.
    ((read_status > 128)) || return 1
  done
  return 1
}

staging_sync_lock_start() {
  coproc STAGING_SYNC_LOCK_KEEPER {
    exec 8>"${STAGING_SYNC_LOCK_PATH}.writer"
    exec 9>"$STAGING_SYNC_LOCK_PATH"
    if ! flock -n 8 || ! flock -n 9; then
      printf '%s\n' busy
      # Keep the coprocess alive until the parent acknowledges the result.
      # Bash removes the generated named-coproc PID variables as soon as a
      # short-lived coprocess exits; that made the parent cleanup path expand
      # STAGING_SYNC_LOCK_KEEPER_PID under nounset and abort on a benign busy
      # lock before it could release its pipe/fd state.
      staging_lock_command=""
      while staging_sync_lock_next_command; do
        [[ "$staging_lock_command" == release ]] && break
      done
      exit 75
    fi
    printf '%s\n' exclusive
    staging_lock_command=""
    while staging_sync_lock_next_command; do
        case "$staging_lock_command" in
          shared)
            if flock -s 9; then printf '%s\n' shared; else printf '%s\n' shared-failed; exit 1; fi
            ;;
          exclusive)
            # flock conversions can drop the shared lock while waiting. The
            # separate writer lease remains held throughout this transition.
            if flock -x -w "$staging_lock_budget" -E 75 9; then
              printf '%s\n' exclusive
            else
              printf 'exclusive-failed:%s\n' "$?"
            fi
            ;;
          release)
            flock -u 9
            flock -u 8
            printf '%s\n' released
            exit 0
            ;;
          *) printf '%s\n' invalid-command; exit 2 ;;
        esac
    done
    flock -u 9
    flock -u 8
  }
  STAGING_SYNC_LOCK_PROCESS_PID="${STAGING_SYNC_LOCK_KEEPER_PID:-}"
  STAGING_SYNC_LOCK_READ_FD="${STAGING_SYNC_LOCK_KEEPER[0]:-}"
  STAGING_SYNC_LOCK_WRITE_FD="${STAGING_SYNC_LOCK_KEEPER[1]:-}"
  [[ -n "$STAGING_SYNC_LOCK_PROCESS_PID" && -n "$STAGING_SYNC_LOCK_READ_FD" && -n "$STAGING_SYNC_LOCK_WRITE_FD" ]] || return 1
  staging_lock_state=""
  if ! IFS= read -r -t 5 staging_lock_state <&"$STAGING_SYNC_LOCK_READ_FD"; then
    printf '%s\n' 'staging lock: initial acknowledgement unavailable; refusing admission' >&2
    return 1
  fi
  if [[ "$staging_lock_state" == busy ]]; then
    return 75
  fi
  [[ "$staging_lock_state" == exclusive ]] || return 1
}

staging_sync_lock_shared() {
  printf '%s\n' shared >&"$STAGING_SYNC_LOCK_WRITE_FD" || return 1
  staging_lock_state=""
  # The keeper is a separate process: liveness alone cannot guarantee a reply.
  # Fail closed so the EXIT trap releases this invocation's leases and a later
  # tick can retry; a missing acknowledgement must never freeze staging forever.
  if ! IFS= read -r -t 5 staging_lock_state <&"$STAGING_SYNC_LOCK_READ_FD"; then
    printf '%s\n' 'staging lock: shared acknowledgement unavailable; refusing preparation' >&2
    return 1
  fi
  [[ "$staging_lock_state" == shared ]]
}

staging_sync_lock_exclusive() {
  local budget="${1:-45}" state
  [[ "$budget" =~ ^[1-9][0-9]{0,2}$ ]] && ((budget <= 300)) || return 2
  printf 'exclusive %s\n' "$budget" >&"$STAGING_SYNC_LOCK_WRITE_FD" || return 1
  if ! IFS= read -r -t "$((budget + 5))" state <&"$STAGING_SYNC_LOCK_READ_FD"; then
    printf '%s\n' 'staging lock: exclusive acknowledgement unavailable; refusing publication' >&2
    return 1
  fi
  case "$state" in
    exclusive) return 0 ;;
    exclusive-failed:*) return "${state#exclusive-failed:}" ;;
    *) return 1 ;;
  esac
}

staging_sync_lock_release() {
  local keeper_pid="$STAGING_SYNC_LOCK_PROCESS_PID" acknowledgement=""
  [[ -n "$keeper_pid" ]] || return 0
  STAGING_SYNC_LOCK_PROCESS_PID=""
  # An already-exited keeper can leave a closed pipe. Keep the write in this
  # shell: Bash's coprocess descriptors are not reliably inherited by a
  # subshell, and a subshell here would silently lose the release handshake.
  printf '%s\n' release 2>/dev/null >&"$STAGING_SYNC_LOCK_WRITE_FD" || true
  # Cleanup must not wait forever for a keeper that cannot receive or process
  # its release command. It owns only this invocation's lock descriptors; once
  # release is requested, terminating it safely releases both leases.
  if ! IFS= read -r -t 2 acknowledgement <&"$STAGING_SYNC_LOCK_READ_FD" 2>/dev/null ||
     [[ "$acknowledgement" != released ]]; then
    kill -KILL "$keeper_pid" 2>/dev/null || true
  fi
  wait "$keeper_pid" 2>/dev/null || true
}

staging_alias_bootstrap() {
  local tmp
  mkdir -p "$(dirname "$STAGING_ROOT")" "$STAGING_GENERATIONS_ROOT" || return 1
  if [[ -L "$STAGING_ROOT" ]]; then
    if [[ ! -d "$STAGING_ROOT" ]]; then
      log "FATAL: stable staging alias is broken: $STAGING_ROOT"
      return 1
    fi
    return 0
  fi
  if [[ -e "$STAGING_ROOT" ]]; then
    log "FATAL: stable staging alias path exists as a non-symlink; refusing to replace it: $STAGING_ROOT"
    return 1
  fi
  if [[ -d "$LEGACY_STAGING_ROOT" ]]; then
    tmp="${STAGING_ROOT}.bootstrap.$$"
    ln -s "$LEGACY_STAGING_ROOT" "$tmp" || return 1
    if ! mv -T -- "$tmp" "$STAGING_ROOT"; then
      rm -f -- "$tmp"
      return 1
    fi
    log "bootstrapped stable staging alias to the existing serving checkout"
  fi
}

# Retired generations are reclaimed asynchronously (launch_staging_trash_drain),
# but candidate preparation can allocate gigabytes before that drain finishes.
# Reuse the writers' reserve so a cleanup backlog cannot keep growing while
# shared PostgreSQL and Git already refuse new writes.
staging_preparation_has_headroom() {
  (
    cd "$INTEGRATION_ROOT" || exit 1
    timeout --kill-after=2s 10s node --experimental-strip-types --input-type=module - "$STAGING_GENERATIONS_ROOT" "${STAGING_GENERATION_BYTES_FILE:-}" <<'NODE'
import { readFileSync, statfsSync } from 'node:fs';
import { criticalWriteHeadroomBytes, diskPolicyFromEnv } from './packages/operator-core/lib/storage/disk-space-policy.ts';
const snapshot = statfsSync(process.argv[2]);
const total = Number(snapshot.blocks) * Number(snapshot.bsize);
const available = Number(snapshot.bavail) * Number(snapshot.bsize);
if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(available) || available < 0 || available > total) {
  throw new Error('staging source preparation: filesystem capacity is unmeasured');
  }
const reserve = criticalWriteHeadroomBytes(total, diskPolicyFromEnv());
// WI-6554700010029252: preparing a candidate writes about one more generation, so
// the reserve must still hold AFTER it lands. With no usable measurement yet the
// check is the writer reserve alone. (Closing braces stay indented: tests
// extract this function with a sed range that ends at the first column-0 `}`.)
let generationBytes = 0;
try {
  const raw = readFileSync(process.argv[3], 'utf8').trim();
  if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(Number(raw))) generationBytes = Number(raw);
  } catch {}
const required = reserve + generationBytes;
if (available < required) {
  console.error(`staging source preparation deferred: ${available} available bytes below ${required} required (${reserve} writer reserve + ${generationBytes} measured generation size) on ${process.argv[2]}; retaining the serving generation while cleanup continues`);
  process.exitCode = 75;
  }
NODE
  )
}

create_staging_candidate() {
  local expected_sha="$1"
  mkdir -p "$STAGING_GENERATIONS_ROOT" || return 1
  STAGING_CANDIDATE_HOME="$(mktemp -d "$STAGING_GENERATIONS_ROOT/.candidate-${expected_sha:0:12}.XXXXXX")" || return 1
  STAGING_CANDIDATE_ROOT="$STAGING_CANDIDATE_HOME/checkout"
}

# Prints the first unmet publication condition; prints nothing when the
# candidate is complete. EI-24867768475421999: the refusal used to name no
# condition, and the EXIT trap deletes the candidate, so a refused run destroyed
# the only evidence of which check failed. The reason now lands in the journal.
staging_candidate_unready_reason() {
  local candidate_root="$1" candidate_home="$2" expected_sha="$3" require_host_bundle="${4:-1}"
  local ready_sha dist_host="$candidate_root/apps/operator/dist-host"
  ready_sha="$(cat "$candidate_home/.ready" 2>/dev/null || true)"
  if [[ "$ready_sha" != "$expected_sha" ]]; then
    printf '%s/.ready holds %s, expected %s\n' "$candidate_home" "${ready_sha:-<missing>}" "$expected_sha"
  elif [[ ! -s "$candidate_root/apps/operator-vite/dist/index.html" ]]; then
    printf 'SPA dist missing or empty: apps/operator-vite/dist/index.html\n'
  elif [[ "$require_host_bundle" != 1 ]]; then
    return 0
  elif [[ ! -s "$dist_host/hono-host.mjs" ]]; then
    printf 'host bundle missing or empty: apps/operator/dist-host/hono-host.mjs\n'
  elif [[ ! -s "$dist_host/.bundle-fresh.json" ]]; then
    printf 'host bundle freshness proof missing: apps/operator/dist-host/.bundle-fresh.json (the bundle-host.sh stamp step failed; its [bundle-freshness] line above names the cause)\n'
  elif [[ -e "$dist_host/.bundle-stale.json" ]]; then
    printf 'host bundle is marked stale: apps/operator/dist-host/.bundle-stale.json exists\n'
  fi
}

publish_staging_generation() {
  local candidate_root="$1" candidate_home="$2" expected_sha="$3" require_host_bundle="${4:-1}"
  local tmp="${STAGING_ROOT}.publish.$$" unready
  unready="$(staging_candidate_unready_reason "$candidate_root" "$candidate_home" "$expected_sha" "$require_host_bundle")"
  if [[ -n "$unready" ]]; then
    log "FATAL: refusing to publish an incomplete staging generation: $unready"
    return 1
  fi
  if [[ -e "$STAGING_ROOT" && ! -L "$STAGING_ROOT" ]]; then
    log "FATAL: stable staging alias became a non-symlink; refusing publication"
    return 1
  fi
  if [[ -e "$tmp" || -L "$tmp" ]]; then
    log "FATAL: staging publication temp path already exists: $tmp"
    return 1
  fi
  ln -s "$candidate_root" "$tmp" || return 1
  if ! mv -Tf -- "$tmp" "$STAGING_ROOT"; then
    rm -f -- "$tmp"
    return 1
  fi
  STAGING_CANDIDATE_PUBLISHED=1
  log "published staging generation $candidate_root through stable alias $STAGING_ROOT"
}

# WI-10005311: one pass over /proc for the whole host, not one per candidate.
# The old check forked tr|grep|readlink for every process, once per candidate:
# with ~7,000 processes and 13 candidates a single prune took minutes. Here one
# grep reads every environ and one find reads every cwd, about 0.5s in total.
# Keep pid/source/path records from the same batched scan for retention evidence
# (WI5508). STAGING_GENERATION_REFS remains the path-only pruning safety input.
# Unreadable or vanished processes are skipped, as before.
collect_staging_generation_refs() {
  STAGING_GENERATION_PROCESS_REFS="$(
    {
      grep -sazHo '^PAPERCUSP_INTEGRATION_ROOT=.*' /proc/[0-9]*/environ 2>/dev/null |
        tr '\0' '\n' | sed -n 's#^/proc/\([0-9]*\)/environ:PAPERCUSP_INTEGRATION_ROOT=#\1\tintegration-root\t#p' || true
      find /proc/[0-9]* -maxdepth 1 -name cwd -printf '%p\t%l\n' 2>/dev/null |
        sed -n 's#^/proc/\([0-9]*\)/cwd\t#\1\tcwd\t#p' || true
      # WI-6554700010029679: an argv element naming a path INSIDE a generation
      # pins it too. release:cut runs `bash -c 'source "$1" …' <root>/bin/
      # release-local.sh <generation>/…/bin/release-local.sh …` with its cwd in
      # the release root and no PAPERCUSP_INTEGRATION_ROOT, yet the orchestrator
      # keeps opening files from that generation until the cut's final step.
      # Anchored on the generations-root prefix (the same literal prefix every
      # pruned candidate sits under), so the batched scan stays one grep.
      if [[ -n "${STAGING_GENERATIONS_ROOT:-}" ]]; then
        grep -sazHo -- "^$(printf '%s' "$STAGING_GENERATIONS_ROOT" | sed 's/[][\\.*^$]/\\&/g')/.*" /proc/[0-9]*/cmdline 2>/dev/null |
          tr '\0' '\n' | sed -n 's#^/proc/\([0-9]*\)/cmdline:#\1\targv\t#p' || true
      fi
    } | sort -u || true
  )"
  STAGING_GENERATION_REFS="$(printf '%s\n' "$STAGING_GENERATION_PROCESS_REFS" | cut -f3- | sort -u)"
}

staging_generation_in_use() {
  local root="$1" ref
  while IFS= read -r ref; do
    if [[ -n "$ref" && ( "$ref" == "$root" || "$ref" == "$root/"* ) ]]; then
      return 0
    fi
  done <<< "${STAGING_GENERATION_REFS:-}"
  return 1
}

# Diagnostics never authorize deletion or process termination. Read metadata for
# at most five distinct holders per retained generation, never another host-wide
# scan. Parent state follows the existing sidecar-orphan-probe/reaper contract:
# a missing declared PID, or one started after its child, cannot be its parent.
# The optional proc root is only a parser/race test seam.
staging_generation_holder_evidence() {
  local root="$1" proc_root="${2:-/proc}" pid source ref entry stat_line rest comm
  local parent parent_state ppid child_start parent_start shown=0 total=0
  local -a fields
  local -A seen=()
  while IFS=$'\t' read -r pid source ref; do
    [[ "$pid" =~ ^[0-9]+$ && -n "$ref" && ( "$ref" == "$root" || "$ref" == "$root/"* ) ]] || continue
    [[ -z "${seen[$pid]:-}" ]] || continue
    seen[$pid]=1
    total=$((total + 1))
    [[ "$shown" -lt 5 ]] || continue
    shown=$((shown + 1))
    parent=unknown parent_state=unknown ppid=unknown comm=unknown child_start=unknown
    stat_line="$(cat "$proc_root/$pid/stat" 2>/dev/null || true)"
    if [[ "$stat_line" == *') '* ]]; then
      rest="${stat_line##*) }"
      read -r -a fields <<< "$rest"
      ppid="${fields[1]:-unknown}"
      child_start="${fields[19]:-unknown}"
      comm="${stat_line#*(}"
      comm="${comm%)*}"
      comm="${comm//[^[:alnum:]_.-]/_}"
      comm="${comm:0:64}"
    fi
    if [[ -r "$proc_root/$pid/environ" ]]; then
      parent=undeclared parent_state=undeclared
      while IFS= read -r -d '' entry; do
        if [[ "$entry" == PAPERCUSP_DESKTOP_PARENT_PID=* ]]; then
          parent="${entry#*=}"
          parent_state=unknown
          break
        fi
      done < "$proc_root/$pid/environ" 2>/dev/null || true
      if [[ "$parent" =~ ^[1-9][0-9]*$ ]]; then
        if [[ -d "$proc_root/$parent" ]]; then
          parent_state=live
          stat_line="$(cat "$proc_root/$parent/stat" 2>/dev/null || true)"
          rest="${stat_line##*) }"
          read -r -a fields <<< "$rest"
          parent_start="${fields[19]:-unknown}"
          if [[ "$child_start" =~ ^[0-9]+$ && "$parent_start" =~ ^[0-9]+$ ]] &&
             ((parent_start > child_start)); then
            parent_state=recycled
          fi
        else
          parent_state=missing
        fi
      elif [[ "$parent" != undeclared ]]; then
        parent=unknown
      fi
    fi
    log "staging-generation-holder generation=$root holder_pid=$pid holder_ppid=$ppid holder_comm=$comm reference=$source declared_parent_pid=$parent declared_parent_state=$parent_state"
    if [[ "$parent_state" == missing || "$parent_state" == recycled ]]; then
      log "ALARM: staging generation pinned by sidecar without its declared parent generation=$root holder_pid=$pid declared_parent_pid=$parent declared_parent_state=$parent_state action=inspect-sidecar-parent-watch retained=true"
    fi
  done <<< "${STAGING_GENERATION_PROCESS_REFS:-}"
  log "staging-generation-retention generation=$root holders=$total shown=$shown omitted=$((total - shown)) action=inspect-holders-before-reclaim retained=true"
  return 0
}

# WI-6554700010029246: a retired generation is a ~25 GiB node_modules-heavy
# tree. Deleting it INSIDE this tick's exclusive lock under a 15s budget
# reclaimed only a sliver per tick while 2-3 generations/hour were published,
# so idle trees piled up (~300 GiB on /, 2026-10-23..26) until every writer's
# disk reserve refused: the green-checkpoint gate recorded 150 consecutive
# no-verdict runs and git-sync publication was refused. Retirement under the
# lock is therefore O(1) — a same-filesystem rename of the whole generation
# home to a .trash-* sibling — and byte reclamation runs OUTSIDE the lock in
# launch_staging_trash_drain with no small budget.
retire_staging_generation_home() {
  local home="$1" root="${2:-${STAGING_GENERATIONS_ROOT:-}}" name trash
  name="$(basename "$home")"
  [[ -n "$root" && "$(dirname "$home")" == "$root" && "$name" == .candidate-* && -d "$home" ]] || return 1
  trash="$root/.trash-${name#.}.$(date +%s)"
  if ! mv -T -- "$home" "$trash"; then
    log "ALARM: could not retire staging generation to trash (rename failed); retaining it for next tick: $home"
    return 1
  fi
  rm -f -- "${home}.prune-pending"
  STAGING_GENERATIONS_RETIRED=$((${STAGING_GENERATIONS_RETIRED:-0} + 1))
  return 0
}

# Renaming a worktree directory leaves its registration in the integration
# repository's .git/worktrees; `git worktree prune` drops exactly the entries
# whose directory is gone (locked/initializing worktrees are skipped by Git).
prune_staging_worktree_registrations() {
  local budget="${1:-15}"
  [[ "${STAGING_GENERATIONS_RETIRED:-0}" -gt 0 ]] || return 0
  if ! command -v timeout >/dev/null 2>&1; then
    log "ALARM: timeout is unavailable; leaving stale staging worktree registrations for next tick"
    return 0
  fi
  local status
  if timeout --signal=KILL "${budget}s" git -C "$INTEGRATION_ROOT" worktree prune >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  if ((status == 124 || status == 137)); then
    log "staging generation cleanup budget exhausted after ${budget}s in git worktree prune; stale registrations are retried next tick"
  else
    log "git worktree prune failed (status=$status); stale staging registrations are retried next tick"
  fi
  return 0
}

# Reclaim .trash-* bytes in a transient systemd unit so the deletion outlives
# this tick: the sync service's cgroup is torn down when the tick exits, which
# would kill an ordinary background child. The unit name is keyed by the
# generations root so a test fixture can never collide with (or wait behind)
# the production drain, and an already-active drain is left to finish — its
# successor picks up whatever it did not cover on the next tick. Deliberately
# NOT idle-class IO: under fleet load the idle class starves almost completely.
launch_staging_trash_drain() {
  local root="${1:-${STAGING_GENERATIONS_ROOT:-}}" entry unit rm_bin status
  local -a trash=()
  [[ -n "$root" && -d "$root" ]] || return 0
  while IFS= read -r -d '' entry; do
    trash+=("$entry")
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name '.trash-*' -print0 2>/dev/null)
  ((${#trash[@]} > 0)) || return 0
  if [[ "${STAGING_TRASH_DRAIN_MODE:-detached}" == inline ]]; then
    if rm -rf -- "${trash[@]}"; then
      log "reclaimed ${#trash[@]} retired staging generation tree(s) inline"
    else
      status=$?
      log "ALARM: inline reclamation of retired staging generations failed (status=$status); retrying next tick"
    fi
    return 0
  fi
  rm_bin="$(command -v rm)"
  unit="papercup-staging-trash-drain-$(printf '%s' "$root" | sha256sum | cut -c1-12)"
  if command -v systemd-run >/dev/null 2>&1; then
    if systemctl --user is-active --quiet "$unit.service" 2>/dev/null; then
      log "retired staging generation drain already running unit=$unit; ${#trash[@]} trash tree(s) are covered by it or the next tick"
      return 0
    fi
    if systemd-run --user --quiet --collect --unit="$unit" \
        --description="Reclaim retired papercusp staging generations (WI-6554700010029246)" \
        --nice=10 -p IOSchedulingClass=best-effort -p IOSchedulingPriority=7 \
        -- "$rm_bin" -rf -- "${trash[@]}" >/dev/null 2>&1; then
      log "launched detached retired staging generation drain unit=$unit trees=${#trash[@]}"
      return 0
    fi
    log "systemd-run could not launch $unit; falling back to a detached session (may be cut short when this tick exits; the next tick relaunches it)"
  fi
  setsid nice -n 10 "$rm_bin" -rf -- "${trash[@]}" </dev/null >/dev/null 2>&1 &
  log "launched detached retired staging generation drain pid=$! trees=${#trash[@]}"
  return 0
}

# WI-6554700010029252: record a published generation's real on-disk size for
# staging_preparation_has_headroom. A df delta across preparation is unusable
# because the detached trash drain frees space at the same time, so this walks
# the tree. That walk took over a minute under gate load, so it runs detached,
# like the drain, never inside the tick. A failed or partial walk writes nothing
# and leaves the previous measurement in place.
STAGING_GENERATION_MEASURE_SCRIPT='set -o pipefail
bytes="$(du -sxB1 -- "$1" | awk "NR==1 {print \$1}")" || exit 1
[[ "$bytes" =~ ^[0-9]+$ ]] && ((bytes > 0)) || exit 1
printf "%s\n" "$bytes" > "$2.tmp.$$" && mv -f -- "$2.tmp.$$" "$2" || { rm -f -- "$2.tmp.$$"; exit 1; }'

launch_staging_generation_measure() {
  local home="$1" file="${2:-$STAGING_GENERATION_BYTES_FILE}" unit bash_bin status
  [[ -n "$home" && -d "$home" && -n "$file" ]] || return 0
  bash_bin="$(command -v bash)"
  if [[ "${STAGING_GENERATION_MEASURE_MODE:-detached}" == inline ]]; then
    if "$bash_bin" -c "$STAGING_GENERATION_MEASURE_SCRIPT" staging-generation-measure "$home" "$file"; then
      log "measured staging generation size inline: $(cat -- "$file" 2>/dev/null) bytes"
    else
      status=$?
      log "staging generation size measurement failed inline (status=$status); keeping the previous measurement"
    fi
    return 0
  fi
  unit="papercup-staging-generation-size-$(printf '%s' "$file" | sha256sum | cut -c1-12)"
  if command -v systemd-run >/dev/null 2>&1; then
    if systemctl --user is-active --quiet "$unit.service" 2>/dev/null; then
      log "staging generation size measurement already running unit=$unit; the next publication re-measures"
      return 0
    fi
    if systemd-run --user --quiet --collect --unit="$unit" \
        --description="Measure the published papercusp staging generation size (WI-6554700010029252)" \
        --nice=10 -p IOSchedulingClass=best-effort -p IOSchedulingPriority=7 \
        -- "$bash_bin" -c "$STAGING_GENERATION_MEASURE_SCRIPT" staging-generation-measure "$home" "$file" >/dev/null 2>&1; then
      log "launched detached staging generation size measurement unit=$unit home=$home"
      return 0
    fi
    log "systemd-run could not launch $unit; falling back to a detached session"
  fi
  setsid nice -n 10 "$bash_bin" -c "$STAGING_GENERATION_MEASURE_SCRIPT" staging-generation-measure "$home" "$file" </dev/null >/dev/null 2>&1 &
  log "launched detached staging generation size measurement pid=$! home=$home"
  return 0
}

prune_staging_generations() {
  local current_root candidate_root resolved_root candidate_home refs_collected=0
  local audit_pin audit_expiry audit_mtime audit_now audit_pinned
  local cleanup_budget="${1:-15}" cleanup_started="" cleanup_remaining retained_idle=0
  local pending_cleanup pending_home
  # Pruning runs before candidate preparation while this tick holds the
  # exclusive staging lock. Keep that startup path bounded; the optional
  # argument only lets the focused regression exercise expiry quickly.
  if [[ ! "$cleanup_budget" =~ ^[0-9]+$ ]] || ((cleanup_budget < 1)); then
    cleanup_budget=15
  elif ((cleanup_budget > 15)); then
    cleanup_budget=15
  fi
  [[ -d "$STAGING_GENERATIONS_ROOT" ]] || return 0
  STAGING_GENERATIONS_RETIRED=0
  # Legacy markers: Git already detached these worktrees and an earlier tick
  # began (but could not finish) a budgeted rm. Retire the remainder to trash.
  while IFS= read -r -d '' pending_cleanup; do
    pending_home="${pending_cleanup%.prune-pending}"
    if [[ ! -d "$pending_home" ]]; then
      rm -f -- "$pending_cleanup"
      continue
    fi
    if retire_staging_generation_home "$pending_home"; then
      log "retired deferred staging generation directory to trash: $pending_home"
    fi
  done < <(find "$STAGING_GENERATIONS_ROOT" -mindepth 1 -maxdepth 1 -type f -name '.candidate-*.prune-pending' -print0 2>/dev/null)
  current_root="$(realpath -e "$STAGING_ROOT" 2>/dev/null || true)"
  while IFS= read -r -d '' candidate_root; do
    if [[ -n "$cleanup_started" ]]; then
      cleanup_remaining=$((cleanup_budget - (SECONDS - cleanup_started)))
    else
      cleanup_remaining="$cleanup_budget"
    fi
    if ((cleanup_remaining <= 0)); then
      log "staging generation cleanup budget exhausted after ${cleanup_budget}s; retaining remaining generations for next tick"
      break
    fi
    resolved_root="$(realpath -e "$candidate_root" 2>/dev/null || true)"
    [[ -n "$resolved_root" && "$resolved_root" != "$current_root" ]] || continue
    # EI-25971079852455067: a process reference disappears at exactly the
    # moment crash recovery needs its immutable source. Pending audit runtimes
    # leave bounded pins before launch; terminal cleanup removes its own pin.
    # Keep corrupt/incomplete pins only for one recovery window, with an alarm.
    candidate_home="$(dirname "$resolved_root")"
    audit_now="$(date +%s)"
    audit_pinned=0
    for audit_pin in "$candidate_home/.audit-runtime-pins/"*; do
      [[ -f "$audit_pin" ]] || continue
      audit_expiry=""
      IFS= read -r audit_expiry < "$audit_pin" || true
      if [[ "$audit_expiry" =~ ^[0-9]{1,10}$ ]] &&
         ((10#$audit_expiry > audit_now && 10#$audit_expiry <= audit_now + 21600)); then
        audit_pinned=1
        break
      fi
      if [[ "$audit_expiry" =~ ^[0-9]{1,10}$ ]] && ((10#$audit_expiry <= audit_now)); then
        rm -f -- "$audit_pin"
        continue
      fi
      audit_mtime="$(stat -c %Y -- "$audit_pin" 2>/dev/null || true)"
      if [[ ! "$audit_mtime" =~ ^[0-9]{1,10}$ ]] || ((audit_now - 10#$audit_mtime < 21600)); then
        log "ALARM: malformed audit source pin retained within recovery window: $audit_pin"
        audit_pinned=1
        break
      fi
      rm -f -- "$audit_pin"
    done
    if [[ "$audit_pinned" -eq 1 ]]; then
      log "retaining prior staging generation for a bounded audit runtime pin: $resolved_root"
      retained_idle=$((retained_idle + 1))
      continue
    fi
    # Scan /proc only when there is something to prune, so the every-tick prune
    # at sync start costs nothing in the steady state.
    if [[ "$refs_collected" -eq 0 ]]; then
      collect_staging_generation_refs
      refs_collected=1
    fi
    if staging_generation_in_use "$resolved_root"; then
      log "retaining prior staging generation still referenced by a process: $resolved_root"
      staging_generation_holder_evidence "$resolved_root" || log "retention holder evidence unavailable: $resolved_root (generation retained)"
      retained_idle=$((retained_idle + 1))
      continue
    fi
    candidate_home="$(dirname "$resolved_root")"
    [[ "$(dirname "$candidate_home")" == "$STAGING_GENERATIONS_ROOT" &&
       "$(basename "$candidate_home")" == .candidate-* ]] || continue
    [[ -n "$cleanup_started" ]] || cleanup_started="$SECONDS"
    if retire_staging_generation_home "$candidate_home"; then
      log "pruned unused staging generation $resolved_root (retired to trash; bytes reclaimed outside the lock)"
    fi
  done < <(find "$STAGING_GENERATIONS_ROOT" -mindepth 2 -maxdepth 2 -type d -name checkout \
    -path "$STAGING_GENERATIONS_ROOT/.candidate-*/checkout" -print0 2>/dev/null)
  # Detector for the WI-6554700010029246 class: every retained non-serving
  # generation costs ~25 GiB on the shared root volume, so more than two held
  # at once is a leak (a stuck holder or an unexpired pin), not steady state.
  if ((retained_idle > 2)); then
    log "ALARM: ${retained_idle} non-serving staging generations retained by holders or audit pins under $STAGING_GENERATIONS_ROOT; each holds ~a full checkout of disk — inspect the staging-generation-holder lines above"
  fi
  cleanup_remaining=$((cleanup_budget - (SECONDS - ${cleanup_started:-$SECONDS})))
  ((cleanup_remaining > 0)) || cleanup_remaining=1
  prune_staging_worktree_registrations "$cleanup_remaining"
  launch_staging_trash_drain
  return 0
}

cleanup_staging_candidate() {
  if [[ -n "$STAGING_CANDIDATE_HOME" && "$STAGING_CANDIDATE_PUBLISHED" -eq 0 ]]; then
    local cleanup_budget="${1:-15}"
    if [[ ! "$cleanup_budget" =~ ^[0-9]+$ ]] || ((cleanup_budget < 1 || cleanup_budget > 15)); then
      cleanup_budget=15
    fi
    # Exit cleanup still holds the publication lease, so it stays O(1) like the
    # generation pruner (WI-6554700010029246): retire the failed candidate to
    # trash, drop its registration, and reclaim the bytes outside the lock.
    [[ -d "$STAGING_CANDIDATE_HOME" ]] || return 0
    local candidate_parent
    candidate_parent="$(dirname "$STAGING_CANDIDATE_HOME")"
    STAGING_GENERATIONS_RETIRED=0
    if retire_staging_generation_home "$STAGING_CANDIDATE_HOME" "$candidate_parent"; then
      log "retired failed staging candidate to trash: $STAGING_CANDIDATE_HOME"
      prune_staging_worktree_registrations "$cleanup_budget"
      launch_staging_trash_drain "$candidate_parent"
    else
      log "ALARM: failed staging candidate could not be retired; the next tick's pruner retries it: $STAGING_CANDIDATE_HOME"
    fi
  fi
  return 0
}

copy_staging_runtime_environment() {
  local candidate_root="$1" source_sha="${2:-}" source_root env_file
  if [[ ! "$source_sha" =~ ^[a-f0-9]{7,40}$ ]]; then
    log "FATAL: staging runtime environment requires the prepared source commit"
    return 1
  fi
  env_file="$candidate_root/apps/operator/.env.local"
  # The first generation has no current alias, and a previously published
  # generation can lack the ignored runtime file. Preserve staging overrides,
  # then recover the canonical environment instead of selecting a desktop DB
  # through the machine-wide discovery file.
  for source_root in "$STAGING_ROOT" "$LEGACY_STAGING_ROOT" "$INTEGRATION_ROOT"; do
    if [[ -f "$source_root/apps/operator/.env.local" ]]; then
      if ! cp -p -- "$source_root/apps/operator/.env.local" "$candidate_root/apps/operator/.env.local"; then
        log "FATAL: could not copy the staging runtime environment into the candidate"
        return 1
      fi
      break
    fi
  done
  # Git-less generations cannot discover their build identity at boot. Pin
  # the verified preparation ref after inherited settings so an older
  # generation's environment cannot label this artifact.
  if [[ ! -f "$env_file" ]]; then
    (umask 077; : > "$env_file") || return 1
  fi
  if ! printf '\nPAPERCUSP_BUILD_SHA=%s\n' "$source_sha" >> "$env_file"; then
    log "FATAL: could not pin the staging candidate build identity"
    return 1
  fi
}

prepare_staging_candidate() {
  local target_sha="$1" phase phase_log phase_status
  local -a phase_statuses
  local log_root="${PAPERCUSP_HOME:-$HOME/.papercusp}/checkpoint-logs"
  local attempt="${INVOCATION_ID:-$$}"
  local snapshot_script="$INTEGRATION_ROOT/apps/operator/scripts/systemd/papercusp-script-snapshot.sh"
  local setup_script="$INTEGRATION_ROOT/apps/operator/bin/release/setup-release-checkout.sh"
  [[ "$attempt" =~ ^[a-zA-Z0-9_-]+$ ]] || attempt="$$"
  if ! mkdir -p -- "$log_root"; then
    log "FATAL: cannot create setup failure log directory $log_root"
    return 1
  fi
  create_staging_candidate "$target_sha" || return 1
  log "preparing isolated staging candidate $STAGING_CANDIDATE_ROOT at ${target_sha:0:10}"
  for phase in --source-only --prepare-existing --spa-only; do
    # Stream progress while retaining raw evidence outside the candidate: the
    # EXIT cleanup removes that checkout, including Vite's own failure logs.
    phase_log="$log_root/staging-setup-$attempt-${phase#--}.log"
    if PAPERCUSP_INTEGRATION_ROOT="$INTEGRATION_ROOT" PAPERCUSP_RELEASE_ROOT="$STAGING_CANDIDATE_ROOT" \
      timeout --kill-after=10s 900s bash "$snapshot_script" "$setup_script" \
        --ref "$target_sha" --release "$STAGING_CANDIDATE_ROOT" --node-modules auto "$phase" 2>&1 | tee "$phase_log"; then
      rm -f -- "$phase_log"
    else
      # Capture both statuses before any command overwrites PIPESTATUS. Keep
      # timeout's 124 distinct from a child failure; also fail on a lost log.
      phase_statuses=("${PIPESTATUS[@]}")
      phase_status="${phase_statuses[0]}"
      if [[ "$phase_status" -eq 0 ]]; then phase_status="${phase_statuses[1]}"; fi
      if ! printf '\nsetup exit status: %s\nphase: %s\nsource: %s\ncandidate: %s\n' \
        "$phase_status" "$phase" "$target_sha" "$STAGING_CANDIDATE_ROOT" >> "$phase_log"; then
        log "FATAL: could not append setup failure metadata to $phase_log"
      fi
      log "FATAL: candidate checkout preparation failed in $phase (exit $phase_status); raw build evidence retained at $phase_log; the published staging alias is unchanged"
      return "$phase_status"
    fi
    staging_sync_checkpoint "candidate phase $phase complete" || return "$?"
  done
  copy_staging_runtime_environment "$STAGING_CANDIDATE_ROOT" "$target_sha" || return 1
}

prebuild_staging_host_bundle() {
  local candidate_root="$1" bundle_script="$2" bundle_status build_log found=0
  local log_root="${PAPERCUSP_HOME:-$HOME/.papercusp}/checkpoint-logs"
  local attempt="${INVOCATION_ID:-$$}" failure_log
  if PAPERCUSP_INTEGRATION_ROOT="$candidate_root" PAPERCUSP_BUNDLE_REUSE_FRESH=1 \
    timeout --kill-after=10s 900s bash "$bundle_script"; then
    return 0
  else
    bundle_status=$?
  fi
  # Reuse the durable checkpoint-log directory. The EXIT trap removes a failed
  # generation, and journal output alone cannot retain arbitrary raw build bytes.
  [[ "$attempt" =~ ^[a-zA-Z0-9_-]+$ ]] || attempt="$$"
  failure_log="$log_root/staging-bundle-$attempt.log"
  if ! mkdir -p -- "$log_root"; then
    log "FATAL: bundle failed (exit $bundle_status); cannot create failure log directory $log_root"
    return "$bundle_status"
  fi
  if ! {
    printf 'bundle exit status: %s\ncandidate: %s\n' "$bundle_status" "$candidate_root"
    for build_log in "$candidate_root/apps/operator/dist-host/"*.build-error.log; do
      [[ -f "$build_log" ]] || continue
      found=1
      printf '\n--- %s ---\n' "$build_log"
      cat -- "$build_log" || printf '\ncould not read %s\n' "$build_log"
    done
    if [[ "$found" -eq 0 ]]; then printf 'no build-error log was produced\n'; fi
  } > "$failure_log"; then
    log "FATAL: bundle failed (exit $bundle_status); could not retain failure logs at $failure_log"
    return "$bundle_status"
  fi
  log "FATAL: bundle failed (exit $bundle_status); raw build evidence retained at $failure_log"
  tail -n 80 -- "$failure_log" >&2 || true
  return "$bundle_status"
}

mark_staging_candidate_ready() {
  local expected_sha="$1" ready_tmp
  [[ -n "$STAGING_CANDIDATE_HOME" && -d "$STAGING_CANDIDATE_ROOT" ]] || return 1
  ready_tmp="$STAGING_CANDIDATE_HOME/.ready.$$"
  if ! printf '%s\n' "$expected_sha" > "$ready_tmp" || ! mv -f -- "$ready_tmp" "$STAGING_CANDIDATE_HOME/.ready"; then
    rm -f -- "$ready_tmp"
    return 1
  fi
}

trap finish_staging_sync EXIT

# A sidecar's reviewBy is intentionally fail-closed in the restart preflight,
# but that only runs when server code needs a restart. This advisory scan runs on
# every useful timer pass against the CURRENT serving checkout, including an
# unchanged-HEAD no-op, so a date cannot expire silently between releases.
# Warn 14 days before the review date and send one coord alarm per warning state;
# if delivery fails, retry at most once per UTC day rather than flooding inboxes.
forward_compat_review_warnings() {
  local warning_days=14 warning_report state_home state_dir state_file fingerprint today
  local previous_fingerprint previous_day previous_status alert_body alert_status tmp_file
  state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
  state_dir="$state_home/papercusp"
  state_file="$state_dir/staging-sync-forward-compat-review"

  if ! warning_report="$(cd "$INTEGRATION_ROOT" && node scripts/check-migration-forward-compat.mjs \
    "--warn-review-by-days=$warning_days" \
    "--sidecar-directory=$STAGING_ROOT/libs/papercusp/libs/db/sql")"; then
    log "ALARM: forward-compat review-date scan failed; the staging sync will continue and the full restart preflight remains fail-closed"
    return 0
  fi

  if [ -z "$warning_report" ]; then
    rm -f "$state_file"
    return 0
  fi

  fingerprint="$(printf '%s' "$warning_report" | sha256sum | cut -d' ' -f1)"
  today="$(date -u +%F)"
  previous_fingerprint=""
  previous_day=""
  previous_status=""
  if [ -r "$state_file" ]; then
    read -r previous_fingerprint previous_day previous_status < "$state_file" || true
  fi
  if [ "$fingerprint" = "$previous_fingerprint" ] && [ "$previous_status" = sent ]; then
    return 0
  fi
  if [ "$fingerprint" = "$previous_fingerprint" ] && [ "$previous_day" = "$today" ]; then
    return 0
  fi

  log "ALARM: migration forward-compat sidecar review dates need attention"
  while IFS= read -r warning_line; do
    [ -n "$warning_line" ] && log "$warning_line"
  done <<< "$warning_report"

  # An expiring sidecar is WORK, not news (WI-10005182). This alarm used to be
  # only a one-shot `*` FYI broadcast: 987's warning went out ~26h before its
  # reviewBy, nobody owned it, and the lapse froze :3170 fleet-wide exactly as
  # 941's had (WI-10003591). File a claimable work-item that stays open until a
  # sidecar is renewed. The broadcast is now only the fallback when filing
  # fails, so delivery is never silently dropped.
  alert_status=failed
  if [ -f "$INTEGRATION_ROOT/scripts/mcp-call.mjs" ]; then
    alert_body="$(PAPERCUSP_REVIEW_WARNING_REPORT="$warning_report" node -e '
      const report = process.env.PAPERCUSP_REVIEW_WARNING_REPORT || "";
      // One stable subject per (sidecar, reviewBy): the "is within N days" and
      // "has passed" phrasings of the same expiry name the same work.
      const due = [...report.matchAll(/(\S+?)\.sql\.forward-compat\.json reviewBy (\d{4}-\d{2}-\d{2})/g)]
        .map((m) => `${m[1].replace(/^.*\//, "")} reviewBy ${m[2]}`);
      const subjects = [...new Set(due)].sort().join(", ") || "see body";
      process.stdout.write(JSON.stringify({
        kind: "task",
        title: `Renew or remove expiring migration forward-compat sidecar(s) before staging-sync freezes :3170: ${subjects}`,
        body: `${report}\n\nAn expired reviewBy makes the staging-sync restart preflight fail closed, which keeps :3170 on its old build for every agent until the sidecar is fixed (WI-10003591, WI-10005182). If the sidecar requiresDeployedCommit is already in the deployed :3070 release, renew reviewBy; otherwise ship that commit first. Verify with: node scripts/check-migration-forward-compat.mjs`,
      }));
    ' 2>/dev/null || true)"
    if [ -n "$alert_body" ] && (
      cd "$INTEGRATION_ROOT" &&
      timeout 30 node scripts/mcp-call.mjs work_items:create "$alert_body" \
        --client system-staging-sync-review-alarm --harness papercusp --workspace papercusp-workspace >/dev/null
    ); then
      alert_status=sent
      log "ALARM: filed a sidecar-renewal work-item for: $(printf '%s' "$alert_body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).title)}catch{}})' 2>/dev/null)"
    else
      log "ALARM: could not file the sidecar-renewal work-item; falling back to a workspace broadcast"
    fi
  fi
  if [ "$alert_status" != sent ] && [ -f "$INTEGRATION_ROOT/scripts/mcp-call.mjs" ]; then
    alert_body="$(PAPERCUSP_REVIEW_WARNING_REPORT="$warning_report" node -e '
      const report = process.env.PAPERCUSP_REVIEW_WARNING_REPORT || "";
      process.stdout.write(JSON.stringify({
        to: ["*"],
        expects: "none",
        summary: "Staging migration forward-compat reviews need attention",
        body: [{ text: `${report}\n\nRenew or remove each sidecar before its reviewBy date.` }],
      }));
    ' 2>/dev/null || true)"
    if [ -n "$alert_body" ] && (
      cd "$INTEGRATION_ROOT" &&
      timeout 30 node scripts/mcp-call.mjs coord:send "$alert_body" \
        --client system-staging-sync-review-alarm --harness papercusp --workspace papercusp-workspace >/dev/null
    ); then
      alert_status=sent
    else
      log "ALARM DELIVERY FAILED: neither work_items:create nor coord:send reached the Papercusp workspace; this condition will be retried tomorrow"
    fi
  elif [ "$alert_status" != sent ]; then
    log "ALARM DELIVERY FAILED: scripts/mcp-call.mjs is unavailable; this condition will be retried tomorrow"
  fi

  if ! mkdir -p "$state_dir"; then
    log "WARNING: could not persist the sidecar warning state; a later tick may repeat this alarm"
    return 0
  fi
  tmp_file="$state_file.$$"
  if ! printf '%s %s %s\n' "$fingerprint" "$today" "$alert_status" > "$tmp_file" || ! mv -f "$tmp_file" "$state_file"; then
    rm -f "$tmp_file"
    log "WARNING: could not persist the sidecar warning state; a later tick may repeat this alarm"
  fi
  return 0
}

# A migration is applied during the next host boot, before :3170 can bind. Run
# the same source lints against the checkout we are about to serve while the old
# process is still alive. In particular, forward-compat catches an unacknowledged
# index change that the host's per-file preapply guard would otherwise discover
# only after the coordinated restart stopped the old process.
preflight_staging_migrations() {
  local candidate_root="${1:-$STAGING_ROOT}"
  log "checking staging migration safety before restarting $UNIT"
  if ! (
    # Match prepare_staging_schema and ExecStart: reservation lint must query
    # the candidate's runtime DB, never an ambient desktop discovery target.
    set -a
    if [[ -f "$candidate_root/apps/operator/.env.local" ]]; then
      . "$candidate_root/apps/operator/.env.local" || exit 1
    fi
    set +a
    cd "$candidate_root" &&
    export PAPERCUSP_INTEGRATION_ROOT="$candidate_root" || exit 1
    # Match the setup/bundle phase budget. A synchronous parser-cache read can
    # stall without throwing, so an exception-only fallback cannot bound this
    # safety check (EI-25987864550799293). Expiry must keep the old API serving.
    for check in scripts/lint-migrations.mjs scripts/check-migration-forward-compat.mjs; do
      log "running staging migration check $check (deadline=900s)"
      if timeout --kill-after=10s 900s node "$check"; then
        log "staging migration check $check passed"
      else
        check_status=$?
        log "FATAL: staging migration check $check failed or exceeded its deadline (exit $check_status)"
        exit "$check_status"
      fi
    done
  ); then
    log "FATAL: staging migration lint failed; keeping the current $UNIT process"
    return 1
  fi
}

# Complete the pinned target's migrations while the old API is still serving.
# Reuse the guarded boot/candidate runner: a backup-held rendezvous waits HERE,
# not after systemd has stopped the healthy process. A backup beginning after
# this returns is safe too: boot sees the applied target set and takes its
# existing no-pending path without applying new files outside the rendezvous.
prepare_staging_schema() {
  local candidate_root="${1:-$STAGING_ROOT}"
  log "preparing the target schema while the current $UNIT process keeps serving"
  if ! (
    # Use the same runtime environment as ExecStart. Otherwise preflight can
    # migrate a discovered desktop DB while the candidate serves the pinned DB.
    set -a
    if [[ -f "$candidate_root/apps/operator/.env.local" ]]; then
      . "$candidate_root/apps/operator/.env.local" || exit 1
    fi
    set +a
    cd "$candidate_root" &&
    PAPERCUSP_INTEGRATION_ROOT="$candidate_root" \
      TSX_TSCONFIG_PATH="$candidate_root/apps/operator/tsconfig.json" \
      node --import tsx --input-type=module - <<'JS'
import { resolve } from 'node:path';
import { applyPendingMigrationsNow } from './packages/operator-core/lib/db-boot-migrate.ts';
import { assertRequiredServingMigrationsApplied } from './packages/operator-core/lib/serving-generation.ts';
  try {
    const result = await applyPendingMigrationsNow({
      sqlDir: resolve('libs/papercusp/libs/db/sql'),
      broadcast: false,
    });
    if (!result || result.failed.length > 0) {
      console.error('[staging-sync] target schema preparation failed:', JSON.stringify(result));
      process.exit(1);
    }
    await assertRequiredServingMigrationsApplied();
    console.log('[staging-sync] target schema prepared:', JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.error('[staging-sync] target schema preparation failed:', error);
    process.exit(1);
  }
JS
  ); then
    log "FATAL: staging schema preparation failed; keeping the current $UNIT process"
    return 1
  fi
}

# Request-only hono-host startup applies pending migrations before binding :3170.
# A migration can therefore keep the port unbound for several minutes even
# though the coordinated restart succeeded. Keep the readiness wait generous
# enough for that expected boot work, but validate it as a finite positive
# integer so a bad timer environment cannot create an accidental endless loop.
normalize_staging_readiness_timeout_sec() {
  local requested="${1:-}"
  case "$requested" in
    ''|*[!0-9]*) return 1 ;;
  esac
  requested=$((10#$requested))
  [ "$requested" -gt 0 ] || return 1
  printf '%s\n' "$requested"
}

READINESS_TIMEOUT_SEC="$(normalize_staging_readiness_timeout_sec "${PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC:-300}")" || {
  log "FATAL: invalid PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC; expected a positive integer number of seconds"
  exit 1
}

# EI-19457080109574347 (2026-08-22 recurrence): the shared apps/operator/.env.local
# deliberately carries an off-loopback bind for other operator roles. A staging ExecStart
# sourced that file without overriding the bind, then P-016's correct fail-fast auth policy
# crash-looped :3170. The old process had been healthy; the sync restart created the outage.
#
# Prove the EFFECTIVE command has an explicit final loopback assignment after any .env.local
# source. Checking for the token anywhere is insufficient: an assignment before the source is
# overwritten by the file, and an earlier loopback assignment can be superseded later.
staging_exec_forces_loopback() {
  local exec_start="${1:-}" launch_tail last_bind
  launch_tail="$exec_start"
  if [[ "$exec_start" == *".env.local"* ]]; then
    launch_tail="${exec_start##*.env.local}"
  fi
  last_bind="$(printf '%s\n' "$launch_tail" | grep -oE 'PAPERCUSP_BIND_HOST=[^ ;}]+' | tail -n 1 || true)"
  [ "$last_bind" = "PAPERCUSP_BIND_HOST=127.0.0.1" ]
}

staging_exec_pins_integration_root() {
  local exec_start="${1:-}" launch_tail="${1:-}"
  if [[ "$exec_start" == *".env.local"* ]]; then
    launch_tail="${exec_start##*.env.local}"
  fi
  [[ "$launch_tail" == *'PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)"'* ||
     "$launch_tail" == *'PAPERCUSP_INTEGRATION_ROOT=$(cd ../.. && pwd -P)'* ]]
}

assert_staging_unit_loopback() {
  local exec_start
  if ! exec_start="$(systemctl --user show -p ExecStart --value "$UNIT" 2>/dev/null)"; then
    log "FATAL: refusing staging sync — cannot read $UNIT ExecStart, so the launch bind policy is unverified"
    return 1
  fi
  if staging_exec_forces_loopback "$exec_start"; then
    return 0
  fi
  log "FATAL: refusing staging sync/restart — $UNIT ExecStart does not force PAPERCUSP_BIND_HOST=127.0.0.1 after sourcing .env.local. Repair the unit/drop-in first; otherwise a shared off-loopback bind can crash-loop :3170 under the strict remote-auth boot guard."
  return 1
}

# EI-22636310973765418: the checkout advanced by this service and the checkout
# executed by :3170 must be the SAME tree. On 2026-09-07 both effective
# drop-ins pointed at the canonical shared tree while this script updated the
# isolated papercusp-staging tree; builds and restarts therefore described
# different source. Fail before touching either tree when that contract drifts.
staging_exec_pre_uses_bundle() {
  local exec_pre="${1:-}" expected_workdir="${2:-}" required_prefix expected_root helper_prefix
  # systemctl show reports the EFFECTIVE executable in path=. Accept the legacy
  # direct flock command and the guarded helper wrapper, which falls back to
  # that same flock while papercusp-staging.current is one generation behind.
  # Both shapes must use the exact shared lock and isolated bundle script.
  required_prefix="{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -s /tmp/papercup-staging-sync.lock $expected_workdir/bin/bundle-host.sh ; "
  if [[ "$exec_pre" == "$required_prefix"* ]]; then
    return 0
  fi

  [[ "$expected_workdir" == */apps/operator ]] || return 1
  expected_root="${expected_workdir%/apps/operator}"
  helper_prefix="{ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c root=\"$expected_root\"; helper=\"\$\$root/apps/operator/scripts/systemd/staging-lock-attribution.sh\"; if [ -f \"\$\$helper\" ]; then exec /usr/bin/bash \"\$\$helper\" api-pre /tmp/papercup-staging-sync.lock \"\$\$root/apps/operator/bin/bundle-host.sh\"; fi; echo \"[95-bundled-entry] \$\$helper is absent from this staging generation; bundling under the shared flock without attribution\" >&2; exec /usr/bin/flock -s /tmp/papercup-staging-sync.lock \"\$\$root/apps/operator/bin/bundle-host.sh\" ; "
  [[ "$exec_pre" == "$helper_prefix"* ]]
}

assert_staging_unit_checkout() {
  local expected_root expected_workdir expected_spa_dist working_dir integration_env exec_pre exec_start reuse_env
  expected_root="$STAGING_ROOT"
  expected_workdir="$expected_root/apps/operator"
  expected_spa_dist="$expected_root/apps/operator-vite/dist"
  working_dir="$(systemctl --user show -p WorkingDirectory --value "$UNIT" 2>/dev/null || true)"
  working_dir="${working_dir#\!}"
  integration_env="$(systemctl --user show -p Environment --value "$UNIT" 2>/dev/null || true)"
  exec_pre="$(systemctl --user show -p ExecStartPre --value "$UNIT" 2>/dev/null || true)"
  exec_start="$(systemctl --user show -p ExecStart --value "$UNIT" 2>/dev/null || true)"
  reuse_env="PAPERCUSP_BUNDLE_REUSE_FRESH=1"
  if [[ "$working_dir" != "$expected_workdir" ]]; then
    log "FATAL: $UNIT WorkingDirectory must follow the stable staging alias $expected_workdir (got ${working_dir:-<empty>}); refusing to build one checkout and restart another"
    return 1
  fi
  if [[ " $integration_env " != *" PAPERCUSP_INTEGRATION_ROOT=$expected_root "* ]]; then
    log "FATAL: $UNIT PAPERCUSP_INTEGRATION_ROOT does not name $expected_root; refusing cross-checkout staging sync"
    return 1
  fi
  if [[ " $integration_env " != *" PAPERCUSP_SPA_DIST=$expected_spa_dist "* ]]; then
    log "FATAL: $UNIT PAPERCUSP_SPA_DIST must follow the stable staging alias $expected_spa_dist so SPA-only advances remain visible without a restart"
    return 1
  fi
  if ! staging_exec_pre_uses_bundle "$exec_pre" "$expected_workdir"; then
    log "FATAL: $UNIT ExecStartPre must take the shared staging-sync lock and build from $expected_workdir/bin/bundle-host.sh"
    return 1
  fi
  if ! staging_exec_pins_integration_root "$exec_start"; then
    log "FATAL: $UNIT ExecStart must resolve PAPERCUSP_INTEGRATION_ROOT from its physical startup directory after sourcing .env.local"
    return 1
  fi
  if [[ " $integration_env " != *" $reuse_env "* ]]; then
    log "FATAL: $UNIT does not enable $reuse_env; a prebuilt bundle would be rebuilt only after stop"
    return 1
  fi
}

# Return the exact short source SHA baked into the running bundle. A 200 alone
# is not freshness: before this fix :3170 returned 200 from 6370b7fa98 while
# the isolated checkout had advanced far beyond it.
staging_health_source_sha() {
  curl -fsS --max-time 4 "$HEALTH_URL" 2>/dev/null | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const sha = JSON.parse(body)?.sha;
        if (typeof sha === "string" && /^[a-f0-9]{7,40}$/.test(sha)) process.stdout.write(sha);
        else process.exitCode = 1;
      } catch { process.exitCode = 1; }
    });
  '
}

health_sha_matches_target() {
  local health_sha="${1:-}" target_sha="${2:-}"
  [[ -n "$health_sha" && -n "$target_sha" && "$target_sha" == "$health_sha"* ]]
}

# A self-targeted :3170 restart can close the HTTP stream before ptool receives
# dev:restart's terminal receipt. Treat it as complete only when systemd's
# MainPID changed and the new listener reports the exact requested source SHA.
staging_restart_is_observed() {
  local before_pid="${1:-}" current_pid="${2:-}" health_sha="${3:-}" target_sha="${4:-}"
  case "$current_pid" in
    ''|0|*[!0-9]*) return 1 ;;
  esac
  if [ -n "$before_pid" ] && [ "$before_pid" != "0" ] && [ "$current_pid" = "$before_pid" ]; then
    return 1
  fi
  health_sha_matches_target "$health_sha" "$target_sha"
}

staging_sync_process_running() {
  local process_state
  process_state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$process_state" ] && [[ "$process_state" != Z* ]]
}

# --- WI-5710 gate 1: is a process restart actually REQUIRED? ----------------
#
# The original script gated everything on `target != current`, i.e. it used
# "the branch moved" as a proxy for "the code the running process holds
# changed". Under a fleet where git-sync auto-commits the whole tree every few
# minutes, that proxy decoupled from what it proxies.
#
# The SPA needs no restart at all: apps/operator/bin/host-spa.ts serves the
# dist FROM DISK PER REQUEST (existsSync + serveFile per asset; index.html read
# per request with cache-control:no-store), so once setup-release-checkout.sh
# --build-spa has run, the new SPA is already live. Restarting for an SPA-only
# commit is pure downtime.
#
# FAIL-SAFE DIRECTION, and never invert it: a restart is required UNLESS
# *every* changed path matches the conservative allowlist below. An unknown or
# newly-introduced path shape falls through to a restart — today's behaviour.
# The inverse ("skip unless known-server") would mean a new server directory
# silently stops being picked up, which is a far worse failure than an extra
# restart.
path_needs_no_restart() {
  case "$1" in
    # SPA sources. apps/operator/app/** is compiled INTO the Vite bundle via
    # vite.config.ts's `@` → operator-root alias; verified tree-wide that no
    # server module imports from it.
    apps/operator-vite/src/*) return 0 ;;
    apps/operator/app/*) return 0 ;;
    # The Tauri desktop shell submodule. It EMBEDS the operator as a sidecar;
    # the :3170 server loads nothing from it, so its pointer bumps are inert here.
    papercusp-desktop) return 0 ;;
    # Prose: docs, plans, insights. Served from disk; never executed.
    *.md|*.mdx) return 0 ;;
    docs/*|*/docs/*) return 0 ;;
    # Tests never run inside the operator process.
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) return 0 ;;
    */e2e/*|*/__tests__/*) return 0 ;;
  esac
  return 1
}

# Reads newline-separated changed paths on stdin.
# Exit 0 = a restart IS required (the fail-safe default, matching
# need_node_modules()'s "0 means the work is needed" convention in the sibling
# setup-release-checkout.sh). Exit 1 = every path is provably restart-exempt.
paths_require_restart() {
  local p seen=0 relevant=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    seen=1
    # Drain the complete diff even after a server path is found. An early
    # return closes the pipe, making git exit with SIGPIPE; with pipefail the
    # caller would then mistake a required restart for an exempt advance.
    path_needs_no_restart "$p" || relevant=1
  done
  # An EMPTY path list means we could not establish what changed (a failed or
  # unavailable diff), not "nothing changed" — the caller no-ops on an
  # unmoved HEAD long before this. Fail safe: restart.
  [ "$seen" = 1 ] || return 0
  [ "$relevant" = 0 ] || return 0
  return 1
}

# --- WI-5710 gate 2: is anyone actually USING :3170 right now? --------------
#
# Long-lived SSE/sync connections from a live operator window show as
# ESTABLISHED inbound sockets on the staging port. Best-effort by design: any
# probe failure (no `ss`, no permission) reports 0 and falls through to the
# normal restart, matching this script's fail-soft contract everywhere else.
staging_live_client_count() {
  local port="${1:-$STAGING_PORT}" n
  n="$(ss -tn state established "( sport = :$port )" 2>/dev/null | tail -n +2 | grep -c . || true)"
  [ -n "$n" ] || n=0
  echo "$n"
}

# Read a dev:restart JSON result from stdin. Exit 0 only when the coordinated
# restart actually fired, was verified-coalesced with a recent peer restart, or
# returned the explicitly supported asynchronous staging-start state. The last
# case is still followed by this script's exact-source readiness loop below.
restart_result_is_accepted() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        const asyncStarting =
          result?.ok === true &&
          result?.restartScheduled === true &&
          result?.restartObserved === true &&
          result?.stagingReadiness?.ready === false &&
          result?.stagingReadiness?.outcome === "starting";
        process.exit(result?.ok === true && (result?.restarted === true || result?.coalesced === true || asyncStarting) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

restart_result_is_pre_dispatch_refusal() {
  printf '%s' "${1:-}" | grep -Eiq 'authorization_denied|no-launch-record|restart_withheld'
}

# A scheduled restart can still be stopping the old process when dev:restart's
# observation window ends. This permits ONLY the bounded verification below,
# never a success verdict or another restart request.
restart_result_is_pending() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        const currentPending =
          result?.stagingReadiness?.outcome === "not-observed" &&
          result?.stagingReadiness?.activeState !== "failed";
        // Older hosts returned the audited request before readiness observation
        // existed. Admit that exact receipt only to the same bounded PID/source
        // reconciliation below; scheduled remains distinct from completed.
        const legacyPending =
          result?.stagingReadiness === undefined && result?.ok === true &&
          result?.requestAuditPersisted === true &&
          typeof result?.restartRequestId === "string" && result.restartRequestId.trim().length > 0 &&
          result?.reason === undefined && result?.error === undefined;
        process.exit(result?.target === "staging" &&
          result?.restartScheduled === true && result?.restartObserved === false &&
          (currentPending || legacyPending) ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}

# True when a dev:restart refusal is a TRANSIENT git-sync coordination refusal
# (EI-22102474093310851). dev:restart derives these reasons with a stable prefix —
# `git_sync_collision_${kind}` and `git_sync_barrier_${reason}` (agent-tools/dev/
# restart.ts) — so match the PREFIX the code owns, never a hand-copied list of
# suffixes: the suffix vocabulary is a `.replace(/-/g,'_')` of an open enum and
# would drift silently the moment a new kind is added.
restart_refusal_is_transient_git_sync() {
  node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(body);
        const reason = typeof result?.reason === "string" ? result.reason : "";
        process.exit(/^git_sync_(collision|barrier)_/.test(reason) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

# Seconds since the commit the staging checkout is CURRENTLY serving. Bounds
# the deferral: we only ever defer while the served code is still reasonably
# fresh. An unresolvable sha reports a huge age ⇒ forces the restart.
current_commit_age_sec() {
  local sha="$1" ct now
  [ -n "$sha" ] && [ "$sha" != none ] || { echo 999999; return 0; }
  ct="$(git -C "$INTEGRATION_ROOT" show -s --format=%ct "$sha" 2>/dev/null || echo '')"
  [ -n "$ct" ] || { echo 999999; return 0; }
  now="$(date +%s)"
  echo $(( now - ct ))
}

# Single-flight: a second timer tick (or a manual run) waits/skips rather than
# racing two setups on the same checkout, even when preparation permits readers.
# A separate writer lease serializes ticks; the generation barrier is exclusive
# only for GC/bootstrap and publication. A release cut whose orchestrator is this
# checkout holds the generation barrier SHARED for its whole run (WI-10003515,
# release-cut-launch.ts wrapWithStagingSyncLock), so re-cloning submodules in place
# cannot delete scripts out from under an in-flight cut.
STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"
STAGING_SYNC_ATTEMPT_ID="$(staging_lock_attempt_id)"
STAGING_SYNC_WAIT_START_MS="$(staging_lock_now_ms)"
staging_lock_log "event=start surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=wait_start lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=exclusive wait_start_ms=$STAGING_SYNC_WAIT_START_MS" || true
if staging_sync_lock_start; then
  :
else
  staging_lock_start_status=$?
  if [[ "$staging_lock_start_status" -ne 75 ]]; then
    log "FATAL: could not start the staging-sync lock keeper"
    exit 1
  fi
  STAGING_SYNC_END_MS="$(staging_lock_now_ms)"
  STAGING_SYNC_HOLDER="$(staging_lock_holder_fields "$STAGING_SYNC_LOCK_PATH" exclusive)"
  staging_lock_log "event=end surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=complete lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=exclusive wait_start_ms=$STAGING_SYNC_WAIT_START_MS wait_elapsed_ms=$(staging_lock_elapsed_ms "$STAGING_SYNC_WAIT_START_MS" "$STAGING_SYNC_END_MS") acquisition_outcome=not_acquired $STAGING_SYNC_HOLDER" || true
  cut_note=""
  active_cuts="$(systemctl --user list-units --state=active --no-legend --plain 'papercup-release-cut*' 2>/dev/null | awk '{print $1}' | paste -sd, -)"
  if [[ -n "$active_cuts" ]]; then
    cut_note=" (release cut running: ${active_cuts} — it holds the lock shared until it exits)"
  fi
  log "staging-sync lock is held — another staging-sync, a staging restart, or a release cut${cut_note} — skipping this tick"
  exit 0
fi

[ -d "$INTEGRATION_ROOT/.git" ] || { log "FATAL: integration root not a git repo: $INTEGRATION_ROOT"; exit 1; }
staging_alias_bootstrap || { log "FATAL: could not bootstrap the stable staging alias"; exit 1; }

# WI-10005311: prune superseded generations at the START of every tick,
# including no-op ticks. This tick holds the exclusive lock, so no peer sync
# or release cut can be mid-create. The published generation and any generation
# a process still references are retained.
# WI-10006606: do not repeat GC after publication/readiness. A verified cutover
# exhausted systemd's startup budget in that second prune and was reported as
# failed despite serving the exact target. Newly superseded generations are
# collected on the next timer tick through this same maintained GC path.
prune_staging_generations
staging_sync_checkpoint "generation cleanup complete"

if [[ "${STAGING_SYNC_CLEANUP_ONLY:-0}" == 1 ]]; then
  log "staging generation cleanup-only pass complete"
  exit 0
fi

# Immutable candidate preparation cannot invalidate a selected generation.
# Keep the writer lease, but admit shared readers during the expensive work.
staging_sync_lock_shared || { log "FATAL: could not admit generation readers after cleanup"; exit 1; }

forward_compat_review_warnings

# Fail BEFORE even the no-op/advance decision: a drifted launch command must be visible on the
# next timer tick, and it must never reach a restart that replaces a healthy old process with a
# predictably rejected off-loopback boot.
assert_staging_unit_loopback || exit 1
assert_staging_unit_checkout || exit 1

target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")"
current="$(git -C "$STAGING_ROOT" rev-parse --verify HEAD 2>/dev/null || echo none)"
health_sha="$(staging_health_source_sha || true)"
served_sha="${health_sha:-$current}"
checkout_needs_advance=0

if [ "$target" = "$current" ]; then
  if health_sha_matches_target "$health_sha" "$target"; then
    log "staging checkout and running :3170 bundle already at ${target:0:10} — no-op"
    exit 0
  fi
  # A prior tick may have advanced the checkout before dev:restart was
  # refused/coalesced. Retrying from runtime SHA closes the old permanent
  # no-op: checkout equality alone cannot prove the process loaded that tree.
  log "staging checkout is at ${target:0:10}, but running :3170 reports ${health_sha:-no valid source SHA} — restart still required"
  changed_count=0
  restart_required=1
else
  checkout_needs_advance=1
  # WI-5710 gate 1 — decide BEFORE doing any work whether the running process
  # actually needs to be replaced, or only the on-disk SPA refreshed.
  changed_count=0
  if [ "$current" = none ]; then
    log "fresh staging checkout — full sync + restart"
    restart_required=1
  elif [ -z "$health_sha" ] ||
       ! changed_paths="$(git -C "$INTEGRATION_ROOT" diff --name-only "$health_sha" "$target" 2>/dev/null)"; then
    # The published checkout may already be ahead of the process after a
    # refused restart. Judge the code the process holds, and fail safe when
    # that identity or its diff cannot be measured.
    restart_required=1
  else
    changed_count="$(printf '%s\n' "$changed_paths" | grep -c . || true)"
    # Capture git's status independently; no producer failure or SIGPIPE may
    # be mistaken for an exempt diff under pipefail.
    if paths_require_restart <<< "$changed_paths"; then
      restart_required=1
    else
      restart_required=0
    fi
  fi
fi

# WI-5710 gate 2 — a restart IS required, but someone is using :3170 right now.
# Defer the ENTIRE sync (not just the restart): advancing the checkout while
# holding the old process would serve a NEW SPA against an OLD server, and that
# skew is worse than a few minutes of staleness. Keeping the whole checkout
# pinned leaves the live session on a fully consistent build until it goes idle.
if [ "$restart_required" = 1 ]; then
  live_clients="$(staging_live_client_count "$STAGING_PORT")"
  if [ "$live_clients" -gt 0 ] 2>/dev/null; then
    age="$(current_commit_age_sec "$served_sha")"
    if [ "$age" -lt "$MAX_STALE_SEC" ] 2>/dev/null; then
      log "deferring sync — $live_clients live client connection(s) on :$STAGING_PORT and the served build is only ${age}s old (< ${MAX_STALE_SEC}s ceiling); staying on ${current:0:8} so the live session keeps a consistent build. Will advance to ${target:0:8} once idle, or at the ceiling."
      exit 0
    fi
    log "staleness ceiling reached (${age}s ≥ ${MAX_STALE_SEC}s) — advancing despite $live_clients live client connection(s) on :$STAGING_PORT"
  fi
fi

# EI-21461712128132271: the timer used to bypass the platform's coordinated
# restart seam with a raw `systemctl restart`. On 2026-08-25 it crossed the
# staleness ceiling with nine live :3170 clients, then cut a Personal Vault
# acceptance probe into a 27-second connection-refused window. The ceiling is
# still required (otherwise persistent SSE clients can pin staging forever),
# but the restart itself must drain resource users, coalesce with peer
# restarts, and write the ordinary restart audit. Fail BEFORE advancing the
# checkout when that mechanism is unavailable; serving a new SPA from disk
# against an old in-memory server is worse than staying wholly stale.
PTOOL_BIN="${PAPERCUSP_PTOOL_BIN:-$(command -v ptool || true)}"
if [ "$restart_required" = 1 ] && [ -z "$PTOOL_BIN" ]; then
  log "FATAL: refusing staging sync — ptool is unavailable, so the coordinated dev:restart seam cannot run"
  exit 1
fi

SYNC_ROOT="$(realpath -e "$STAGING_ROOT" 2>/dev/null || printf '%s' "$STAGING_ROOT")"
if [ "$checkout_needs_advance" = 1 ]; then
  if staging_preparation_has_headroom; then
    :
  else
    headroom_status=$?
    if [[ "$headroom_status" -eq 75 ]]; then
      log "deferring candidate preparation until critical disk headroom recovers; the next tick retries cleanup"
      exit 0
    fi
    log "FATAL: could not verify candidate filesystem headroom (exit $headroom_status); preserving the serving generation"
    exit 1
  fi
  log "preparing isolated staging candidate for ${target:0:10}"
  prepare_staging_candidate "$target"
  staging_sync_checkpoint "candidate checkout and SPA prepared"
  SYNC_ROOT="$STAGING_CANDIDATE_ROOT"
else
  log "isolated checkout already at ${target:0:10}; repairing only the stale running generation"
fi

if [ "$restart_required" = 1 ]; then
  preflight_staging_migrations "$SYNC_ROOT"
  staging_sync_checkpoint "migration safety checks complete"
  bundle_script="$STAGING_BUNDLE_SCRIPT"
  if [[ -n "$STAGING_CANDIDATE_ROOT" ]]; then
    bundle_script="$STAGING_CANDIDATE_ROOT/apps/operator/bin/bundle-host.sh"
  fi
  if [[ ! -f "$bundle_script" ]]; then
    log "FATAL: staging bundle script not found at $bundle_script"
    exit 1
  fi
  log "prebuilding proof-bound host bundle before publishing or stopping $UNIT"
  prebuild_staging_host_bundle "$SYNC_ROOT" "$bundle_script"
  staging_sync_checkpoint "host bundle prebuilt"
  prepare_staging_schema "$SYNC_ROOT"
  staging_sync_checkpoint "target schema prepared"
fi

if [ "$checkout_needs_advance" = 1 ]; then
  # Serialize publication with GC/selection readers. A failed bounded upgrade
  # leaves the old alias intact; the EXIT trap cleans only our unpublished work
  # before releasing the separate writer lease.
  if staging_sync_lock_exclusive; then
    :
  else
    publication_lock_status=$?
    log "FATAL: generation publication lock unavailable (exit $publication_lock_status); keeping the published alias"
    exit "$publication_lock_status"
  fi
  mark_staging_candidate_ready "$target"
  require_host_bundle=0
  if [ "$restart_required" = 1 ]; then
    require_host_bundle=1
  fi
  publish_staging_generation "$STAGING_CANDIDATE_ROOT" "$STAGING_CANDIDATE_HOME" "$target" "$require_host_bundle"
  staging_sync_checkpoint "generation published"
  launch_staging_generation_measure "$STAGING_CANDIDATE_HOME"
fi

# WI-5710 — SPA-only advance: the stable alias now points at the complete
# candidate dist and host-spa.ts follows that alias per request. Restarting
# would add a ~10-13s outage for zero server-code freshness gain.
if [ "$restart_required" = 0 ]; then
  log "✅ skipping restart — all ${changed_count} changed path(s) are restart-exempt (SPA/docs/tests); the published SPA is live on :$STAGING_PORT at ${target:0:8}"
  exit 0
fi

# The candidate is complete and published. Downgrade the single-flight lock
# before systemd ExecStartPre takes the shared lock to verify/reuse the bundle.
STAGING_SYNC_SHARED_WAIT_START_MS="$(staging_lock_now_ms)"
staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_wait_start phase=preflight-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS" || true
if staging_sync_lock_shared; then
  STAGING_SYNC_SHARED_END_MS="$(staging_lock_now_ms)"
  staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_acquired phase=preflight-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS wait_elapsed_ms=$(staging_lock_elapsed_ms "$STAGING_SYNC_SHARED_WAIT_START_MS" "$STAGING_SYNC_SHARED_END_MS") acquisition_outcome=acquired" || true
else
  STAGING_SYNC_SHARED_RC=$?
  STAGING_SYNC_SHARED_END_MS="$(staging_lock_now_ms)"
  STAGING_SYNC_HOLDER="$(staging_lock_holder_fields "$STAGING_SYNC_LOCK_PATH" shared)"
  staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_failed phase=preflight-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS wait_elapsed_ms=$(staging_lock_elapsed_ms "$STAGING_SYNC_SHARED_WAIT_START_MS" "$STAGING_SYNC_SHARED_END_MS") acquisition_outcome=failed command_exit_status=$STAGING_SYNC_SHARED_RC $STAGING_SYNC_HOLDER" || true
  exit "$STAGING_SYNC_SHARED_RC"
fi

# EI-13221 / EI-25704983282782441: coalesce a recent peer restart only when
# the running process reports the generation we just published. Process age
# alone says nothing about loaded code: a young process can still hold the
# previous generation. Missing identity falls through to the required restart.
RECENT_RESTART_GRACE_SEC="${PAPERCUSP_STAGING_SYNC_RESTART_GRACE_SEC:-45}"
main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
seconds_since_start=""
if [ -n "$main_pid" ] && [ "$main_pid" -gt 0 ] 2>/dev/null; then
  seconds_since_start="$(ps -o etimes= -p "$main_pid" 2>/dev/null | tr -d ' ')"
fi
if [ -n "$seconds_since_start" ] && [ "$seconds_since_start" -lt "$RECENT_RESTART_GRACE_SEC" ] 2>/dev/null; then
  recent_health_sha="$(staging_health_source_sha || true)"
  if health_sha_matches_target "$recent_health_sha" "$target"; then
    log "skipping restart — $UNIT's recent MainPID ($main_pid, ${seconds_since_start}s old) reports target source ${target:0:10}; peer restart verified"
    exit 0
  fi
  log "recent MainPID ($main_pid, ${seconds_since_start}s old) reports ${recent_health_sha:-no valid source SHA}, not target ${target:0:10} — restart still required"
fi

# EI-22102474093310851: WAIT for the git-sync barrier instead of one-shotting it.
# dev:restart's own guidance: "git-sync fires hold the barrier only ~5-10s, so a
# short drain usually succeeds where a one-shot attempt always fails" — and a
# one-shot is exactly what this call used to be, which is why 13 of this timer's
# runs in 24h died on git_sync_barrier_/git_sync_collision_ refusals (ZERO of them
# a build error, despite the filed title). Bounded well under both the tool's
# The currently deployed staging operator (build 6e898b6cf8, observed
# 2026-09-04) accepts at most 45s for this argument, while newer source may
# advertise a larger ceiling. Keep this automated caller within the smallest
# live schema so a stale staging operator cannot reject the sync before it
# restarts itself. User overrides are clamped to the compatibility ceiling.
normalize_git_sync_drain_sec() {
  local requested="${1:-45}"
  case "$requested" in
    ''|*[!0-9]*) return 1 ;;
  esac
  requested=$((10#$requested))
  if [ "$requested" -gt 45 ]; then
    requested=45
  fi
  printf '%s\n' "$requested"
}

GIT_SYNC_DRAIN_SEC="$(normalize_git_sync_drain_sec "${PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC:-45}")" || {
  log "FATAL: invalid PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC; expected a non-negative integer"
  exit 1
}

# The systemd oneshot has no psu launch record. ptool otherwise falls back to
# su-loopback, which the identity kernel cannot authorize for dev:restart.
# Reuse the installer's persistent machine client identity for this first-party
# service; preserve a real session SID when one was explicitly supplied.
resolve_ptool_client_sid() {
  if [ -n "${PAPERCUSP_SID:-}" ]; then
    printf '%s\n' "$PAPERCUSP_SID"
    return 0
  fi
  [ -n "${HOME:-}" ] || return 1
  local identity_file="$HOME/.papercusp/su-agent-id" machine_sid
  [ -f "$identity_file" ] && [ -r "$identity_file" ] || return 1
  machine_sid="$(<"$identity_file")"
  [[ "$machine_sid" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || return 1
  printf '%s\n' "$machine_sid"
}

# Select the control endpoint before dispatch. A failed staging boot cannot
# receive its own recovery request. Keep this local, preserve the same client
# identity, and never retry a dispatched mutation through another operator.
resolve_staging_restart_control_url() {
  local candidate seen='|' local_origin_pattern control_reply
  local_origin_pattern='^http://(127[.]0[.]0[.]1|localhost|\[::1\]):[0-9]+/?$'
  for candidate in "http://127.0.0.1:${STAGING_PORT:-3170}" "${PAPERCUSP_OPERATOR_URL:-}" 'http://127.0.0.1:3271' 'http://127.0.0.1:3070'; do
    [[ "$candidate" =~ $local_origin_pattern ]] || continue
    candidate="${candidate%/}"
    [[ "$seen" == *"|$candidate|"* ]] && continue
    seen+="$candidate|"
    # Health alone can belong to a legacy operator whose MCP catalog cannot
    # dispatch this tool. Use the SAME identity for a bounded read-only preview;
    # no restart has been dispatched while another candidate is considered.
    if curl --fail --silent --connect-timeout 2 --max-time 3 --output /dev/null "$candidate/api/health" &&
       control_reply="$(timeout 30 env PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url="$candidate" --json - <<'JSON'
{"target":"staging","confirm":false}
JSON
)" && node -e '
      let value;
      try { value = JSON.parse(require("node:fs").readFileSync(0, "utf8")); }
      catch { process.exit(1); }
      process.exit(value?.ok === true && value?.dry_run === true && value?.target === "staging" ? 0 : 1);
    ' <<< "$control_reply"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' 'FATAL: no compatible local operator can receive the coordinated staging restart' >&2
  return 1
}

PTOOL_CLIENT_SID="$(resolve_ptool_client_sid)" || {
  log "FATAL: coordinated dev:restart requires PAPERCUSP_SID or the installer's valid machine identity at \$HOME/.papercusp/su-agent-id"
  exit 1
}

# All checkout mutation and bundle work is complete. Downgrade the held
# exclusive lock to shared before the final dev:restart: restart's nonblocking
# shared-lock probe now admits this sync-owned cutover, while this process keeps
# excluding a new staging-sync until exact-source readiness is verified.
STAGING_SYNC_SHARED_WAIT_START_MS="$(staging_lock_now_ms)"
staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_wait_start phase=final-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS" || true
if staging_sync_lock_shared; then
  STAGING_SYNC_SHARED_END_MS="$(staging_lock_now_ms)"
  staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_acquired phase=final-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS wait_elapsed_ms=$(staging_lock_elapsed_ms "$STAGING_SYNC_SHARED_WAIT_START_MS" "$STAGING_SYNC_SHARED_END_MS") acquisition_outcome=acquired" || true
else
  STAGING_SYNC_SHARED_RC=$?
  STAGING_SYNC_SHARED_END_MS="$(staging_lock_now_ms)"
  STAGING_SYNC_HOLDER="$(staging_lock_holder_fields "$STAGING_SYNC_LOCK_PATH" shared)"
  staging_lock_log "event=transition surface=staging-sync attempt_id=$STAGING_SYNC_ATTEMPT_ID state=shared_failed phase=final-restart lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=shared wait_start_ms=$STAGING_SYNC_SHARED_WAIT_START_MS wait_elapsed_ms=$(staging_lock_elapsed_ms "$STAGING_SYNC_SHARED_WAIT_START_MS" "$STAGING_SYNC_SHARED_END_MS") acquisition_outcome=failed command_exit_status=$STAGING_SYNC_SHARED_RC $STAGING_SYNC_HOLDER" || true
  log "FATAL: could not downgrade the staging-sync checkout lock for final restart"
  exit "$STAGING_SYNC_SHARED_RC"
fi

RESTART_CONTROL_URL="$(resolve_staging_restart_control_url)" || exit 1

# The ptool result may be lost when staging itself receives the request.
log "requesting coordinated restart of $UNIT via dev:restart (git_sync_drain_sec=${GIT_SYNC_DRAIN_SEC})"
restart_result_file="$(mktemp)"
restart_diagnostics_file="$(mktemp)"
restart_tool_timeout_sec=350
restart_tool_started_at="$(date +%s)"
restart_tool_status=0
restart_verified=0
restart_pending=0
# Prefer staging's current identity kernel while it is healthy; a failed boot
# uses another healthy local operator and still must pass its authorization.
# Run ptool in the background so this service can observe :3170 restarting. The
# handler may restart the server that owns its HTTP stream, so a lost receipt is
# resolved by MainPID + exact-source proof instead of waiting out ptool's 345s
# client deadline or retrying the mutation.
(
  cd "$INTEGRATION_ROOT"
  exec env PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url="$RESTART_CONTROL_URL" --json -
) >"$restart_result_file" 2>"$restart_diagnostics_file" <<JSON &
{"target":"staging","confirm":true,"authorize":true,"git_sync_drain_sec":${GIT_SYNC_DRAIN_SEC},"reason":"staging-sync advanced ${current:0:8} to ${target:0:8}"}
JSON
restart_tool_pid=$!

while staging_sync_process_running "$restart_tool_pid"; do
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  observed_health_sha="$(staging_health_source_sha || true)"
  if staging_restart_is_observed "$main_pid" "$observed_main_pid" "$observed_health_sha" "$target"; then
    # Give the CLI a short chance to flush a normal receipt before closing the
    # stale client stream. The exact PID + SHA pair is the independent proof.
    sleep 2
    if staging_sync_process_running "$restart_tool_pid"; then
      restart_verified=1
      log "dev:restart stream stayed open after :$STAGING_PORT restarted; MainPID $observed_main_pid serves exact source $observed_health_sha, so terminating only the ptool client"
      kill -TERM "$restart_tool_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$restart_tool_pid" 2>/dev/null || true
      break
    fi
  fi

  restart_tool_elapsed_sec=$(( $(date +%s) - restart_tool_started_at ))
  if [ "$restart_tool_elapsed_sec" -ge "$restart_tool_timeout_sec" ]; then
    log "dev:restart client exceeded $restart_tool_timeout_sec s without exact target proof; terminating the ptool client"
    kill -TERM "$restart_tool_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$restart_tool_pid" 2>/dev/null || true
    break
  fi
  sleep 2
done

if wait "$restart_tool_pid"; then
  restart_tool_status=0
else
  restart_tool_status=$?
fi
# ptool exits 5 when the tool ANSWERED ok:false (EI-24654733539966460). That is
# a delivered terminal receipt, not a missing one: fold it into the success
# status so the business-level refusal branches below judge the result body.
[ "$restart_tool_status" -ne 5 ] || restart_tool_status=0
restart_result="$(cat "$restart_result_file" 2>/dev/null || true)"
restart_diagnostics="$(cat "$restart_diagnostics_file" 2>/dev/null || true)"
rm -f "$restart_result_file" "$restart_diagnostics_file"

# Close the race where ptool exits as the new listener becomes ready.
if [ "$restart_verified" -ne 1 ]; then
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  observed_health_sha="$(staging_health_source_sha || true)"
  if staging_restart_is_observed "$main_pid" "$observed_main_pid" "$observed_health_sha" "$target"; then
    restart_verified=1
  fi
fi

# ptool exits successfully for a business-level refusal (its exit 5 is folded to 0
# above), so inspect the result rather than treating process status as the verdict. A verified coalesce is a
# success: another recent restart already cycled the same service and the
# cooldown prevents a redundant outage.
restart_failure_detail="$restart_result $restart_diagnostics"
if [ "${#restart_failure_detail}" -gt 3000 ]; then
  restart_failure_detail="${restart_failure_detail: -3000}"
fi
if [ "$restart_verified" -eq 1 ]; then
  log "coordinated dev:restart independently verified: MainPID $observed_main_pid serves exact source $observed_health_sha"
elif [ "$restart_tool_status" -ne 0 ] && restart_result_is_pre_dispatch_refusal "$restart_result $restart_diagnostics"; then
  log "FATAL: coordinated dev:restart was refused before dispatch: ${restart_result:0:250} ${restart_diagnostics:0:250}"
  exit 1
elif [ "$restart_tool_status" -ne 0 ] && printf '%s' "$restart_result $restart_diagnostics" | grep -Eq '"reason"[[:space:]]*:[[:space:]]*"resource_drain_timeout"'; then
  # MCP error results are printed to stderr by ptool (exit 1), including a
  # delivered drain refusal. No restart was scheduled; waiting for health here
  # hides the blocking lease and can never make the target source appear.
  log "FATAL: coordinated dev:restart resource drain was refused; no restart scheduled: $restart_failure_detail"
  exit 1
elif [ "$restart_tool_status" -ne 0 ]; then
  log "coordinated dev:restart returned no terminal receipt (exit $restart_tool_status); waiting for exact target health before deciding; diagnostics: $restart_failure_detail"
elif printf '%s' "$restart_result" | restart_result_is_pending; then
  restart_pending=1
  log "coordinated dev:restart is scheduled but not yet observed; waiting for a new MainPID and exact target health"
elif ! printf '%s' "$restart_result" | restart_result_is_accepted; then
  # EI-22102474093310851: a git-sync coordination refusal that OUTLASTS the drain
  # above is still transient — git-sync runs continuously on this tree, so the very
  # next 5-minute tick usually gets through. The checkout is ALREADY fast-forwarded
  # at this point; only the restart is outstanding. Treat it the way this script
  # already treats its other transient blocks (the flock skip, the recent-restart
  # grace, the live-client deferral): log and exit 0 instead of failing the unit.
  #
  # BOUNDED, so this can never hide a genuinely stuck barrier: it defers only while
  # the build :3170 is SERVING is younger than MAX_STALE_SEC — the same ceiling and
  # the same current_commit_age_sec() the live-client deferral uses. Past it the
  # refusal is FATAL again and the unit fails loudly, which is the whole point: a
  # persistent barrier means :3170 is silently serving stale code and somebody must
  # look. An unresolvable sha reports a huge age, so it escalates rather than defers.
  if printf '%s' "$restart_result" | restart_refusal_is_transient_git_sync; then
    age="$(current_commit_age_sec "$served_sha")"
    if [ "$age" -lt "$MAX_STALE_SEC" ] 2>/dev/null; then
      log "deferring restart — dev:restart refused on a transient git-sync barrier/collision that outlasted the ${GIT_SYNC_DRAIN_SEC}s drain, and the served build is only ${age}s old (< ${MAX_STALE_SEC}s ceiling). The checkout is already fast-forwarded to ${target:0:8}; the next tick will restart. Refusal: ${restart_result:0:300}"
      exit 0
    fi
    log "staleness ceiling reached (${age}s ≥ ${MAX_STALE_SEC}s) with dev:restart STILL refused on a git-sync barrier/collision — escalating instead of deferring again"
  fi
  log "FATAL: coordinated dev:restart was refused or returned an invalid result: ${restart_result:0:500}"
  exit 1
else
  log "coordinated dev:restart accepted: ${restart_result:0:500}"
fi

last_health_sha=""
readiness_started_at="$(date +%s)"
readiness_elapsed_sec=0
while [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ]; do
  last_health_sha="$(staging_health_source_sha || true)"
  observed_main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  if health_sha_matches_target "$last_health_sha" "$target" &&
     { [ "$restart_pending" -eq 0 ] || staging_restart_is_observed "$main_pid" "$observed_main_pid" "$last_health_sha" "$target"; }; then
    log "✅ :3170 healthy on exact staging source ${last_health_sha}"
    exit 0
  fi
  readiness_elapsed_sec=$(( $(date +%s) - readiness_started_at ))
  [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ] || break
  sleep 2
done
log "⚠ :3170 did not report target source ${target:0:10} within ${READINESS_TIMEOUT_SEC}s after restart (last=${last_health_sha:-unavailable}) — check the operator journal"
exit 1
