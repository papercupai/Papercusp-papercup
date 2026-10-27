#!/usr/bin/env bash
# Run a command in its own network namespace so host network-interface churn cannot reach it.
# (WI-6554700010008480: the durable fix for net::ERR_NETWORK_CHANGED blanking headless
#  Chromium e2e page loads. It replaces the one-reload mitigation in apps/operator/e2e/_egress.ts.)
#
# Usage: scripts/lib/run-in-isolated-netns.sh -- <command> [args...]
#
# Why: this host's fleet brings VM/tunnel interfaces up and down all day. Chromium's
# NetworkChangeNotifier (AddressTrackerLinux) treats ANY rtnetlink link/address add or
# remove as a network change and aborts in-flight loads with ERR_NETWORK_CHANGED. It has
# no runtime switch to ignore address changes (checked for the pinned chromium builds).
# rtnetlink is per network namespace, so a browser in its own namespace never hears the
# host's churn.
#
# Mechanism (measured 2026-10-11, fact finding:e2e-chromium-netns-isolation-recipe):
#   * bwrap --unshare-user --unshare-net creates a user+network namespace. bwrap carries an
#     AppArmor userns grant on Ubuntu; pasta alone cannot create one here
#     (kernel.apparmor_restrict_unprivileged_userns=1).
#   * The command is held (bwrap --block-fd) while pasta attaches to that namespace from
#     OUTSIDE by the sandbox child's pid and configures one tap interface. `-T auto`
#     forwards a connection to 127.0.0.1:<port> inside the namespace to the same port on
#     the HOST loopback, so Vite, the operator and Postgres stay in the host namespace and
#     remain reachable. pasta rescans the bound-port set periodically, so a port bound
#     after start is forwarded too. Nothing is forwarded INTO the namespace (-t/-u none).
#   * Before exec, the command waits for the namespace's own address set to settle: the
#     tap's IPv6 link-local address leaves DAD 'tentative' state a few seconds after attach,
#     which is itself an address change Chromium would report.
#   * The filesystem is the host's (--dev-bind / /), the uid is unchanged, and the pid
#     namespace is shared, so files, unix sockets, the test ledger and process accounting
#     behave exactly as outside.
#
# Mode: PAPERCUSP_E2E_NETNS = auto (default) | required | off
#   auto      isolate when bwrap + pasta can build the namespace; otherwise run the command
#             unisolated (reason printed on the status line).
#   required  exit 97 when the namespace cannot be built.
#   off       run the command directly.
# PAPERCUSP_E2E_NETNS_SETTLE_SEC (default 20) bounds the wait for the namespace to settle.
#
# Prints exactly one status line to stderr before the command starts:
#   RUN_IN_ISOLATED_NETNS isolated=<0|1> mode=<mode> reason=<why>
# Exit code: the command's own; 97 = isolation required but unavailable or setup failed;
# 2 = usage.
set -u

MODE="${PAPERCUSP_E2E_NETNS:-auto}"
SETTLE_SEC="${PAPERCUSP_E2E_NETNS_SETTLE_SEC:-20}"

if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "usage: run-in-isolated-netns.sh -- <command> [args...]" >&2
  exit 2
fi
shift
CMD=("$@")

case "$SETTLE_SEC" in '' | *[!0-9]*)
  echo "run-in-isolated-netns: PAPERCUSP_E2E_NETNS_SETTLE_SEC must be a whole number of seconds" >&2
  exit 2
  ;;
esac

status() { echo "RUN_IN_ISOLATED_NETNS isolated=$1 mode=$MODE reason=$2" >&2; }

work=""
bwrap_pid=""
child_pid=""
child_start=""
pasta_pid=""
native_observer_pid=""

process_start() {
  local stat fields
  IFS= read -r stat 2>/dev/null <"/proc/$1/stat" || return 1
  stat="${stat##*) }"
  read -r -a fields <<< "$stat"
  printf '%s' "${fields[19]:-}"
}

helper_alive() {
  [ -n "$child_pid" ] && [ -n "$child_start" ] || return 1
  local stat fields
  IFS= read -r stat 2>/dev/null <"/proc/$child_pid/stat" || return 1
  stat="${stat##*) }"
  read -r -a fields <<< "$stat"
  [ "${fields[19]:-}" = "$child_start" ] && [ "${fields[0]:-}" != Z ]
}

teardown() {
  # A launcher can exit before releasing its eventfd-blocked helper. That
  # orphan still owns stdout and can keep a surrounding tee alive indefinitely.
  # Pin the start time so cleanup never signals a reused process id.
  if helper_alive; then
    kill -TERM "$child_pid" 2>/dev/null || true
    local waited=0
    while helper_alive && [ "$waited" -lt 20 ]; do
      sleep 0.05
      waited=$((waited + 1))
    done
    if helper_alive; then kill -KILL "$child_pid" 2>/dev/null || true; fi
  fi
  child_pid=""
  child_start=""
  if [ -n "$bwrap_pid" ]; then
    kill -KILL "$bwrap_pid" 2>/dev/null || true
    wait "$bwrap_pid" 2>/dev/null || true
    bwrap_pid=""
  fi
  if [ -n "$native_observer_pid" ]; then
    kill "$native_observer_pid" 2>/dev/null || true
    wait "$native_observer_pid" 2>/dev/null || true
  fi
  native_observer_pid=""
  unset PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET
  if [ -n "$pasta_pid" ]; then kill "$pasta_pid" 2>/dev/null || true; fi
  pasta_pid=""
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  work=""
}
trap teardown EXIT

# Isolation could not be built: run unisolated (auto) or refuse (required).
fallback() {
  local reason="$1"
  if [ -n "$bwrap_pid" ]; then
    # The sandbox is still held at its block fd, so the command never started.
    kill -KILL "$bwrap_pid" 2>/dev/null || true
    wait "$bwrap_pid" 2>/dev/null || true
    bwrap_pid=""
  fi
  teardown
  status 0 "$reason"
  if [ "$MODE" = required ]; then
    echo "run-in-isolated-netns: network isolation is required (PAPERCUSP_E2E_NETNS=required) but unavailable: $reason" >&2
    exit 97
  fi
  exec "${CMD[@]}"
}

case "$MODE" in
  auto | required) ;;
  off)
    status 0 disabled
    exec "${CMD[@]}"
    ;;
  *)
    echo "run-in-isolated-netns: PAPERCUSP_E2E_NETNS must be auto, required or off (got '$MODE')" >&2
    exit 2
    ;;
esac

for tool in bwrap pasta ip; do
  command -v "$tool" >/dev/null 2>&1 || fallback "$tool-missing"
done

work="$(mktemp -d "${TMPDIR:-/tmp}/run-in-isolated-netns.XXXXXX")" || fallback mktemp-failed
mkfifo "$work/info" "$work/block" || fallback mkfifo-failed

# The user namespace cannot dereference a host process's /proc/<pid>/exe.
# Preserve the reporter's original custody checks in an observer outside it.
# Preparation is a hard native precondition, before browser/test execution.
if [ -n "${VERIFY_TAURI_PID:-}" ]; then
  export PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET="$work/native-runtime.sock"
  node --import tsx "$OPERATOR_SOURCE_ROOT/packages/operator-core/lib/testing-native-runtime.ts" \
    --observe-native "$PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET" >"$work/native-runtime.log" 2>&1 &
  native_observer_pid=$!
  observer_deadline=$((SECONDS + 30))
  while [ ! -S "$PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET" ]; do
    if ! kill -0 "$native_observer_pid" 2>/dev/null || [ "$SECONDS" -ge "$observer_deadline" ]; then
      cat "$work/native-runtime.log" >&2
      echo "run-in-isolated-netns: native runtime witness preparation failed" >&2
      teardown
      exit 98
    fi
    sleep 0.1
  done
  # Verify the same generated ownership guard before any assertion command
  # starts, rather than discovering a provenance/namespace failure in a UI step.
  if [ -n "${VERIFY_TAURI_LIVENESS_CHECK:-}" ] && ! node --import tsx \
    "$OPERATOR_SOURCE_ROOT/packages/operator-core/lib/testing-native-runtime.ts" \
    --check-native-liveness >"$work/native-liveness.log" 2>&1; then
    cat "$work/native-liveness.log" >&2
    echo "run-in-isolated-netns: native liveness preparation failed" >&2
    teardown
    exit 98
  fi
fi

# Runs INSIDE the namespace once the block fd is released. Waits until pasta's interface
# carries an IPv4 address, no address is still tentative, and two consecutive reads of
# the address set agree; then becomes the command.
# shellcheck disable=SC2016 # expanded by the inner shell
inner='
settle_sec="$1"; shift
deadline=$((SECONDS + settle_sec))
prev=""
while :; do
  cur="$(ip -o addr show 2>/dev/null | awk "{print \$2, \$3, \$4, (\$0 ~ /tentative/ ? \"T\" : \"\")}")"
  if printf "%s\n" "$cur" | grep -qv "^lo " \
    && printf "%s\n" "$cur" | grep -q " inet " \
    && ! printf "%s\n" "$cur" | grep -q " T$" \
    && [ "$cur" = "$prev" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "run-in-isolated-netns: namespace addresses did not settle within ${settle_sec}s:" >&2
    printf "%s\n" "$cur" >&2
    exit 97
  fi
  prev="$cur"
  sleep 0.5
done
exec "$@"
'

# The fifo opens rendezvous in order: info (bwrap writes the child pid), then block
# (bwrap waits on it before running the command). High fds keep the command's own
# inherited 3/4 intact (Playwright's --remote-debugging-pipe browser transport).
# A non-interactive shell gives a background job /dev/null as stdin; pass the caller's
# stdin through fd 7 instead.
exec 7<&0
bwrap --dev-bind / / --unshare-user --unshare-net --die-with-parent \
  --info-fd 8 --block-fd 9 \
  -- bash -c "$inner" run-in-isolated-netns-inner "$SETTLE_SEC" "${CMD[@]}" \
  8>"$work/info" 9<"$work/block" <&7 7<&- &
bwrap_pid=$!
exec 7<&-
exec 5<"$work/info"
exec 6>"$work/block"

info_read_rc=0
# --info-fd is a complete JSON record, not a one-line pid notification. Closing
# its reader after child-pid can SIGPIPE the launcher during its remaining
# writes and strand the helper before the command ever starts.
while IFS= read -r -t 15 line <&5 || { info_read_rc=$?; false; }; do
  case "$line" in
    *'"child-pid"'*)
      child_pid="${line//[!0-9]/}"
      child_start="$(process_start "$child_pid" || true)"
      ;;
  esac
done
exec 5<&-
[ "$info_read_rc" -eq 1 ] || fallback bwrap-info-incomplete
[ -n "$child_pid" ] || fallback bwrap-namespace-failed

# 6>&-: pasta daemonizes; an inherited write end of the block fifo would keep bwrap
# from ever seeing it close.
if ! pasta --config-net --quiet -t none -u none -T auto -U none \
  -P "$work/pasta.pid" "$child_pid" </dev/null >"$work/pasta.log" 2>&1 6>&-; then
  sed 's/^/run-in-isolated-netns: pasta: /' "$work/pasta.log" >&2
  fallback pasta-attach-failed
fi
pasta_pid="$(cat "$work/pasta.pid" 2>/dev/null || true)"

forward() {
  # Deliver the signal to the command itself so it can clean up (Playwright closes its
  # browsers); bwrap exits when the command does.
  kill "-$1" "$child_pid" 2>/dev/null || true
}
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP

status 1 namespace
# Release the command: bwrap proceeds on data or EOF at its block fd.
# A supervisor may already have closed the read end. Keep SIGPIPE confined to
# the writer so this shell still reaps the launcher and cleans its helper.
release_rc=0
( trap - EXIT; printf 'go' >&6 ) || release_rc=$?
exec 6>&-
while :; do
  wait "$bwrap_pid"
  rc=$?
  # A trapped signal interrupts wait with a status > 128; keep waiting for the real exit.
  kill -0 "$bwrap_pid" 2>/dev/null || break
done
bwrap_pid=""
if helper_alive; then
  echo 'run-in-isolated-netns: supervisor exited with its sandbox helper still alive' >&2
  # A successful launcher exit cannot attest an unexecuted command.
  if [ "$rc" -eq 0 ]; then rc=97; fi
fi
if [ "$rc" -eq 0 ] && [ "$release_rc" -ne 0 ]; then rc=97; fi
exit "$rc"
