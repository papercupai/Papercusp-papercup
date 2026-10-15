#!/usr/bin/env bash
# WI-10007029: dedicated disposable operator for reviewer controls/screenshots.
# Reuses the maintained Tauri verifier, ready seed and immutable source census.
# --controls-only: seed synthetic content, prove local200/remote403, then tear down.
# --capture-native: send the one-use QR on SSH stdin to the maintained ios-ci.py
# runner, retain its exact paired artifacts, and delete its private input.
# Requires REVIEWER_NATIVE_HOST, REVIEWER_MOBILE_ROOT and REVIEWER_MOBILE_SHA.
# The fixture stays online for the entire native run. Evidence lives outside the
# repo; no token is printed. This is a short-lived screenshot fixture, not the
# durable cloud review environment (D-014/D-016 remain pending live relay proof).
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
case "${1:---controls-only}" in
  --controls-only) export REVIEWER_CAPTURE_NATIVE=0 ;;
  --capture-native) export REVIEWER_CAPTURE_NATIVE=1 ;;
  *) echo 'Usage: bash scripts/reviewer-operator.sh [--controls-only|--capture-native]' >&2; exit 2 ;;
esac
for dependency in node python3 cloudflared socat; do
  command -v "$dependency" >/dev/null || { echo "Missing dependency: $dependency" >&2; exit 2; }
done
if [ "$REVIEWER_CAPTURE_NATIVE" = 1 ]; then
  command -v ssh >/dev/null && command -v scp >/dev/null || {
    echo 'SSH and SCP are required for native capture' >&2; exit 2;
  }
  node "$ROOT/scripts/reviewer-operator-assert.mjs" --native-preflight
fi
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
mkdir -p "$STATE_DIR"
OUT=$(mktemp -d "$STATE_DIR/reviewer-operator.XXXXXX")
export REVIEWER_OUTPUT_DIR="$OUT" REVIEWER_PAIR_PAYLOAD_PATH="$OUT/pair-payload.json"
export PROTO_RELAY_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
export MOBILE_PAIR_TOKEN_TTL_SECONDS=7200
touch "$OUT/cloudflared.yml"
cloudflared tunnel --no-autoupdate --config "$OUT/cloudflared.yml" \
  --url "http://127.0.0.1:$PROTO_RELAY_PORT" >"$OUT/cloudflared.log" 2>&1 &
TUNNEL_PID=$!
cleanup() { kill "$TUNNEL_PID" 2>/dev/null || true; rm -f "$REVIEWER_PAIR_PAYLOAD_PATH"; }
trap cleanup EXIT
URL=''
for ((attempt=0; attempt<90; attempt++)); do
  URL=$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$OUT/cloudflared.log" | head -1 || true)
  [ -z "$URL" ] || break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo 'Reviewer tunnel exited before readiness' >&2; exit 1; }
  sleep 1
done
[ -n "$URL" ] || { echo 'Reviewer tunnel did not become ready' >&2; exit 1; }
export MOBILE_DESKTOP_PUBLIC_URL="$URL" REVIEWER_SEED_CONTENT=1
echo "REVIEWER: sanitized fixture evidence directory=$OUT"
cd "$ROOT"
# Exactly one launch. A source-lock refusal is checkpointed by the operator,
# never converted into an unbounded retry or a bypass of another agent's edit.
VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
  scripts/verify-tauri-headless.sh -- node scripts/reviewer-operator-assert.mjs \
  >"$OUT/verifier.log" 2>&1
echo "REVIEWER: controls completed; see $OUT/verifier.log"
