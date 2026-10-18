#!/usr/bin/env bash
# Maintained operator browser assertion; the native rig freezes these bytes.
# Run only inside the verifier-owned source and retain its browser diagnostics.
set -u
if [ -z "${OPERATOR_SOURCE_ROOT:-}" ]; then
  echo "run-operator-e2e-isolated: owned OPERATOR_SOURCE_ROOT is required" >&2
  exit 97
fi
cd "$OPERATOR_SOURCE_ROOT/apps/operator" || exit 97
# Vite 8 treats --port 0 as unset and falls back to its default dev port (5173).
# Reserve an OS-assigned positive port, then pass that exact value to Vite and Playwright.
requested_port=$(node -e "const net=require(\"node:net\");const server=net.createServer();server.once(\"error\",error=>{console.error(error.message);process.exitCode=1});server.listen(0,\"127.0.0.1\",()=>{const address=server.address();if(!address||typeof address===\"string\"){console.error(\"run-operator-e2e-isolated: could not allocate a Vite port\");server.close();process.exitCode=1;return}const port=address.port;server.close(error=>{if(error){console.error(error.message);process.exitCode=1;return}process.stdout.write(String(port))})})") || exit 98
if [ -z "$requested_port" ]; then
  echo "run-operator-e2e-isolated: OS did not allocate a positive Vite port" >&2
  exit 98
fi
case "$requested_port" in
  *[!0-9]*|0)
    echo "run-operator-e2e-isolated: OS did not allocate a positive Vite port" >&2
    exit 98
    ;;
esac
assertion_evidence="${VH_PHASE_DIR:-}"
if [ -n "$assertion_evidence" ]; then
  mkdir -p -- "$assertion_evidence/playwright" || exit 98
  vite_log="$assertion_evidence/vite.log"
  : > "$vite_log" || exit 98
else
  vite_log=$(mktemp "${TMPDIR:-/tmp}/operator-e2e-vite.XXXXXX") || exit 98
fi
# WI-6554700010017702: `npm run dev` here is two npm hops deep (apps/operator's
# dev script runs `npm --workspace @papercusp/operator-vite run dev`), and npm
# does not carry SIGTERM through its `sh -c` child. Signalling only the outer
# npm left the inner npm, its shell and Vite running under `systemd --user`,
# rooted in the frozen source that the rig deletes next: six such servers ran
# for 7-10 days. setsid gives the dev server its own process group (a background
# job is never a group leader, so setsid does not fork and $! is that group's
# id); cleanup signals the whole group.
env -u PORT \
  OPERATOR_E2E_PORT="$requested_port" \
  PAPERCUSP_BIND_HOST=127.0.0.1 \
  PAPERCUSP_ENABLE_HMR=1 \
  PAPERCUSP_FAKE_LLM=1 \
  PAPERCUSP_DEV_WATCH=0 \
  PAPERCUSP_API_TARGET="${VERIFY_TAURI_DEV_URL:-}" \
  setsid npm run dev -- -- --host 127.0.0.1 --port "$requested_port" --strictPort >"$vite_log" 2>&1 &
vite_pid=$!
cleanup_vite() {
  if kill -0 -- "-$vite_pid" 2>/dev/null; then
    kill -TERM -- "-$vite_pid" 2>/dev/null || true
    local waited=0
    while kill -0 -- "-$vite_pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
      sleep 0.25
      waited=$((waited + 1))
    done
    kill -KILL -- "-$vite_pid" 2>/dev/null || true
  fi
  wait "$vite_pid" 2>/dev/null || true
  # The frozen source is deleted by the rig after this shell exits. Logs in
  # its retained assertion phase remain available for post-run diagnosis.
  [ -n "$assertion_evidence" ] || rm -f "$vite_log"
}
trap cleanup_vite EXIT

port=
attempt=0
while [ "$attempt" -lt 240 ]; do
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    cat "$vite_log" >&2
    echo "run-operator-e2e-isolated: Vite exited before startup" >&2
    exit 98
  fi
  port=$(node -e "const fs=require(\"node:fs\");const text=require(\"node:util\").stripVTControlCharacters(fs.readFileSync(process.argv[1],\"utf8\"));const match=text.match(/\bLocal:\s+(https?:\/\/\S+)/);if(match)process.stdout.write(new URL(match[1]).port)" "$vite_log")
  if [ -n "$port" ] && node -e "fetch(\"http://127.0.0.1:$port/\").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  port=
  attempt=$((attempt + 1))
  sleep 0.5
done
if [ -z "$port" ]; then
  cat "$vite_log" >&2
  echo "run-operator-e2e-isolated: Vite did not serve its OS-assigned port" >&2
  exit 98
fi
if [ "$port" != "$requested_port" ]; then
  echo "run-operator-e2e-isolated: Vite served port $port instead of assigned port $requested_port" >&2
  exit 98
fi
echo "OPERATOR_E2E_ISOLATED vite-port=$port"
# $OPERATOR_E2E_PLAYWRIGHT is a command line; word-splitting it is intended.
export OPERATOR_E2E_PORT="$port" \
  OPERATOR_E2E_BASE_URL="http://127.0.0.1:$port" \
  OPERATOR_E2E_REUSE_SERVER=1 \
  PAPERCUSP_API_TARGET="${VERIFY_TAURI_DEV_URL:-}"
if [ -n "$assertion_evidence" ]; then
  # Write browser artifacts outside the disposable source from the outset.
  # Keep both output streams and the first-failure trace even without retries.
  "$OPERATOR_E2E_NETNS_WRAPPER" -- $OPERATOR_E2E_PLAYWRIGHT "$@" \
    --output="$assertion_evidence/playwright" --trace=retain-on-failure \
    2>&1 | tee "$assertion_evidence/playwright.log"
  statuses=("${PIPESTATUS[@]}")
  [ "${statuses[0]}" -eq 0 ] || exit "${statuses[0]}"
  [ "${statuses[1]}" -eq 0 ] || exit 98
else
  "$OPERATOR_E2E_NETNS_WRAPPER" -- $OPERATOR_E2E_PLAYWRIGHT "$@"
fi
