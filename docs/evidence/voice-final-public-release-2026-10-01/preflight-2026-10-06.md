# Guided-session agent preflight — 2026-10-06T05:24Z (su-d7c6542c)

Runs part 0 of `guided-session.md` against the staging operator `:3170`, which the
script's desktop (`devUrl` 127.0.0.1:3170) and TUI (`PAPERCUSP_OPERATOR_URL`) steps use.

| # | Check | Result |
|---|---|---|
| 0.1 | Build identity | `:3170` sha `335341d37a`; `:3070` sha `d740fc3802` (green `main`, does NOT carry D-005); canonical HEAD `90e6465ad2` |
| 0.2 | D-005 change is serving | PASS — at `335341d37afd0f8722e8f05595d9073d6e5400f6` `voice-release-availability.ts` = `ac39d2c875dd` and `voice-mode.ts` = `014ac005da4e`, both equal to canonical. origin/staging `335341d37a` contains `ee75d2dd9f` (merge-base checked 05:23:08Z). |
| 0.3 | Voice path blobs @ `335341d37a` | `voice-mode.ts` 014ac005da4e · `settings/voice/page.tsx` fbff4040c399 · `voice-release-availability.ts` ac39d2c875dd · `voice-prefs.ts` 7dd3c6b6326d · `apps/tui/src/voice.rs` 2dae207f07d2 · `apps/tui/src/client.rs` 657ebe19f113 · `apps/tui/src/app.rs` 2d4ea88a0b53. The script's `packages/operator-core/lib/tts-synth.ts` path does not exist; the shared TTS registry is `packages/operator-core/lib/endpoint-route/routes/agent-mcp/tts-synth.ts` (record it at promotion). |
| 0.4 | Local voice health | PASS — `kokoro: true`, `voicemode: true`, `localVoice.whisper: { ok: true, source: external }`. `elevenlabs: true` is the key-format check this build still has (WI-10006372; fixed in the canonical tree, not yet on `:3170`). `openai`/`cartesia` false. |
| 0.5 | Kokoro speaks | PASS — `operator-tts-preview {engine:kokoro}` → HTTP 200 `audio/wav`, 47,628 bytes, RIFF PCM 16-bit mono 24 kHz. |
| 0.6 | Microphone source | **FAIL — no microphone input is exposed.** PipeWire lists only output monitors (USB FRONT ×2, USB Rear, HDMI). Default source is `alsa_output.usb-Generic_USB_audio_FRONT-00.HiFi__hw_FRONT__sink.monitor`, i.e. speaker loopback, not a mic. ALSA does list capture hardware on card 3 (USB audio FRONT, devices 0 and 1), and the active profile `HiFi` ("Internal Speaker/Front Headset", 1 source) defines a headset input, but no source is present, which is consistent with nothing plugged into the front headset/mic jack. Needs Avi: connect a microphone (or name the device to use) before part A. No audio was recorded. |
| 0.7 | Voice prefs snapshot | PASS — 1,799 bytes from `:3170` `operator-voice-prefs`, kept outside the repo at `~/.papercusp/evidence/voice-final-public-release-2026-10-01/prefs-before.json` for part E. |
| 0.8 | Portal fingerprint | PASS — `https://app.papercusp.com/` HTTP 200; 23 `/_next/static/` assets; fingerprint (sha256 of the sorted `asset sha256-prefix` list) `a6daf270b43703aa`. Repeat after the session. |
| 0.9 | Lesson guide location | OPEN — `CloudTutorialAssistance` lives in `apps/operator/lib/onboarding/cloud-tutorial-assistance.tsx`; the URL reachable for Avi's account is not yet located. Resolve before part D, or record L1/L2 as not exercised. |

Verdict: ready for parts A–C except 0.6. The session cannot start until a microphone input exists.
