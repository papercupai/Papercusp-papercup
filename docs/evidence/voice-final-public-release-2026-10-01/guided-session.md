# Guided real-microphone session — voice public release

Plan: `voice-final-public-release-2026-10-01` (D-005, P-001 / WI-10004757).
Written 2026-10-06 by su-d7c6542c.

**Who does what.** Avi performs every microphone step himself. The agent runs the
preflight, watches the operator side, records the evidence, and restores settings
afterwards. No synthetic audio stands in for any step. That is R-2/R-3 as amended
by D-003 and kept unchanged by D-005.

**Scope.** Only the in-scope and conditional rows of the D-005 table in the plan's
*Current release matrix* are exercised. Dropped engines are checked only to confirm
they show as unavailable.

**Time.** About 30–40 minutes: desktop ~15, TUI ~5, portal ~10–15.

**How to record a step.** After each step, say or type `pass` or `fail` and one line
about what you saw and heard. The agent fills in the evidence row: step id, UTC
time, runtime/build, engine, mode, what you said, transcript shown, reply audible
(Y/N), notes. A step that cannot run on this runtime is recorded as `unsupported`,
never as `pass`.

Evidence directory: `docs/evidence/voice-final-public-release-2026-10-01/session-<YYYYMMDD>/`.

---

## 0. Agent preflight (agent only, before Avi starts)

Run all of it. Stop and report if any check fails.

1. **Build identity.** `curl -s 127.0.0.1:3070/api/health` and `:3170/api/health`
   (record `sha`). Record `git rev-parse HEAD` of the canonical tree.
2. **D-005 change is serving.** Confirm the staging checkout contains
   `packages/operator-core/lib/voice-release-availability.ts`. Compare its blob with
   the canonical tree. If staging is behind, reload it with
   `dev:restart { target: 'staging', confirm: true, authorize: true }` once
   origin/staging has the commit. Do not start Avi's steps on a build without it:
   WI-10006353 changed `voice-mode.ts`, so a session on an older build would need a
   second microphone pass on the promoted artifact.
3. **Voice path blobs.** Record `git rev-parse <sha>:<path>` for:
   `apps/operator/app/_components/voice/voice-mode.ts`,
   `apps/operator/app/settings/voice/page.tsx`,
   `packages/operator-core/lib/voice-release-availability.ts`,
   `packages/operator-core/lib/voice-prefs.ts`,
   `packages/operator-core/lib/endpoint-route/routes/agent-mcp/tts-synth.ts`,
   `apps/tui/src/voice.rs`, `apps/tui/src/client.rs`, `apps/tui/src/app.rs`.
   These bind the session to the promoted artifact for R-6. A path whose blob differs
   at promotion gets a focused re-check on the artifact.
4. **Local voice health.** `GET /api/agent-mcp/operator-voice-engine-health` on the
   chosen operator must show `kokoro: true` and `localVoice.whisper.ok: true`. Ignore
   its `elevenlabs` field, which is a key-format check only (WI-10006372).
5. **Kokoro speaks.** `POST /api/agent-mcp/operator-tts-preview {"engine":"kokoro","text":"preflight"}`
   must return 200 `audio/wav`.
6. **Microphone source is not suspended.** `pactl list sources short` shows the
   default input source, and it is not stuck `SUSPENDED` after a capture starts. A
   source stuck that way broke capture once before. Do not record any audio here.
7. **Snapshot voice prefs.** `GET /api/agent-mcp/operator-voice-prefs` →
   `prefs-before.json`. Part E restores it.
8. **Portal fingerprint.** Fetch `https://app.papercusp.com/`. Record the sorted list
   of `/_next/static/...` asset names and their sha256; `/api/health` exposes no
   build sha. Repeat after the session to show the build did not change mid-session.
9. **Lesson guide location.** Find where the onboarding lesson guide
   (CloudTutorialAssistance) is reachable for Avi's account, and write the URL here
   before part D. If it is not reachable, L1/L2 are recorded as not exercised.

---

## A. Desktop app (Linux, this machine)

Launch from the repo root. Use :3170 if preflight step 2 passed, otherwise :3070:

```bash
cd papercusp-desktop && npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:3170","beforeDevCommand":""}}'
```

Open Settings → Voice. Set **Input: local (Whisper)**, **Output: Kokoro**,
**Full-agent: Off**. Open a conversation.

| Step | Row | Do this | Expect |
| --- | --- | --- | --- |
| A1 | D1 PTT | Hold push-to-talk, say "What is two plus two?", release | Your words appear as a transcript; a spoken Kokoro reply is audible |
| A2 | D1 always-on | Switch to always-on. Ask "Name three colours." | Transcript and an audible reply, with no button press |
| A3 | interruption | While A2's reply is still speaking, start talking | Playback stops or yields; your new utterance is taken as the next turn |
| A4 | self-audio | Let a reply play to the end in always-on mode without speaking | The reply's own audio is **not** transcribed back as a user turn |
| A5 | output mute | Mute voice output, ask a question | Text reply appears; nothing is spoken. Unmute afterwards |
| A6 | off | Switch voice off | Capture stops; the OS microphone-in-use indicator clears |
| A7 | D2 Browser TTS | Set Output: Browser, ask a question by PTT | Audible reply in a system voice, **or** record `unsupported` if no voice exists on this runtime |
| A8 | D6 Web Speech | Set Input: Web Speech (continuous), accept the cloud-recognition notice, speak | Transcript and reply, **or** `unsupported` if the option is disabled or the API is missing |
| A8w | D9 openWakeWord | Set Wake engine: openWakeWord, keyword "Hey Jarvis". Say "Hey Jarvis", then a question | Wake detected; that question becomes a turn with an audible reply. Speech without the phrase is ignored |
| A9 | permission | Only if the OS or webview asks for microphone permission: deny once, then retry and allow | A clear error on deny; capture works after allowing. Skip with a note if no prompt appears |

## B. TUI (`pui`)

In a terminal:

```bash
pui doctor
PAPERCUSP_OPERATOR_URL=http://127.0.0.1:3170 pui
```

Use `:3070` instead if the desktop used it. Leave the desktop voice switched **off**
so the two apps do not both capture.

| Step | Row | Do this | Expect |
| --- | --- | --- | --- |
| B1 | T1 | Press `v`, say "What day is it?", press `v` again | Transcript shown; audible Kokoro reply |
| B2 | T1 silence | Press `v`, stay silent for about 3 seconds, press `v` | No empty turn goes to the agent, and the TUI says nothing was heard. Record exactly what appears. (There is no output-mute key for a plain PTT turn; `M` acts only during an ElevenLabs session and `m` opens the model picker) |
| B3 | T2 dropped | Press `V` (shared ElevenLabs session) | No ElevenLabs session starts, and the TUI shows a message rather than hanging. Record exactly what appears |

## C. Public portal (app.papercusp.com, signed in)

Use a normal browser profile signed in as Avi.

| Step | Row | Do this | Expect |
| --- | --- | --- | --- |
| C0 | P1 config | Open `https://app.papercusp.com/api/voice/engines` in the signed-in browser and paste the JSON to the agent | `{ ok: true, engines: { elevenlabs: <bool>, livekit: <bool> } }` |

**If both engines are `false`:** portal voice is not in this release. Open a
conversation with voice engine Auto and confirm the control says voice is
unavailable rather than failing silently. Record it, then skip to part D.

For **each engine reported `true`**, set it as the voice engine (or use Auto when
only one is true) and run:

| Step | Row | Do this | Expect |
| --- | --- | --- | --- |
| C1 | consent | Start voice for the first time | A voice consent prompt appears; accepting it leads to the browser microphone permission prompt |
| C2 | PTT | Hold push-to-talk, ask a question, release | Transcript, then an audible reply |
| C3 | always-on | Switch always-on on, ask a question; then switch it off | Turn completes hands-free; after switching off, capture stops (browser mic indicator clears) |
| C4 | interruption | Speak over a reply | Reply yields; the new utterance is taken |
| C5 | deny/retry | In site settings, block the microphone, start voice, then allow it again and retry | Clear permission error while blocked; works after allowing |
| C6 | boundary | Open the engine picker | Only Auto, Off, ElevenLabs and LiveKit are offered. No local Whisper/Kokoro or desktop-socket option appears |

## D. Lesson guide output (if reachable — preflight step 9)

| Step | Row | Do this | Expect |
| --- | --- | --- | --- |
| D1 | L1 | Start the lesson guide with Browser voice | Audible lesson speech; mute, stop and replay work; **no** microphone prompt |
| D2 | L2 | Repeat with Kokoro voice | Same |

## E. After the session (agent only)

1. Pull each step's transcript and turn timestamps from the operator's conversation
   records and add them to `evidence.json` next to Avi's pass/fail notes.
2. Restore `prefs-before.json` through the voice prefs route, then re-read it and
   diff. Avi confirms Settings → Voice shows his original engines (R-3: the engine
   preference must be restored).
3. Re-fingerprint the portal (preflight step 8) and record whether it changed.
4. Write each row's result into the plan's D-005 table and on WI-10004757. Every
   `fail` becomes a filed work-item with its evidence before anything is marked
   done. A conditional portal row with no configured engine goes into the release
   notes as not offered.
5. Keep the preflight blob list for the R-6 artifact comparison at promotion.
6. **Dropped engines (no microphone needed, agent-run).** On the promoted build, drive
   Settings → Voice in an isolated headless desktop
   (`VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- bash <assert-script>`).
   Assert that ElevenLabs TTS, OpenAI TTS, Cartesia TTS, ElevenLabs Conversational AI,
   OpenAI Realtime, Gemini Live and Porcupine are disabled and labelled "not available in
   this release". Also assert that a saved legacy preference for one of them shows the
   scoped alert and is kept, not deleted.
