#!/usr/bin/env bash
# Isolated audio loopback smoke for the pui voice stack
# (universal-voice-interface-2026-06-05, P-011 — the autonomous real-audio half).
#
# Runs the #[ignore]d hardware smokes in apps/tui/src/voice.rs (real cpal capture
# + rodio playback + a 440 Hz tone loopback) through a PipeWire **null-sink**, so
# the actual audio device path is exercised with SYNTHETIC audio while:
#   • NO real sound is emitted (playback lands in the null-sink), and
#   • the box's real defaults (Brio mic / HDMI out) are never touched
#     (we route this process via PULSE_SINK/PULSE_SOURCE only — see the agent
#     memory `isolated-audio-e2e-null-sink`).
#
# This is the device-level complement to the deterministic, no-hardware
# `operator-voice-{multiclient,synthetic-audio}.test.ts` bus E2Es. It needs
# PipeWire + pactl (a dev box), so it is NOT a CI test — run it locally:
#
#   apps/tui/scripts/audio-loopback-smoke.sh
#
# Exits 0 on pass or an unavailable local audio stack (environmental skip),
# non-zero on a smoke failure; always unloads the null-sink.
set -uo pipefail

SINK="pui_voice_test_$$"
MODID=""
cleanup() {
  if [ -n "$MODID" ]; then
    pactl unload-module "$MODID" >/dev/null 2>&1 || true
    echo "[audio-smoke] unloaded null-sink (module $MODID)"
  fi
}
trap cleanup EXIT

command -v pactl >/dev/null 2>&1 || { echo "[audio-smoke] SKIP: pactl not found (needs PipeWire/PulseAudio)"; exit 0; }
pactl info >/dev/null 2>&1 || { echo "[audio-smoke] SKIP: no reachable PipeWire/PulseAudio server"; exit 0; }

echo "[audio-smoke] loading isolated null-sink '$SINK' (real Brio/HDMI defaults untouched)…"
MODID=$(pactl load-module module-null-sink "sink_name=$SINK" "sink_properties=device.description=$SINK") || {
  echo "[audio-smoke] SKIP: could not load module-null-sink"; exit 0;
}
echo "[audio-smoke] module $MODID → sink=$SINK  monitor=$SINK.monitor"

cd "$(dirname "$0")/.."  # apps/tui
export PUI_LIVE_AUDIO=1

# The device stack lives in a sibling executable; the tests below exercise the
# PUI proxy through that freshly built process, not only the backend in isolation.
cargo build --bins || exit $?

# D-006 speech round trip (voice-final-public-release-2026-10-01): render a real
# Kokoro speech WAV to play into the null-sink as the "microphone", then the
# smoke sends the capture through the operator STT/TTS proxies (PUI_OPERATOR,
# default `staging` :3170; those routes write no conversation turn). Without
# Kokoro the speech smoke is skipped — unless PAPERCUSP_REQUIRE_LIVE_VOICE=1,
# where an unreachable engine fails the run instead of passing by skipping.
KOKORO_URL="${KOKORO_URL:-http://127.0.0.1:8880}"
SPEECH_PHRASE="${PUI_SMOKE_SPEECH_EXPECT:-the quick brown fox jumps over the lazy dog}"
SPEECH_WAV="$(mktemp --suffix=.wav)"
trap 'rm -f "$SPEECH_WAV"; cleanup' EXIT
SMOKES=(smoke_record_yields_16k_wav smoke_play_tone smoke_loopback_tone_roundtrip smoke_unreachable_mic_is_named_and_recovers)
if curl -fsS -m 60 -X POST "$KOKORO_URL/v1/audio/speech" -H 'Content-Type: application/json' \
     -d "{\"model\":\"kokoro\",\"input\":\"$SPEECH_PHRASE\",\"voice\":\"af_bella\",\"response_format\":\"wav\"}" \
     -o "$SPEECH_WAV" && [ "$(stat -c %s "$SPEECH_WAV")" -gt 1000 ]; then
  echo "[audio-smoke] rendered Kokoro speech WAV ($(stat -c %s "$SPEECH_WAV") bytes) for the speech round trip"
  SMOKES+=(smoke_speech_roundtrip_via_operator smoke_stop_mid_reply_silences_playback smoke_stt_failure_then_retry_transcribes)
elif [ "${PAPERCUSP_REQUIRE_LIVE_VOICE:-}" = "1" ]; then
  echo "[audio-smoke] FAIL: PAPERCUSP_REQUIRE_LIVE_VOICE=1 but Kokoro at $KOKORO_URL did not render speech"
  exit 1
else
  echo "[audio-smoke] SKIP speech round trip: Kokoro at $KOKORO_URL did not render speech"
fi

# Route the test process at the null-sink: cpal's ALSA host exposes a `pulse`
# device (in + out) that honors PULSE_SINK/PULSE_SOURCE per-process. Playback →
# the null-sink; capture ← its monitor → a real loopback with zero audible sound.
PULSE_SINK="$SINK" PULSE_SOURCE="$SINK.monitor" \
PUI_VOICE_INPUT=pulse PUI_VOICE_OUTPUT=pulse \
PUI_SMOKE_SPEECH_WAV="$SPEECH_WAV" PUI_SMOKE_SPEECH_EXPECT="$SPEECH_PHRASE" \
  cargo test --bin pui -- --ignored --test-threads=1 --nocapture "${SMOKES[@]}" \
  2>&1 | grep -vE "jack|JackShm|ALSA lib|Cannot (connect|open)|snd_pcm_jack"
rc=${PIPESTATUS[0]}

if [ "$rc" -eq 0 ]; then
  echo "[audio-smoke] PASS — real cpal capture + rodio playback verified with synthetic audio (no sound, no focus steal)."
else
  echo "[audio-smoke] FAIL (cargo rc=$rc)"
fi
exit "$rc"
