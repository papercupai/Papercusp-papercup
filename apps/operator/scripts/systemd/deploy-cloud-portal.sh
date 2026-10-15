#!/usr/bin/env bash
# Install and safely hand off the Cloud Portal's Next.js backend.
#
# The portal is a separate, user-owned checkout. This helper is the only
# supported path for turning the checked-in unit template into a user service:
# it validates the checkout and executable, verifies the rendered unit, writes
# it with an atomic rename, refreshes the versioned :3081 proxy program, and
# never stops or restarts the separate :3081 proxy unit.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${PAPERCUSP_CLOUD_PORTAL_TEMPLATE:-$SCRIPT_DIR/papercusp-cloud-portal.service.in}"
RECONCILE_SERVICE_TEMPLATE="$SCRIPT_DIR/papercusp-cloud-portal-reconcile.service.in"
RECONCILE_TIMER_TEMPLATE="$SCRIPT_DIR/papercusp-cloud-portal-reconcile.timer.in"
RECONCILE_SERVICE="papercusp-cloud-portal-reconcile.service"
RECONCILE_TIMER="papercusp-cloud-portal-reconcile.timer"
PROXY_SOURCE="${PAPERCUSP_CLOUD_PORTAL_PROXY_SOURCE:-$SCRIPT_DIR/papercusp-cloud-portal-proxy.mjs}"
LAUNCHER_SOURCE="${PAPERCUSP_CLOUD_PORTAL_LAUNCHER_SOURCE:-$SCRIPT_DIR/portal-hosted-launcher.ts}"

: "${HOME:?HOME must be set for the user-service deployment}"

PORTAL_ROOT="${PAPERCUSP_CLOUD_PORTAL_ROOT:-$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal}"
PORTAL_RUNTIME_ROOT="${PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT:-$(dirname -- "$PORTAL_ROOT")/.portal-runtime/$(basename -- "$PORTAL_ROOT")}"
PORTAL_PORT="${PAPERCUSP_CLOUD_PORTAL_PORT:-3801}"
NODE_BIN="${PAPERCUSP_CLOUD_PORTAL_NODE:-$HOME/.local/node25/bin/node}"
UNIT_NAME="${PAPERCUSP_CLOUD_PORTAL_UNIT:-papercusp-cloud-portal.service}"
UNIT_DIR="${PAPERCUSP_CLOUD_PORTAL_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
TEMP_DIR="${PAPERCUSP_CLOUD_PORTAL_TMPDIR:-${TMPDIR:-/tmp}}"
TEMP_DIR_EXPLICIT=0
[[ -n "${PAPERCUSP_CLOUD_PORTAL_TMPDIR:-}" ]] && TEMP_DIR_EXPLICIT=1
SYSTEMCTL_BIN="${PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL:-systemctl}"
SYSTEMD_ANALYZE_BIN="${PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE:-systemd-analyze}"
CURL_BIN="${PAPERCUSP_CLOUD_PORTAL_CURL:-curl}"
SS_BIN="${PAPERCUSP_CLOUD_PORTAL_SS:-ss}"
PS_BIN="${PAPERCUSP_CLOUD_PORTAL_PS:-ps}"
READLINK_BIN="${PAPERCUSP_CLOUD_PORTAL_READLINK:-readlink}"
KILL_BIN="${PAPERCUSP_CLOUD_PORTAL_KILL:-kill}"
GIT_BIN="${PAPERCUSP_CLOUD_PORTAL_GIT:-git}"
DATE_BIN="${PAPERCUSP_CLOUD_PORTAL_DATE:-date}"
ALLOW_STALE_RELEASE="${PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE:-0}"
HEALTH_PATH="${PAPERCUSP_CLOUD_PORTAL_HEALTH_PATH:-/}"
HEALTH_WAIT_SEC="${PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC:-60}"
CURL_TIMEOUT_SEC="${PAPERCUSP_CLOUD_PORTAL_CURL_TIMEOUT_SEC:-5}"
PORT_RELEASE_WAIT_SEC="${PAPERCUSP_CLOUD_PORTAL_PORT_RELEASE_WAIT_SEC:-30}"
FALLBACK_LOG="${PAPERCUSP_CLOUD_PORTAL_FALLBACK_LOG:-$HOME/.papercusp/logs/cloud-portal-legacy.log}"
PROXY_INSTALL="${PAPERCUSP_CLOUD_PORTAL_PROXY_INSTALL:-$HOME/.local/bin/papercusp-cloud-portal-proxy.mjs}"
LAUNCHER_INSTALL="${PAPERCUSP_CLOUD_PORTAL_LAUNCHER_INSTALL:-$HOME/.local/bin/papercusp-cloud-portal-launcher.ts}"
INTEGRATION_ROOT="${PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT:-$(cd -- "$SCRIPT_DIR/../../../.." && pwd)}"
HOSTED_ENV_FILE="${PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/papercusp/hosted-control-plane.env}"
OPERATOR_ENV_FILE="${PAPERCUSP_CLOUD_PORTAL_OPERATOR_ENV_FILE:-$INTEGRATION_ROOT/apps/operator/.env.local}"
TSX_BIN="${PAPERCUSP_CLOUD_PORTAL_TSX:-$INTEGRATION_ROOT/node_modules/.bin/tsx}"
PROC_ROOT="${PAPERCUSP_CLOUD_PORTAL_PROC_ROOT:-/proc}"

MODE="install"
TEMP_PATH=""

log() {
  printf 'cloud-portal: %s\n' "$*"
}

die() {
  printf 'cloud-portal: ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy-cloud-portal.sh [--render-only|--install-only|--handoff]

  --render-only  validate inputs and print the rendered unit; do not write or
                 call systemd
  --install-only atomically install, verify, reload, and enable the unit; do
                 not start it or touch the existing backend
  --handoff      install the unit, then cut the validated :3801 listener over
                 to systemd with health-checked rollback on failure

Environment overrides:
  PAPERCUSP_CLOUD_PORTAL_ROOT, PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT,
  PAPERCUSP_CLOUD_PORTAL_PORT,
  PAPERCUSP_CLOUD_PORTAL_NODE, PAPERCUSP_CLOUD_PORTAL_UNIT_DIR,
  PAPERCUSP_CLOUD_PORTAL_TMPDIR,
  PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL, PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE,
  PAPERCUSP_CLOUD_PORTAL_CURL, PAPERCUSP_CLOUD_PORTAL_HEALTH_PATH,
  PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC, PAPERCUSP_CLOUD_PORTAL_GIT,
  PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE,
  PAPERCUSP_CLOUD_PORTAL_PROXY_SOURCE, PAPERCUSP_CLOUD_PORTAL_PROXY_INSTALL,
  PAPERCUSP_CLOUD_PORTAL_LAUNCHER_SOURCE, PAPERCUSP_CLOUD_PORTAL_LAUNCHER_INSTALL,
  PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT, PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE,
  PAPERCUSP_CLOUD_PORTAL_OPERATOR_ENV_FILE
EOF
}

while (($#)); do
  case "$1" in
    --render-only) MODE=render ;;
    --install|--install-only) MODE=install ;;
    --handoff) MODE=handoff ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

require_absolute() {
  local label=$1 value=$2
  [[ "$value" == /* ]] || die "$label must be an absolute path: $value"
}

require_uint_range() {
  local label=$1 value=$2 min=$3 max=$4
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label must be an integer: $value"
  ((10#$value >= min && 10#$value <= max)) || die "$label must be between $min and $max: $value"
}

validate_inputs() {
  require_absolute PORTAL_ROOT "$PORTAL_ROOT"
  require_absolute PORTAL_RUNTIME_ROOT "$PORTAL_RUNTIME_ROOT"
  require_absolute NODE_BIN "$NODE_BIN"
  require_absolute UNIT_DIR "$UNIT_DIR"
  require_absolute TEMP_DIR "$TEMP_DIR"
  require_absolute PROC_ROOT "$PROC_ROOT"
  require_absolute PROXY_SOURCE "$PROXY_SOURCE"
  require_absolute PROXY_INSTALL "$PROXY_INSTALL"
  require_absolute LAUNCHER_SOURCE "$LAUNCHER_SOURCE"
  require_absolute LAUNCHER_INSTALL "$LAUNCHER_INSTALL"
  require_absolute INTEGRATION_ROOT "$INTEGRATION_ROOT"
  require_absolute HOSTED_ENV_FILE "$HOSTED_ENV_FILE"
  require_absolute OPERATOR_ENV_FILE "$OPERATOR_ENV_FILE"
  require_absolute TSX_BIN "$TSX_BIN"
  [[ -f "$TEMPLATE" ]] || die "unit template is missing: $TEMPLATE"
  [[ -f "$RECONCILE_SERVICE_TEMPLATE" && -f "$RECONCILE_TIMER_TEMPLATE" ]] ||
    die "portal reconcile unit templates are missing"
  [[ -f "$PROXY_SOURCE" ]] || die "portal proxy source is missing: $PROXY_SOURCE"
  [[ -f "$LAUNCHER_SOURCE" ]] || die "portal hosted launcher source is missing: $LAUNCHER_SOURCE"
  [[ -f "$HOSTED_ENV_FILE" ]] || die "hosted env file is missing: $HOSTED_ENV_FILE"
  [[ -x "$TSX_BIN" ]] || die "tsx executable is not executable: $TSX_BIN"
  [[ -d "$PORTAL_ROOT" ]] || die "portal root is not a directory: $PORTAL_ROOT"
  [[ -f "$PORTAL_ROOT/package.json" ]] || die "portal package.json is missing: $PORTAL_ROOT/package.json"
  [[ -x "$NODE_BIN" ]] || die "Node executable is not executable: $NODE_BIN"

  NEXT_BIN="$PORTAL_ROOT/node_modules/.bin/next"
  [[ -x "$NEXT_BIN" ]] || die "Next executable is not executable: $NEXT_BIN"
  START_WEB="$PORTAL_ROOT/scripts/start-web.mjs"
  CURRENT_RELEASE_LINK="$PORTAL_RUNTIME_ROOT/current"
  CURRENT_STANDALONE_ENTRY="$CURRENT_RELEASE_LINK/standalone-entry.mjs"
  [[ -f "$START_WEB" ]] || die "portal runtime launcher is missing: $START_WEB"
  [[ -f "$CURRENT_STANDALONE_ENTRY" ]] ||
    die "portal production artifact is missing: $CURRENT_STANDALONE_ENTRY (run npm run build first)"
  CURRENT_RELEASE_REAL="$("$READLINK_BIN" -f "$CURRENT_RELEASE_LINK" 2>/dev/null || true)"
  [[ -n "$CURRENT_RELEASE_REAL" && -d "$CURRENT_RELEASE_REAL" ]] ||
    die "portal current release link is invalid: $CURRENT_RELEASE_LINK"
  NODE_DIR="$(dirname -- "$NODE_BIN")"

  require_uint_range PORTAL_PORT "$PORTAL_PORT" 1 65535
  require_uint_range HEALTH_WAIT_SEC "$HEALTH_WAIT_SEC" 0 600
  require_uint_range CURL_TIMEOUT_SEC "$CURL_TIMEOUT_SEC" 1 120
  require_uint_range PORT_RELEASE_WAIT_SEC "$PORT_RELEASE_WAIT_SEC" 1 300
  [[ "$UNIT_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "invalid user unit name: $UNIT_NAME"

  # These values become systemd syntax. Reject control bytes and specifier
  # markers rather than allowing a path to alter a unit's meaning.
  for value in "$PORTAL_ROOT" "$PORTAL_RUNTIME_ROOT" "$NODE_BIN" "$NEXT_BIN" "$START_WEB" "$CURRENT_RELEASE_LINK" "$NODE_DIR" "$PROXY_SOURCE" "$PROXY_INSTALL" "$LAUNCHER_SOURCE" "$LAUNCHER_INSTALL" "$INTEGRATION_ROOT" "$HOSTED_ENV_FILE" "$OPERATOR_ENV_FILE" "$TSX_BIN"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *%* ]] ||
      die "portal paths may not contain newlines or systemd '%' specifiers"
  done
}

# Escape one systemd unit word. Unlike shell quoting, systemd uses backslash
# escapes and does not invoke a shell for ExecStart.
unit_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value// /\\ }
  value=${value//$'\t'/\\$'\t'}
  printf '%s' "$value"
}

render_unit() {
  local template="${1:-$TEMPLATE}"
  local root runtime_root node next start_web node_dir launcher integration_root hosted_env operator_env tsx
  root="$(unit_escape "$PORTAL_ROOT")"
  runtime_root="$(unit_escape "$PORTAL_RUNTIME_ROOT")"
  node="$(unit_escape "$NODE_BIN")"
  next="$(unit_escape "$NEXT_BIN")"
  start_web="$(unit_escape "$START_WEB")"
  node_dir="$(unit_escape "$NODE_DIR")"
  launcher="$(unit_escape "$LAUNCHER_INSTALL")"
  integration_root="$(unit_escape "$INTEGRATION_ROOT")"
  hosted_env="$(unit_escape "$HOSTED_ENV_FILE")"
  operator_env="$(unit_escape "$OPERATOR_ENV_FILE")"
  tsx="$(unit_escape "$TSX_BIN")"

  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line//@PORT@/$PORTAL_PORT}
    line=${line//@PORTAL_ROOT@/$root}
    line=${line//@RUNTIME_ROOT@/$runtime_root}
    line=${line//@NODE@/$node}
    line=${line//@NEXT_BIN@/$next}
    line=${line//@START_WEB@/$start_web}
    line=${line//@NODE_DIR@/$node_dir}
    line=${line//@LAUNCHER@/$launcher}
    line=${line//@INTEGRATION_ROOT@/$integration_root}
    line=${line//@HOSTED_ENV_FILE@/$hosted_env}
    line=${line//@OPERATOR_ENV_FILE@/$operator_env}
    line=${line//@TSX@/$tsx}
    printf '%s\n' "$line"
  done < "$template"
}

verify_unit_path() {
  [[ -x "$(command -v "$SYSTEMD_ANALYZE_BIN" 2>/dev/null || true)" ]] ||
    die "systemd-analyze is required to verify the rendered unit"
  "$SYSTEMD_ANALYZE_BIN" verify "$1" >/dev/null
}

cleanup_temp() {
  if [[ -n "$TEMP_PATH" && -e "$TEMP_PATH" ]]; then
    rm -f -- "$TEMP_PATH"
  fi
}
trap cleanup_temp EXIT

install_proxy_script() {
  local proxy_dir proxy_tmp
  proxy_dir="$(dirname -- "$PROXY_INSTALL")"
  mkdir -p -- "$proxy_dir"
  if [[ -f "$PROXY_INSTALL" ]] && cmp -s -- "$PROXY_SOURCE" "$PROXY_INSTALL"; then
    return 0
  fi
  proxy_tmp="$(mktemp "$proxy_dir/.papercusp-cloud-portal-proxy.XXXXXX.mjs")"
  cp -- "$PROXY_SOURCE" "$proxy_tmp"
  chmod 0755 "$proxy_tmp"
  mv -f -- "$proxy_tmp" "$PROXY_INSTALL"
  log "installed portal proxy program at $PROXY_INSTALL (restart papercusp-cloud-portal-3081.service to activate a changed program)"
}

install_launcher() {
  local launcher_dir launcher_tmp
  launcher_dir="$(dirname -- "$LAUNCHER_INSTALL")"
  mkdir -p -- "$launcher_dir"
  if [[ -f "$LAUNCHER_INSTALL" ]] && cmp -s -- "$LAUNCHER_SOURCE" "$LAUNCHER_INSTALL"; then
    return 0
  fi
  launcher_tmp="$(mktemp "$launcher_dir/.papercusp-cloud-portal-launcher.XXXXXX.ts")"
  cp -- "$LAUNCHER_SOURCE" "$launcher_tmp"
  chmod 0755 "$launcher_tmp"
  mv -f -- "$launcher_tmp" "$LAUNCHER_INSTALL"
  log "installed hosted portal launcher at $LAUNCHER_INSTALL"
}

install_unit() {
  install_launcher
  mkdir -p -- "$UNIT_DIR"
  if [[ ! -d "$TEMP_DIR" ]]; then
    mkdir -p -- "$TEMP_DIR"
  fi
  if [[ "$(stat -c '%d' "$TEMP_DIR")" != "$(stat -c '%d' "$UNIT_DIR")" ]]; then
    if ((TEMP_DIR_EXPLICIT)); then
      die "temporary directory and user-unit directory must be on the same filesystem"
    fi
    # Some Linux hosts mount /tmp as tmpfs while ~/.config is on the home
    # filesystem. Keep the default convenient there without sacrificing mv's
    # atomic same-filesystem guarantee.
    TEMP_DIR="/var/tmp"
  fi
  # The destination is protected by the external file lock, but a random
  # sibling under ~/.config would be a different lock key on the hook path.
  # Stage outside HOME, then rename into the locked destination. /tmp and the
  # user config directory share the host filesystem in the supported install
  # layout, so mv remains an atomic replacement rather than a copy fallback.
  [[ "$(stat -c '%d' "$TEMP_DIR")" == "$(stat -c '%d' "$UNIT_DIR")" ]] ||
    die "temporary directory and user-unit directory must be on the same filesystem"
  # Keep the .service suffix: systemd-analyze derives the unit type from the
  # filename and rejects a suffix-less temporary path before parsing content.
  TEMP_PATH="$(mktemp "$TEMP_DIR/.${UNIT_NAME}.tmp.XXXXXX.service")"
  render_unit > "$TEMP_PATH"
  chmod 0644 "$TEMP_PATH"
  verify_unit_path "$TEMP_PATH"
  mv -f -- "$TEMP_PATH" "$UNIT_DIR/$UNIT_NAME"
  TEMP_PATH=""
  install_proxy_script
}

systemctl_user() {
  "$SYSTEMCTL_BIN" --user "$@"
}

reload_and_enable() {
  systemctl_user daemon-reload
  systemctl_user enable "$UNIT_NAME"
}

install_reconcile_units() {
  local name template temp
  for name in "$RECONCILE_SERVICE" "$RECONCILE_TIMER"; do
    if [[ "$name" == "$RECONCILE_SERVICE" ]]; then
      template="$RECONCILE_SERVICE_TEMPLATE"
    else
      template="$RECONCILE_TIMER_TEMPLATE"
    fi
    temp="$(mktemp "$TEMP_DIR/.${name}.tmp.XXXXXX.${name##*.}")"
    render_unit "$template" > "$temp"
    chmod 0644 "$temp"
    if ! verify_unit_path "$temp"; then
      rm -f -- "$temp"
      return 1
    fi
    mv -f -- "$temp" "$UNIT_DIR/$name"
  done
  systemctl_user daemon-reload
  systemctl_user enable --now "$RECONCILE_TIMER"
}

health_check() {
  local port=$1
  # A refused connection during a restart is an expected, transient probe
  # result. Keep curl quiet here; wait_for_health emits one actionable line
  # only after the bounded retry window is exhausted.
  "$CURL_BIN" --fail --silent --max-time "$CURL_TIMEOUT_SEC" \
    "http://127.0.0.1:${port}${HEALTH_PATH}" >/dev/null 2>/dev/null
}

wait_for_health() {
  local port=$1 attempts=$((HEALTH_WAIT_SEC + 1)) total_attempts=$((HEALTH_WAIT_SEC + 1))
  while ((attempts > 0)); do
    if health_check "$port"; then
      return 0
    fi
    attempts=$((attempts - 1))
    ((attempts > 0)) && sleep 1
  done
  printf 'cloud-portal: ERROR: health check failed for http://127.0.0.1:%s%s after %d attempt(s)\n' \
    "$port" "$HEALTH_PATH" "$total_attempts" >&2
  return 1
}

start_managed() {
  systemctl_user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  systemctl_user start "$UNIT_NAME" || return 1
  wait_for_health "$PORTAL_PORT"
}

# The release `current` names is launched by its own standalone-entry.mjs, which
# embeds the SOURCE CHECKOUT it was built from. Sibling snapshot checkouts
# (portal-p016-snap, portal-p018-snap, portal-checkpoint) publish into this SAME
# production release root, so `current` can resolve to a perfectly valid
# directory while naming a build of a throwaway tree. The pre-existing checks
# above only prove `current` is *a directory*; nothing proved it was built from
# $PORTAL_ROOT. Handing off onto a snapshot build restarts the owner's live
# portal on a checkout that may be deleted underneath it (EI-22123385977067109,
# observed twice on 2026-09-02 from independent lanes).
current_release_entry_rel() {
  sed -n 's/.*join(root, "\([^"]*\)").*/\1/p' "$CURRENT_STANDALONE_ENTRY" 2>/dev/null | head -1
}

require_production_current_release() {
  local entry_rel
  entry_rel="$(current_release_entry_rel)"
  if [[ -z "$entry_rel" ]]; then
    die "cannot determine which checkout $CURRENT_RELEASE_REAL was built from: no entry path in $CURRENT_STANDALONE_ENTRY; refusing handoff"
  fi
  if [[ "$HOME/$entry_rel" == "$PORTAL_ROOT/server.js" || "$entry_rel" == "${PORTAL_ROOT#/}/server.js" ]]; then
    return 0
  fi
  log "refusing handoff: portal 'current' release was built from a NON-PRODUCTION checkout"
  log "  current  -> $CURRENT_RELEASE_REAL"
  log "  spawns   -> \$HOME/$entry_rel"
  log "  expected -> $PORTAL_ROOT/server.js"
  die "portal current release is a foreign-checkout build; re-point current at a release built from $PORTAL_ROOT, then retry (EI-22123385977067109)"
}

# `current` is immutable once built, but $PORTAL_ROOT keeps changing after
# every publish. A `current` that is present, valid, and built from
# $PORTAL_ROOT (the checks above) can still be a build of source that is hours
# or days old: every gate above passes and the handoff cuts over to the wrong
# code, with no error anywhere. Compare the release's recorded `publishedAt`
# against how recently $PORTAL_ROOT's source has actually moved (its HEAD
# commit time, or "now" if the working tree is dirty) and refuse a cutover
# that looks stale. A pure age threshold is not enough — an intentionally-old
# `current` (a deliberate rollback) must still deploy cleanly — so this checks
# whether the SOURCE has moved since the build, not how old the build is, and
# ships an explicit override for that rollback case (WI-2141210).
#
# PREFERRED evidence is CONTENT, not git state (EI-22388584299827941): on a
# git-sync'd checkout "uncommitted changes" and "a commit newer than the release"
# measure the sweep cadence, not the artifact — a release built from the working
# tree seconds ago read as STALE, so every routine deploy carried the rollback
# override and the check protected nothing. `publishStandaloneRuntime()` now
# stamps the build's source-tree digest into `.papercusp-release.json` as
# `sourceRootDigest`, and `scripts/release-source-digest.mjs` recomputes the same
# digest for the checkout: identical ⇒ the checkout IS this release's source ⇒
# fresh, whatever git says; different ⇒ stale. The git heuristic below is the
# FALLBACK for releases published before the digest existed (or when the digest
# cannot be computed), so older releases keep their original contract.
require_fresh_current_release() {
  local manifest="$CURRENT_RELEASE_REAL/.papercusp-release.json"
  if [[ ! -f "$manifest" ]]; then
    log "current release has no .papercusp-release.json; cannot verify staleness, proceeding"
    return 0
  fi
  if ! "$GIT_BIN" -C "$PORTAL_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "$PORTAL_ROOT is not a git checkout; cannot verify release staleness, proceeding"
    return 0
  fi

  local published_at
  published_at="$(sed -n 's/.*"publishedAt": *"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  if [[ -z "$published_at" ]]; then
    log "current release manifest has no publishedAt field; cannot verify staleness, proceeding"
    return 0
  fi
  local published_epoch
  published_epoch="$("$DATE_BIN" -d "$published_at" +%s 2>/dev/null || true)"
  if [[ -z "$published_epoch" ]]; then
    log "cannot parse release publishedAt '$published_at'; cannot verify staleness, proceeding"
    return 0
  fi

  local reason=""

  # Content digest first. Only a manifest that carries one, AND a checkout that
  # ships the digest CLI, can be judged this way; anything else falls through to
  # the git heuristic below with a log line saying why.
  local release_digest
  release_digest="$(sed -n 's/.*"sourceRootDigest": *"\([0-9a-fA-F]*\)".*/\1/p' "$manifest" | head -1)"
  local digest_cli="$PORTAL_ROOT/scripts/release-source-digest.mjs"
  if [[ -n "$release_digest" && -f "$digest_cli" ]]; then
    local checkout_digest=""
    checkout_digest="$("$NODE_BIN" "$digest_cli" "$PORTAL_ROOT" 2>/dev/null | head -1 || true)"
    if [[ "$checkout_digest" =~ ^[0-9a-fA-F]{16,}$ ]]; then
      if [[ "${checkout_digest,,}" == "${release_digest,,}" ]]; then
        log "current release source digest matches $PORTAL_ROOT (${release_digest:0:12}…); fresh"
        return 0
      fi
      reason="$PORTAL_ROOT source digest ${checkout_digest:0:12}… differs from the release's ${release_digest:0:12}… (built $published_at)"
    else
      log "could not compute the $PORTAL_ROOT source digest via $digest_cli; falling back to git history"
    fi
  fi

  if [[ -z "$reason" ]]; then
    local head_iso head_epoch=""
    head_iso="$("$GIT_BIN" -C "$PORTAL_ROOT" log -1 --format=%cI HEAD 2>/dev/null || true)"
    [[ -n "$head_iso" ]] && head_epoch="$("$DATE_BIN" -d "$head_iso" +%s 2>/dev/null || true)"

    local dirty=0
    [[ -n "$("$GIT_BIN" -C "$PORTAL_ROOT" status --porcelain 2>/dev/null)" ]] && dirty=1

    if [[ -n "$head_epoch" ]] && ((head_epoch > published_epoch)); then
      reason="$PORTAL_ROOT has a commit newer than the release (built $published_at)"
    fi
    if ((dirty)); then
      reason="${reason:+$reason; }$PORTAL_ROOT has uncommitted changes"
    fi
  fi
  [[ -n "$reason" ]] || return 0

  if [[ "$ALLOW_STALE_RELEASE" == "1" ]]; then
    log "WARNING: current release looks STALE ($reason) — proceeding: PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1"
    return 0
  fi
  die "portal current release looks STALE: $reason. Rebuild and republish from $PORTAL_ROOT, or set PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1 to deploy anyway (e.g. a deliberate rollback)."
}

managed_unit_runs_current_artifact() {
  local main_pid arg current_real
  main_pid="$(systemctl_user show "$UNIT_NAME" --property=MainPID --value 2>/dev/null || true)"
  [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" != 0 && -r "$PROC_ROOT/$main_pid/cmdline" ]] || return 1

  current_real="$("$READLINK_BIN" -f "$CURRENT_RELEASE_LINK" 2>/dev/null || true)"
  [[ -n "$current_real" ]] || return 1

  # The hosted launcher can be MainPID, with start-web below it. Track the
  # start-web proof separately for each lineage: a current-release sibling
  # outside that lineage cannot validate the serving artifact.
  local -a frontier=("$main_pid")
  local -a frontier_launchers=(0)
  local -a next_frontier=()
  local -a next_launchers=() children=()
  local depth index pid child cwd saw_launcher
  for depth in 0 1 2 3 4 5 6; do
    next_frontier=()
    next_launchers=()
    for index in "${!frontier[@]}"; do
      pid=${frontier[$index]}
      saw_launcher=${frontier_launchers[$index]}
      if [[ -r "$PROC_ROOT/$pid/cmdline" ]]; then
        while IFS= read -r -d '' arg; do
          [[ "$arg" == "$START_WEB" ]] && saw_launcher=1
        done < "$PROC_ROOT/$pid/cmdline"
      fi
      if ((saw_launcher)); then
        cwd="$("$READLINK_BIN" -f "$PROC_ROOT/$pid/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$current_real" || "$cwd" == "$current_real/"* ]] && return 0
      fi
      [[ -r "$PROC_ROOT/$pid/task/$pid/children" ]] || continue
      # Linux procfs exposes `children` as a space-separated record with no
      # trailing newline. Tokenize every PID and retain the final EOF record.
      while IFS=$' \t' read -r -a children || ((${#children[@]})); do
        for child in "${children[@]}"; do
          [[ "$child" =~ ^[0-9]+$ && "$child" != 0 ]] || continue
          next_frontier+=("$child")
          next_launchers+=("$saw_launcher")
        done
      done < "$PROC_ROOT/$pid/task/$pid/children"
    done
    frontier=("${next_frontier[@]}")
    frontier_launchers=("${next_launchers[@]}")
    ((${#frontier[@]})) || break
  done
  return 1
}

listener_pid() {
  local output
  output="$("$SS_BIN" -ltnpH "sport = :$PORTAL_PORT" 2>/dev/null || true)"
  if [[ "$output" =~ pid=([0-9]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

listener_belongs_to_managed_unit() {
  local pid=$1 unit_cgroup hierarchy controllers process_cgroup
  [[ "$pid" =~ ^[0-9]+$ && "$pid" != 0 ]] || return 1
  unit_cgroup="$(systemctl_user show "$UNIT_NAME" --property=ControlGroup --value 2>/dev/null || true)"
  [[ "$unit_cgroup" == /* && "$unit_cgroup" != "/" ]] || return 1
  [[ -r "$PROC_ROOT/$pid/cgroup" ]] || return 1

  while IFS=: read -r hierarchy controllers process_cgroup; do
    if [[ "$process_cgroup" == "$unit_cgroup" || "$process_cgroup" == "$unit_cgroup/"* ]]; then
      return 0
    fi
  done < "$PROC_ROOT/$pid/cgroup"
  return 1
}

process_lineage_is_next_dev() {
  local cursor=$1 line ppid i
  for i in 1 2 3 4 5 6; do
    [[ -r "/proc/$cursor/cmdline" ]] || return 1
    line="$(tr '\0' ' ' < "/proc/$cursor/cmdline" 2>/dev/null || true)"
    if [[ "$line" == *next* && "$line" == *dev* ]]; then
      return 0
    fi
    ppid="$(awk '/^PPid:/{print $2; exit}' "/proc/$cursor/status" 2>/dev/null || true)"
    [[ "$ppid" =~ ^[0-9]+$ && "$ppid" != 1 && "$ppid" != "$cursor" ]] || break
    cursor="$ppid"
  done
  return 1
}

validate_legacy_listener() {
  local pid=$1 cwd pgid own_pgid uid
  [[ "$pid" =~ ^[0-9]+$ && -d "/proc/$pid" ]] || die "listener PID is not a live process: $pid"
  cwd="$("$READLINK_BIN" -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$PORTAL_ROOT" ]] ||
    die "refusing to stop PID $pid: cwd is '$cwd', expected '$PORTAL_ROOT'"
  uid="$(stat -c '%u' "/proc/$pid" 2>/dev/null || true)"
  [[ "$uid" == "$(id -u)" ]] || die "refusing to stop PID $pid owned by uid '$uid'"
  process_lineage_is_next_dev "$pid" ||
    die "refusing to stop PID $pid: listener lineage is not a portal next dev process"
  pgid="$("$PS_BIN" -o pgid= -p "$pid" | tr -d '[:space:]')"
  own_pgid="$("$PS_BIN" -o pgid= -p "$$" | tr -d '[:space:]')"
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" != "$own_pgid" ]] ||
    die "refusing to signal unsafe process group '$pgid'"
  printf '%s\n' "$pgid"
}

wait_for_listener_release() {
  local attempts=$((PORT_RELEASE_WAIT_SEC + 1))
  while ((attempts > 0)); do
    [[ -z "$(listener_pid)" ]] && return 0
    attempts=$((attempts - 1))
    ((attempts > 0)) && sleep 1
  done
  return 1
}

stop_legacy_listener() {
  local pgid=$1
  "$KILL_BIN" -TERM -- "-$pgid"
  wait_for_listener_release
}

stop_managed_listener() {
  systemctl_user stop "$UNIT_NAME" || return 1
  wait_for_listener_release
}

restore_legacy_listener() {
  mkdir -p -- "$(dirname -- "$FALLBACK_LOG")"
  log "managed start failed; restoring the previous Next dev command for rollback"
  (
    cd -- "$PORTAL_ROOT" || exit 1
    exec nohup "$NODE_BIN" "$NEXT_BIN" dev --webpack -H 127.0.0.1 -p "$PORTAL_PORT"
  ) >> "$FALLBACK_LOG" 2>&1 < /dev/null &
  wait_for_health "$PORTAL_PORT"
}

handoff() {
  # Checked BEFORE install_unit: this is the only mode that restarts the live
  # :3801 listener, and the release it would restart onto is decided by whatever
  # `current` names at this instant. Inspection modes stay usable on a foreign
  # current; only the cutover refuses.
  require_production_current_release
  require_fresh_current_release

  install_unit
  reload_and_enable

  # A prior successful handoff is idempotent: do not restart a healthy managed
  # service merely because this helper was invoked again.
  if systemctl_user is-active --quiet "$UNIT_NAME" 2>/dev/null &&
    managed_unit_runs_current_artifact &&
    wait_for_health "$PORTAL_PORT"; then
    log "$UNIT_NAME is already active and healthy; legacy handoff not needed"
    return 0
  fi

  # daemon-reload updates systemd's unit definition but does not replace an
  # already-running process. A prior development-generation unit can therefore
  # be healthy while still running `next dev`. Inspect the live MainPID above;
  # if it is stale, restart the managed unit onto the newly-installed standalone
  # artifact instead of returning a false idempotent success.
  if systemctl_user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    log "$UNIT_NAME is healthy but running a stale command; restarting onto the standalone artifact"
    if systemctl_user restart "$UNIT_NAME" &&
      wait_for_health "$PORTAL_PORT" &&
      managed_unit_runs_current_artifact; then
      log "handoff complete: $UNIT_NAME runs the standalone production artifact and passed health check"
      return 0
    fi
    systemctl_user stop "$UNIT_NAME" >/dev/null 2>&1 || true
    if restore_legacy_listener; then
      die "managed portal restart/health failed; legacy listener restored (still terminal-scoped)"
    fi
    die "managed portal restart/health failed and rollback could not restore the legacy listener; inspect $FALLBACK_LOG"
  fi

  local old_pid old_pgid
  old_pid="$(listener_pid || true)"
  if [[ -z "$old_pid" ]]; then
    start_managed || die "managed portal unit did not become healthy on :$PORTAL_PORT"
    log "started $UNIT_NAME and verified http://127.0.0.1:$PORTAL_PORT${HEALTH_PATH}"
    return 0
  fi

  # A unit can be activating/restarting while its listener PID still owns the
  # port. Confirm cgroup membership before entering the terminal-scoped legacy
  # path; stop managed processes only through systemd, never by signaling PID.
  if listener_belongs_to_managed_unit "$old_pid"; then
    log "$UNIT_NAME is not active but listener PID $old_pid belongs to its ControlGroup; stopping it through systemd"
    if ! stop_managed_listener; then
      die "$UNIT_NAME managed listener did not release :$PORTAL_PORT; refusing to signal it"
    fi
    start_managed || die "managed portal unit did not become healthy on :$PORTAL_PORT after stopping its prior listener"
    log "started $UNIT_NAME and verified http://127.0.0.1:$PORTAL_PORT${HEALTH_PATH}"
    return 0
  fi

  # Validate the exact listener before signaling it. In particular, never stop
  # papercusp-cloud-portal-3081.service: that separate proxy stays up through
  # this cutover and is the user's stable front door.
  health_check "$PORTAL_PORT" || die "legacy :$PORTAL_PORT listener is not healthy; refusing handoff"
  old_pgid="$(validate_legacy_listener "$old_pid")"
  log "validated legacy portal listener PID $old_pid / process group $old_pgid"

  # Next dev cannot bind the same port while the terminal process owns it. The
  # cutover therefore has a bounded outage window, with an automatic rollback
  # command if the systemd-managed replacement fails its health check.
  if ! stop_legacy_listener "$old_pgid"; then
    die "legacy listener did not release :$PORTAL_PORT after SIGTERM; no replacement started"
  fi

  if start_managed; then
    log "handoff complete: $UNIT_NAME owns :$PORTAL_PORT and passed health check"
    return 0
  fi

  systemctl_user stop "$UNIT_NAME" >/dev/null 2>&1 || true
  if restore_legacy_listener; then
    die "managed portal start/health failed; legacy listener restored (still terminal-scoped)"
  fi
  die "managed portal start/health failed and rollback could not restore the legacy listener; inspect $FALLBACK_LOG"
}

validate_inputs

case "$MODE" in
  render)
    render_unit
    ;;
  install)
    install_unit
    reload_and_enable
    log "installed and enabled $UNIT_NAME at $UNIT_DIR/$UNIT_NAME (not started)"
    ;;
  handoff)
    handoff
    install_reconcile_units
    ;;
esac
