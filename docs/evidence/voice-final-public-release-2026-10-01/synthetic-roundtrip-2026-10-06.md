# Synthetic-voice round trips — 2026-10-06 (D-006, WI-10006763)

Plan: `voice-final-public-release-2026-10-01`. Decision D-006 adds agent-run synthetic
round trips (Kokoro speech injected as microphone input). Avi's guided real-microphone
session (D-005) remains the final check; nothing here replaces it.

## TUI (`pui`) — PASS

- **Test:** `smoke_speech_roundtrip_via_operator` in `apps/tui/src/voice_proxy.rs`
  (the `pui` binary's `voice` module, which drives the `pui-audio` helper process the
  TUI uses for capture and playback). Unit guards in the same module:
  `streamed_wav_placeholder_sizes_are_rewritten`,
  `speech_word_matching_normalizes_case_and_punctuation`.
- **Runner:** `PUI_SMOKE_TTS_ENGINES=kokoro PUI_OPERATOR=staging PAPERCUSP_REQUIRE_LIVE_VOICE=1 apps/tui/scripts/audio-loopback-smoke.sh`
- **Isolation:** a temporary PipeWire null-sink (`pui_voice_test_<pid>`) routed per process
  through `PULSE_SINK` / `PULSE_SOURCE`. No sound is emitted, and the BRIO/HDMI defaults
  are untouched. The module is unloaded on exit.
- **Operator:** `:3170` (staging operator, build `99100d1029`). The `operator-stt` and
  `operator-tts` proxy routes write no conversation turn.
- **Tree:** superproject `b47ce3957a` plus the uncommitted edits named in WI-10006763.

| Leg | Path | Heard by operator STT | Result |
|---|---|---|---|
| Microphone | Kokoro pangram WAV → PUI player → null-sink → PUI capture (monitor) → `operator-stt` | "The quick brown fox jumps over the lazy dog." (9/9 words) | PASS |
| Reply playback (Kokoro) | `operator-tts` engine=kokoro → PUI player → null-sink → PUI capture → `operator-stt` | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Device smokes | tone loopback, play tone, 16 kHz record | — | PASS (4/4 tests, 21.4 s) |

Logs: `.papercusp/scratch/d006-tui-smoke-run3.log` and `.papercusp/scratch/d006-tui-smoke-run4.log`
(run 3: prefs engine; run 4: explicit kokoro).

Defect found and fixed in the test fixture, not the product: Kokoro streams WAV with
placeholder `0xFFFFFFFF` RIFF and data sizes, which the PUI player rejects
("decode audio: end of stream"). The operator TTS route already rewrites those sizes
(measured: the operator returned RIFF size = length − 8), so TUI replies were never
affected. The smoke now repairs the raw fixture the same way.

### ElevenLabs reply leg — PASS (run 5, 2026-10-06T17:20:58Z–17:21:40Z)

Re-run once `:3170` carried the D-007 availability change
(`packages/operator-core/lib/voice-release-availability.ts`; `dev:pipeline_position` reported
`staging-operator` build `428bcb7c23` `containsChange: true`). Run 4's `:3170` build
`99100d1029` predated it and answered 400 "not available in this release".

- **Runner:** `PUI_SMOKE_TTS_ENGINES=kokoro,elevenlabs PUI_OPERATOR=staging PAPERCUSP_REQUIRE_LIVE_VOICE=1 bash apps/tui/scripts/audio-loopback-smoke.sh`

| Leg | Heard by operator STT | Result |
|---|---|---|
| Microphone (Kokoro pangram) | "The quick brown fox jumps over the lazy dog." (9/9 words) | PASS |
| Reply playback (Kokoro) | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Reply playback (ElevenLabs) | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Device smokes | — | PASS (4/4 tests, 24.4 s) |

Log: `.papercusp/scratch/d006-tui-el-run1.log` (`EXIT=0`).

### Stop, denial and retry — PASS (run 5, 2026-10-06T19:20Z–19:21Z)

Three smokes were added to `apps/tui/src/voice_proxy.rs` (all `#[ignore]`, `PUI_LIVE_AUDIO=1` opt-in)
and to the `SMOKES` list in `apps/tui/scripts/audio-loopback-smoke.sh`. Same runner and null-sink
isolation as above. Result: `7 passed; 0 failed` (31.4 s), `[audio-smoke] PASS`, exit 0. Log:
`.papercusp/scratch/d006-tui-smoke-run5.log`.

| Leg | What it does | Measured | Result |
|---|---|---|---|
| Stop | Kokoro plays a three-sentence reply; `Player::stop()` is called 1.8 s in; capture continues 9 s past where the reply would end | stopped in 50 ms; stayed stopped; no player error; heard "Here is the first part of a long story.", none of the closing "purple elephants dance tonight" | PASS |
| Denial | `PULSE_SERVER`/`PIPEWIRE_REMOTE` point at a dead socket, then `start_capture()` | refused in 0.58 s: "input config: The requested device is no longer available. For example, it has been unplugged."; capture works again once the variables are restored | PASS |
| Retry | broken audio sent to `operator-stt`, then a real Kokoro capture | first call 400 `audio too short to transcribe`; the retry heard "The quick brown fox jumps over the lazy dog." (9/9) | PASS |

Not covered on the TUI: a spoken question answered by the brain. That path is the same operator
turn the desktop brain leg exercised (run 6 below), and Avi's guided session (D-005) covers it on
the TUI with a real microphone.

## Desktop — PASS (run 6)

The Playwright spec `apps/operator/e2e/voice-synthetic-roundtrip.spec.ts` runs inside an
isolated `scripts/verify-tauri-headless.sh` rig (isolated database and WebView profile).
Run 1 failed before boot: the rig's frozen source snapshot caught a peer's half-finished
edit. Runs 2–3 exposed two harness defects, both fixed: the SPA rebuild stamp predated the
sources the build read (WI-10006797), and Playwright's `response.body()` returns an empty body
for audio the page plays as media, so the spec now captures TTS bytes with
`page.route` + `route.fetch`.

### Run 4 (2026-10-06T17:42:36Z, run `20261006T174240Z-575393`)

| Leg | Result |
|---|---|
| Push-to-talk: fake-mic Kokoro pangram → real PTT path → local Whisper | PASS |
| Reply playback (Kokoro): `speak()` → `operator-tts-preview` → captured audio → Whisper | PASS |
| Reply playback (ElevenLabs) | FAIL: the isolated database starts with no voice credentials, so ElevenLabs reported unhealthy |
| Stop, denial, retry | not run (serial mode stops after the first failure) |

Log: `.papercusp/scratch/d006-rig-run4.log` (2 passed, 1 failed, 3 not run).

Fix for run 5: the rig's assertion script (`.papercusp/scratch/d006-rig-assert.sh`) copies the
live workspace's encrypted voice-credential row into the throwaway rig database under the
rig's workspace id before Playwright starts. The secret is never printed, and the rig
database is deleted on teardown. Run 5 also adds the brain leg: a spoken question is posted
as a turn, the agent answers, and the spoken answer is captured and transcribed.

### Run 5 (2026-10-06T17:51:30Z, run `20261006T175130Z-1016388`) — found a product defect

The seed worked (`RIG_SEED voice_credentials rc=0 0 rows=1`; rig health `elevenlabs:true`).
Push-to-talk and the Kokoro reply passed again. The ElevenLabs reply failed: with the user's
engine set to ElevenLabs, the desktop client still requested `engine=kokoro`.

Root cause (WI-10006826): `voice-mode.ts` cached the TTS engine for 30 seconds, and a boot-time
prime filled that cache before the prefs sync had delivered the user's choice. A user who chose
ElevenLabs heard Kokoro for the first 30 seconds after opening the app, and an engine change in
Settings took up to 30 seconds to apply. Fixed by reading the prefs on every utterance; guarded
by a unit test in `apps/operator/app/_components/voice/voice-mode.test.ts`. The spec now waits
until the client reports the expected engine before it speaks.

Log: `.papercusp/scratch/d006-rig-run5.log` (2 passed, 1 failed, 4 not run). Run 6 waits for an
SPA build that contains the fix.

### Run 6 (2026-10-06T18:01:03Z, run `20261006T180103Z-1545361`) — PASS, 7/7

The rig waited for an SPA build containing the WI-10006826 fix
(`VERIFY_TAURI_REQUIRE_BUILT=apps/operator/app/_components/voice/voice-mode.ts`; build stamp
18:03:20Z, newer than the edit). `voice-mode.ts` was committed by git-sync in `1256f9f789`
(18:03:02Z). Seed: `RIG_SEED voice_credentials rc=0 0 rows=1`; rig health `kokoro:true`,
`elevenlabs:true`.

| Leg | What it proves | Result |
|---|---|---|
| Push-to-talk | fake-mic Kokoro pangram → real PTT capture path → local Whisper transcript | PASS (7.5 s) |
| Reply playback (Kokoro) | `speak()` → `operator-tts-preview` engine=kokoro → captured audio → Whisper matches the reply | PASS (6.0 s) |
| Reply playback (ElevenLabs) | user engine set to ElevenLabs → client requests engine=elevenlabs → captured audio → Whisper matches | PASS (6.5 s) |
| Stop | cancelling mid-reply ends playback and it stays stopped | PASS (4.5 s) |
| Denial | a blocked microphone names the permission problem | PASS (3.1 s) |
| Retry | an STT failure is reported, and the next hold transcribes | PASS (13.2 s) |
| Brain | spoken question → posted turn → agent answer → answer spoken → captured and transcribed | PASS (8.4 s) |

Result line: `HARNESS_RESULT harness=verify-tauri-headless verdict=pass run=20261006T180103Z-1545361`;
Playwright `7 passed (51.9s)`. Log: `.papercusp/scratch/d006-rig-run6.log`. This closes the
live check for WI-10006826: the ElevenLabs leg failed in run 5 on the cached `kokoro` engine and
passes in run 6 with the cache removed.

## Hosted portal — reaches the chat-create refusal; round trip moves to the guided session (D-009)

Spec: `portal/e2e/portal-voice-synthetic-roundtrip.spec.ts` (portal checkout), run as
`PORTAL_VOICE_SYNTHETIC_E2E=1 PORTAL_VOICE_SYNTHETIC_EVIDENCE_OUT=<receipt> npx playwright test e2e/portal-voice-synthetic-roundtrip.spec.ts --reporter=list`.
The fixture admits an isolated WorkOS TEST tenant (no help from Avi needed) and deletes it afterwards.
The browser is system Chrome with the fake media device. An init script replaces the mic track with a
Web Audio track, and the spec plays Kokoro speech into it.

What a fresh TEST tenant can reach, measured in runs 2–6 (logs and receipts in
`.papercusp/scratch/d006-portal-run{2..6}*`):

- Instrument control passes: Whisper transcribes the Kokoro question (run 2 onward, after the spec's
  Whisper path was fixed to `/v1/audio/transcriptions`).
- Sign-in passes: `/api/hosted/auth/session` returns 200 with an `organizationId`, and `workspaceId` is null.
- Shell entry passes: `/?firstRun=deferred&chatPane=true` gets past the first-run card and opens the
  chat dock that holds the voice control.
- **Chat create is refused** (run 6, 18:43:27Z): GET and POST `/api/papercup-chat/conversations` both
  return 403 `{"ok":false,"error":"portal_chat_workspace_not_selected"}`. A portal chat runs on the
  selected workspace's own machine (`portal/apps/host/src/chat-instance-boundary.ts`), and a TEST tenant
  has none. Without a conversation there is no voice room. Without a room, push-to-talk never asks for
  the microphone, so the denial check cannot run either.

**Product defect found: WI-10006841.** Before the fix, the voice control showed "Connecting voice…"
(button "Voice mode — connecting") for the whole 60 s timeout. The page's only alert was empty, because
the shell's periodic refresh clears the shared error banner whenever it succeeds. Fix: the shell keeps a
separate voice-start error, and the voice control shows the refusal as a sentence
("Voice needs a workspace — create or select one, then retry.") on its retry button and status line;
Retry asks for the chat again. Unit tests are in `portal/tests/voice-session.test.ts` (11/11 pass) and
the portal typecheck is clean (2958 files at 19:01Z).

**Live check of the fix — run 7, PASS** (2026-10-06T19:12:24Z–19:12:30Z, against release
`72kJ33-m_qtCIfpcyrT1n`, portal commit `c269bd1c`). The 19:10 reconcile promoted that release but did
not restart the portal (EI-24484616826768773), so it was restarted by hand at 19:11:50Z. The new
serving process's cwd is that release, and the live chunk carries the new message. Results: GET and
POST `/api/papercup-chat/conversations` returned 403 `portal_chat_workspace_not_selected` at
19:12:29.639Z / .841Z. The control named the refusal at 19:12:29.896Z: status text "Voice needs a
workspace — create or select one, then retry.", button "Voice mode — push-to-talk". Nothing opened
(0 peer connections, 0 microphone calls, 0 microphone tracks). Playwright: `1 passed, 2 skipped
(16.4s)`, exit 0. The two skips are the workspace-dependent tests (D-009). Log
`.papercusp/scratch/d006-portal-run7.log`, receipt `.papercusp/scratch/d006-portal-run7-receipt.json`.

Rescope (plan D-009): the spec's first test now checks that the refusal is named and that no room and
no microphone open. The spoken round trip and the denial test skip with a stated reason when the account
has no workspace, and run unchanged on an account that has one. The hosted spoken round trip and
microphone denial on the portal are covered by Avi's guided session (D-005), on his account, which has a
workspace. No synthetic portal round-trip evidence is claimed for this release.

## R-4 lifecycle and recovery on the desktop rig (P-004, WI-10004760)

Spec: `apps/operator/e2e/voice-synthetic-roundtrip.spec.ts`, run inside an isolated
`verify-tauri-headless` rig (`VERIFY_TAURI_ISOLATED_DB=1`, SPA freshness required on
`voice-mode.ts`, one worker) by `.papercusp/scratch/d006-rig-assert.sh`.

### Runs

| Run | When (UTC) | Rig run id | Result | Log |
|---|---|---|---|---|
| 1 | 19:54Z | — | 7 passed, 3 failed (red-first) | `.papercusp/scratch/r4-rig-run1.log` |
| 2 | 20:07–20:15Z | `20261006T200744Z-1065105` | 9 passed, 1 failed (spec bug) | `.papercusp/scratch/r4-rig-run2.log` |
| 3 | 20:17–20:28Z | `20261006T201756Z-1692605` | **10/10 passed**, HARNESS_RESULT verdict=pass | `.papercusp/scratch/r4-rig-run3.log` |
| 4 | 20:28–20:43Z | `20261006T202848Z-2437388` | 10 passed, 1 failed (navigate leg, spec bug) | `.papercusp/scratch/r4-rig-run4.log` |
| 5 | 20:45–20:56Z | `20261006T204526Z-3393922` | **11/11 passed**, HARNESS_RESULT verdict=pass, RIG_EXIT=0 | `.papercusp/scratch/r4-rig-run5.log`; ledger artifact `r4-rig-run5-2026-10-06.json` |

What the reds were:

- **Mute (run 1, product defect).** Muting voice output mid-reply did not stop the reply already
  playing. Fixed in `voice-mode.ts` (mute stops current playback). Run 2 and run 3: PASS.
- **Muted reply never completed its turn (WI-10006893, product defect, found by code reading).**
  `speak()` returned at the output gates before recording the canonical sentence and completion, so
  the next utterance recorded the muted turn as interrupted. Fixed by recording completion before
  every output gate. Unit test in `voice-mode-capture.test.ts`; a mutation probe that restores the old
  behaviour fails exactly that test (`.papercusp/scratch/wi10006893-mutation-probe.log`, verdict caught).
- **TTS outage (run 1, spec race).** The spec waited on the voice status, which turns `speaking`
  before the synthesis request is sent. The spec now waits on the request. Run 2 and run 3: PASS.
- **Brain turn identity (runs 1 and 2, spec bugs).** Run 1 counted every POST to
  `/conversations/:id/turns`; the client also persists the agent's reply there. Run 2 confirmed this
  by measurement: exactly one `role:'user'` POST per hold. Run 2's remaining red compared the raw JSON
  body, where a newline is escaped as `\n`. The spec now parses each body and requires the posted user
  text to equal the transcript the user was shown. Run 3: PASS.
- **Navigate (run 4, spec bug).** The leg pushed the literal `/harness` path and asserted the URL
  matched it. `/harness` is a router alias: the app moved to `/adv` and the assertion timed out
  before any microphone count was taken. The `/settings/voice` hop in the same run had already
  succeeded. The leg now returns to the path the shell actually settled on.

### Scenario map (bar R-4: each scenario needs a named live test)

| R-4 scenario | Synthetic rig leg (this file) | Real microphone (guided session) |
|---|---|---|
| Interruption | `stop: cancelling mid-reply ends playback and stays stopped` | A3, C4 (speaking over a reply) |
| Output mute | `mute: muting mid-reply stops it, a muted reply stays silent, unmuting speaks again` | A5 |
| Off cleanup | `off: turning voice off releases the microphone and stops a reply mid-playback` | A6, C3 |
| Navigation / unmount cleanup | `navigate: moving between screens keeps one microphone, and off still releases it` (run 5) | — |
| Permission denial | `denial: a blocked microphone names the permission problem` | A9, C5 |
| Provider outage | `tts outage: …` and `retry: an STT failure says so, and the next hold transcribes` | — |
| Reconnect / retry | `retry: …` | C5 |
| Self-audio | none. The fake microphone has no acoustic path from the speaker, so a synthetic run cannot produce echo; the capture-overlap guard is unit-tested | **A4 is the only live evidence** |
| Turn / transcript identity | `brain: a spoken question is posted, answered by the agent, and the answer is spoken` | A1, C2 |

Hosted credential, tenant and spend isolation belong to R-7 and the hosted portal section above (D-009).
