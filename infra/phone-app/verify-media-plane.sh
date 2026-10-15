#!/usr/bin/env bash
# Phone app — local, single-direction audio traffic smoke test.
#
# One publisher and one subscriber join the configured local LiveKit. Require
# measured positive audio receive packets AND a complete error-free summary.
# Public/external, UDP-blocked, bidirectional and PSTN acceptance remain separate.
#
# Exits 0 only on measured received traffic. Any other outcome is non-zero.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${PHONE_CONFIG_DIR:-$HOME/.config/papercusp-phone}"
ENV_FILE="$CONF_DIR/livekit.env"
LK="${PHONE_LK_BIN:-$HOME/.local/bin/lk}"
NODE_BIN="${PHONE_NODE_BIN:-$(command -v node)}"
ROOM="p002-acceptance-$$"
DURATION="${DURATION:-15s}"

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[[ -x "$LK" ]] || die "lk CLI not found at $LK"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE missing — run infra/phone-app/deploy.sh first"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

export LIVEKIT_URL="${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}"
export LIVEKIT_API_KEY="$PHONE_LIVEKIT_API_KEY"
export LIVEKIT_API_SECRET="$PHONE_LIVEKIT_API_SECRET"

HEALTH_URL="$("$NODE_BIN" "$HERE/media-config.mjs" local-probe-health "$LIVEKIT_URL")" \
  || die "invalid local smoke-test origin"
printf '▸ Local audio traffic smoke test — one direction\n'
say "server : $LIVEKIT_URL"
say "room   : $ROOM"
say "window : $DURATION"

curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 \
  || die "configured local LiveKit is not answering"
say "health OK"

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
printf '\n▸ Running load test (1 publisher → 1 subscriber)\n'
if ! "$LK" load-test \
      --room "$ROOM" \
      --audio-publishers 1 \
      --subscribers 1 \
      --duration "$DURATION" >"$out" 2>&1; then
  die "lk load-test exited non-zero"
fi

"$NODE_BIN" "$HERE/media-config.mjs" load-test-receipt "$out" \
  || die "no complete measured audio receive path"
printf '\n✓ Local single-direction audio traffic verified; public/two-way/PSTN acceptance remains open\n'
