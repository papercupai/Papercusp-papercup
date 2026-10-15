# Mobile apps (Android + iOS) — monitoring and Android release grading runbook
URL: /internal/docs/agent-insights/mobile-apps-monitoring-first

Mobile app/device API, push, build and rig gotchas, plus the complete Android public-release grading runbook preserving source, native, cloud/BYOC, Play and public-install evidence floors.

The phone app is a **monitoring interface, not a work surface**. The desktop is
where the owner works; the phone shows what the fleet is doing and what needs the
owner, with **no execute/approve/claim affordances**. Keep that principle when
extending it — add read-only tiles and attention producers, not action buttons.

## Where the code lives

* **App:** `papercup-rust-mobile/` is a separate Git repository in its own main
  checkout, currently on branch `master`. Use normal guarded native edits, such as
  built-in `apply_patch`, with the lock mode reported by the current runtime's
  `coord:orient`. The worktree guard in
  `apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh` explicitly exempts
  independent sibling repositories whose readable origin differs from the
  canonical Papercusp project: this app uses `Papercusp/papercup-rust-mobile.git`,
  while the platform uses `Papercusp/papercup.git`. Do not bypass an edit denial
  or edit a linked Papercusp worktree.
  Mobile edits are covered by the existing automatic git-sync route, verified
  from its authored commits on 2026-10-07. Leave changes for that routine; do not
  manually commit or push. Verify the current repository identity and sync
  receipt before claiming a change committed. Rust core (`crates/papercup-core`)
  * UniFFI bindings, Jetpack Compose (Android), SwiftUI (iOS).
* **Server (device API):** `packages/operator-core/lib/endpoint-route/routes/device/*`
  — `defineTool` routes gated by `DEVICE_AUTH` (`{ kind: ['device'] }`). The phone
  reaches them at `https://api.papercuspai.com/api/device/*`.
* **Device auth:** `lib/device-jwt.ts` (HS256, `MOBILE_JWT_SECRET`), `lib/device-store.ts`
  (paired devices + push tokens), `lib/device-push-dispatcher.ts` (FCM + APNs send).
* **Monitoring producers:** `lib/device-monitoring.ts` (fail-soft, dependency-injected).

## The gotchas that cost hours

1. **The public URL tunnel is Cloudflare-DASHBOARD-managed.** `api.papercuspai.com`
   is served by `cloudflared` (tunnel `c53515b3`, user unit
   `cloudflared-papercupai-api.service`) whose ingress config lives in the
   Cloudflare **dashboard**, not the local `~/.cloudflared/papercupai-api.yml` —
   editing that local file does **nothing** (and SIGHUP-ing cloudflared after a
   bad local edit can kill the tunnel → both domains 530). If the public API is
   down, check the systemd unit is `active` first; don't touch the local yml.

   ⚠ **This dev box's resolver LIES about `papercuspai.com` — never probe prod
   reachability with a from-box `curl` (2026-07-16, EI-12998).** The machine is on
   Tailscale; its resolver (`Current DNS 100.100.100.100`, search `*.ts.net`)
   returns a **stale split-DNS override** for `papercuspai.com` → `18.204.152.241`
   (a dead old AWS EC2) with a **max-uint TTL (4294967295)** — the signature of a
   static override. So every `curl https://api.papercuspai.com/...` from this box
   hits the dead IP and looks like a total prod outage when prod is fine. Two
   agents burned hours "fixing" a non-existent DNS outage this way. **Verify prod
   from an EXTERNAL vantage instead:** DNS via DoH (`curl
   https://dns.google/resolve?name=api.papercuspai.com&type=A` →
   Cloudflare-proxy IPs when healthy), HTTP via an external fetcher (`curl
   https://r.jina.ai/https://api.papercuspai.com/api/device/attention` → `200`
   with the operator's `{"error":{"code":"unauthorized",...}}` device-auth JSON
   when healthy). A real phone is not on this tailnet and reaches prod normally.
2. **`/api/health` 404 on the public domain is a red herring** — it routes to a
   different internal port (`:3057`), not `:3070`. The phone never calls it. Test
   reachability with a real device route (`/api/device/attention` with a device JWT).
3. **`MOBILE_JWT_SECRET` durability = device-token durability.** Device JWTs are
   HS256-signed with it; if it's unset in dev, `getSecret()` mints a **per-process**
   secret that rotates on every restart → all paired phones silently stop working
   until they re-pair. It's set durably in `apps/operator/.env.local` (gitignored,
   survives deploys, identical in the release + staging trees). `mobileJwtSecretStatus()`
   reports durability; a one-time boot/first-use warning fires when it's ephemeral.
4. **Two-port model applies.** Device routes run on the GREEN operator (`:3070`,
   release checkout). A server-side device-route edit reaches `:3070` only via the
   deploy pipeline (or a forced `deploy-cli --execute`); `:3170` is staging. Probe
   where your write actually lands.

## Push (the owner's remote control)

Both providers **mint their auth token in-process** (the old design expected a
pre-signed env token refreshed by a job that never existed, so pushes silently
no-op'd):

* **FCM (Android, LIVE):** `google-auth-library` JWT client signs a service-account
  JWT from `FCM_SERVICE_ACCOUNT_PATH` (default `~/.papercusp/firebase-admin.json`,
  project `papercusp-mobile`) → OAuth access token → HTTP v1 send.
* **APNs (iOS, DORMANT):** `jose` signs an ES256 provider JWT from a `.p8`
  (`APNS_KEY_PATH`/`APNS_KEY_ID`/`APNS_TEAM_ID`), cached \~50 min, sent over
  **HTTP/2** (APNs rejects HTTP/1.1). **Blocked on Apple Developer enrollment** —
  absent creds ⇒ cleanly skipped, so iOS registration is harmless until enrolled.

Unconfigured providers are skipped, never thrown — `dispatchPush` returns
`PushSendResult[]`. `pushEnabled()` reports which providers are live.

## The monitoring surface (Phase B)

`lib/device-monitoring.ts` exposes fail-soft, dependency-injected producers reused
across routes — a failed read returns a `null` tile, never a broken dashboard:

* `releaseGateTile()` — reuses `fetchOrientPipeline` (cached). `stale-verdict` is
  **not** treated as red (load-bearing silence — don't raise a phantom alarm).
* `poolTile()` — `accountStatus` + `accountRoutingExhausted` (inference-pool health).
* `fleetsAndPotsTile()` — `listPresence` + `fetchPresenceFleet`, grouped by fleet + pot.
* `connectionTile()` — `deviceConnectionSnapshot` (paired? push registered? secret durable?).
* `systemAlerts()` — PURE composer: red-gate + pool-exhaustion → owner-attention alerts.

Routes: `GET /device/monitoring` (all tiles), and `GET /device/attention` carries
`systemAlerts` alongside its existing `groups` + `workItems`. Most owner-attention
surfaces (fleet-leader escalations, open owner questions, needs-human) are **already**
produced by `plans:attention` (which the device attention route reads) — only the
system-health conditions (red-gate, pool-exhaustion) were missing.

## Building

Android: `cd papercup-rust-mobile && export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/27.0.12077973
ANDROID_HOME=$HOME/Android/Sdk && make tokens bindings-kotlin && tools/build-scripts/build-android.sh`
(the last step does the 4-ABI cargo-ndk release cross-compile + `gradlew assembleDebug`;
`make build-android` additionally runs `install-and-launch.sh`, which needs an adb
device). APK → `android/app/build/outputs/apk/debug/app-debug.apk`. iOS: needs the
Mac VM (`ssh -p 2222`, `~/.papercusp/build-vms.env`) + `make build-ios`.

For automated microphone endurance tests, keep the Android emulator **windowed**
even on an Xvfb display. Emulator 36.5.11 and 36.6.11 both exit 139 on the first
gRPC `injectAudio` stream when launched with `-no-window`; the same AVD and audio
payload remain online when launched with a display, `-grpc 8554`,
`-allow-host-audio`, and `-gpu swiftshader_indirect`. Treat one pilot audio
injection plus an `adb get-state` check as the rig preflight before a multi-turn
soak, so a harness crash cannot masquerade as an app stability failure.

### The working rig (2026-07-16, verified 10/10 STT+TTS)

A reusable rig lives at `~/.papercusp/scratch/voice-endurance-20260716/`
(`injectord.py`, `turns.sh`, `ui.py`, `rig.py`, generated 16 kHz WAVs). Three
non-obvious rules cost hours before the soak ran clean — bake them into any
future rig:

1. **`injectAudio` crashes the emulator unless a guest recorder is actively
   consuming the stream.** In the default `MODE_UNSPECIFIED` (blocking) delivery
   mode the emulator only pulls packets while the app holds an `AudioRecord`;
   pushing audio (even silence) with no active recorder overflows/SIGSEGVs it
   within \~4 s. So the injector daemon holds **one** `injectAudio` stream open
   for the whole campaign but **yields nothing while idle** (never a silence
   keep-alive) and streams WAV chunks only on command — and it **never closes**
   the stream (closing it also SIGSEGVs the emulator). Per turn: tap the Voice
   FAB → `LISTENING` → drop a `play <wav>` command → tap the FAB again to stop
   and send. Rows land in `harness_shared.operator_turns` (`source` =
   `voice_stt` / `voice_tts`).
2. **Run the emulator on your own dedicated Xvfb display** (e.g. `:99`), not a
   shared one. A peer reaping the shared `:90` kills the emulator with
   `XIO: fatal IO error on X server` mid-run.
3. **Liveness is `adb get-state`, never a `pgrep` for the AVD name.** The running
   process cmdline is `qemu-system-x86_64 -avd papercusp-test` (no `.avd`), so a
   `pgrep -f papercusp-test.avd` always misses and reports a healthy emulator as
   dead. Worse, `pkill -f` with any pattern containing `papercusp-test`,
   `injectord.py`, or an AVD path **self-matches your own shell** (exit 144) and
   also matches the unrelated `papercusp-testvm-clean` VM — kill by the exact
   qemu pid via `pgrep -f "Sdk/emulator/qemu/linux-x86_64"` instead.

Pre-grant `RECORD_AUDIO` (`adb shell pm grant … android.permission.RECORD_AUDIO`)
so the mic session opens without a dialog mid-soak; the app's pairing credential
survives an `install -r` on the persistent userdata partition, so re-pairing is
usually unnecessary across relaunches of the same AVD.

## What stays owner-gated

* **APNs enrollment** — Apple Developer account + `.p8` key (iOS push is dead until then).
* **On-device verification** — the owner re-pairs their own phones (`/settings/mobile`)
  and confirms a push actually lands; can't be done without their devices.
* **Graduating the `mobile-pairing` onboarding item** out of `ONBOARDING_PREVIEW_FEATURES`
  — wait until pairing + push are owner-verified end-to-end (Android works; iOS pending
  enrollment), or a fresh install is promised notifications that don't fire.

## Android public release grading procedure

This runbook extension supplies the reproducible procedure for
`acceptance-android-public-release-2026-10-01`. Reuse the common completion
sequence in [Plan completion — code-truth audit, acceptance grading, and ship verdict](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook).
The release plan and its current rubric govern this campaign's companion scope;
the historical monitoring-only description earlier in this page does not remove
the plan's chat, approvals, voice or BYOC journeys.

This section is procedure preparation, not an executed grading, a fresh trial
grant, native acceptance or a shipped-release claim. At preparation on
2026-10-11 the baseline is plan revision 87 and rubric revision 6, criteria hash
`fab14f2f3bb201b59c9300573a4f572536fddeb2bacf4087a5a03e25a65fc30c`, BAR-set hash `777d1b468793e6ab9908eafbd0da1c0de02cb17b6b17b5ad6698177a5efd231e`.
Read current authority at execution time; the reference amendment may advance
the rubric revision without changing the BARs. A later revision is not permission
to replay a consumed attempt.

### 1. Establish authority and exact subjects

Read `plans:get` for `android-public-release-2026-10-01` in harness
`papercusp`, its current Decisions, and full `rubrics:get` for the acceptance
rubric. Record plan revision/content hash, rubric revision/criteria/BAR hashes,
all 13 keys, each criterion's unchanged model, method, numbered falsifiers,
evidence plane, required scope and declared test layers. Read current linked
work-items and their saved evidence before reconstructing any result.

Preserve D-022's owned replacement executor acceptance plane and D-025's
exclusive build-output custody. Keep D-024's service-context strict-reader
absence versus recovered-configured-reader root-cause question open until its
distinguishing evidence exists; detector diagnostics do not answer it. Preserve
the complete hosted/BYOC/physical-phone journeys, native-abort evidence and the
combined portal iPhone residue.

D-023's direct-download-first ordering permits progress on a direct APK slice;
it does not silently satisfy or drop R-10, R-11 or R-12's Play evidence. Version
0.1.1/code101 is the retained direct-download choice under D-025, not proof of
complete historical Play version ordering. Read D-026's retained candidate
identity. A new source, candidate byte or counterpart-runtime identity requires
an explicit currentness comparison and the affected evidence to be refreshed.

Read the current custody and execution restrictions before touching a runtime.
D-029 is consumed; the diagnostic-only detector close grants no main, network,
admission, browser, native, build, install, upload or deploy run. Do not replay
D-027/D-028/D-029, create another fixture, mint pairing credentials or rebuild to
recover already retained evidence. The existing retained3790/positive357e
custody question is already asked: consume its supported answer; do not reask,
wake, transfer or fork that lane.

### 2. Assemble retained evidence before requesting execution

For each evidence record capture: owning work-item and lane; exact source/spec
revision and fingerprint; mobile/operator/portal runtime identities; candidate
APK/AAB hash, package/version/signing identity; device/OS/ABI/page-size/network
route; test runner and canonical test path; ledger run id and source recorder;
collected/executed/passed/failed/skipped counts; start/end/exit; durable source
path and content hash; currentness comparison; cleanup/custody receipt; and
the criterion's conditions and falsifiers actually observed. State unknown
fields explicitly and redact bearer, QR, cookie, secret URL and provider data.

Keep these evidence stages distinct: source qualification; actual automatic
verification; signed production; bounded install/launch; publication and
recipient exact-byte retrieval; compiled portal CTA; authenticated click and
download; complete native/hosted/BYOC journeys; Play admission; public physical
installation; final release observation. One stage never implies the next.
In particular, retained API36/16 KB emulator install/launch and a public curl
hash do not prove physical-phone journeys or an authenticated portal click.

Inspect exact retained test logs and original-source recorder identities.
Distinguish local dirty qualification, as-committed proof and the serving
artifact. Reject empty/skipped relevant suites, missing phases, unresolved
source provenance or identity mismatch as acceptance evidence. Rerun a suite
only for an actual changed subject or missing required measurement, never to
reconstruct a saved command. A numeric Fetch status and Playwright
`status()` control/refusal/throw regression is detector evidence only.

### 3. Reproduce and rate the complete criterion population

The table is an execution index. For each row the full current rubric METHOD,
original intent, verification conditions and every numbered drift marker are
the checklist; this table neither replaces nor narrows them. Read all entries
and retain a condition-by-condition result, including failed and passing
observations. No aggregate success can hide an unmeasured subcondition.

| Key  | Criterion                                  | Required evidence plane | Procedure and retained observation                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r-1  | Current-platform change census             | tree                    | Reconcile August-to-current mobile/server history, current consumers and supported desktop/cloud versions; map each gap and scope decision to its owning P-item.                                                                                                                            |
| r-2  | Wire and authentication compatibility      | tree                    | Inspect complete maintained Rust/binding and device-contract results for request/response/error, token rotation/revocation, workspace, sync and streaming scenarios; require the declared integration and unit layers.                                                                      |
| r-3  | Companion feature correctness              | live                    | Compare signed-app chat, plans, attention/approvals, workspace/pot, agent/fleet and diagnostic screens with their current runtime writers, including missing/error data.                                                                                                                    |
| r-4  | Secure remote access                       | live                    | Rate pairing and authenticated requests separately on each supported encrypted Wi-Fi/cellular/mesh/tunnel route; inspect protected credential storage, revocation, scope and reconnect evidence.                                                                                            |
| r-5  | Voice and notifications                    | live                    | Cross every declared desktop-local/cloud voice, wake-word and push journey with actual turn/delivery, consent, denied permissions and cleanup; include foreground/background/terminated delivery and deep links.                                                                            |
| r-6  | Repeatable automatic verification          | tree                    | Inspect a meaningful source change's actual scheduled executor trigger and complete retained phases, cache/source/tool/operator/APK/native-result identities, failed-publication refusal, cleanup and exclusive output custody. Manual execution alone cannot pass.                         |
| r-7  | Current signed candidate                   | tree                    | Reconcile clean-source APK/AAB, package/version/signers, target SDK, every native ABI and 16 KB ELF/ZIP alignment, mappings/symbols, bundle validation and provenance/uploader refusal guards.                                                                                              |
| r-8  | Accurate public disclosures and collateral | live                    | Compare exact-candidate permissions, Firebase/cloud-voice behavior, licenses, submitted listing/screenshots/graphic and reviewer instructions; independently resolve privacy/support/deletion guidance when execution is authorized.                                                        |
| r-9  | Device and lifecycle acceptance            | live                    | Require the exact signed candidate on a current physical phone and suitable old/current/16 KB emulators; rate upgrade, accessibility/font/rotation, denial, process death, background/offline/reconnect and ordinary chat/voice/push/pairing; inspect crash/ANR/data loss.                  |
| r-10 | Play test-track acceptance                 | live                    | Require exact-AAB Play ownership/certificate/version admission, account eligibility/declarations, pre-launch checks, working reviewer access and representative external tester install/upgrade/pairing.                                                                                    |
| r-11 | Authorized public rollout                  | deployed                | Bind the standing candidate/track authorization to reviewed passing track evidence; independently observe matching public Play availability and physical-phone installation plus a critical journey and owned bounded observation.                                                          |
| r-12 | Durable completion evidence                | deployed                | Reconcile engineering, test-track, public and post-rollout records separately; independently verify source/artifact/support identities, grading, author verdict and named follow-up owners; retain all blockers.                                                                            |
| r-13 | BYOC cloud workspace compatibility         | live                    | Require an off-LAN release phone to pair via portal QR and complete chat/plans/approvals/monitoring/voice/push through a real BYOC relay; inspect Noise XX sealing/plaintext refusal, oversized intact bodies, offline semantics, bearer/allowlist/unchanged VM 401 and supported versions. |

For R-2 use the maintained mobile workspace cargo/device-fixture suites and
their documented runner. For R-6 use the maintained Make
`test-android-ci` and `test-android-runner` guards and the current owned
scheduled executor's complete record. For R-7 use the maintained release
producer and `android-release-provenance.sh verify` result plus artifact
inspection records. These commands describe the required execution routes;
they are not instructions to run them during procedure-only preparation.
Use the owning framework for each test; the Papercusp `test:file` router is
Vitest-only. Prefer retained exact-source proofs over another expensive run.

For live/deployed rows, obtain the existing lane owner's exact candidate,
device/runtime custody and bounded run prerequisites before any authorized
journey. Verify the runtime actually serves the nominated bytes. A procedure
without that custody remains prepared and unexecuted. On two expensive
failures with different causes, audit the harness and add pre-run guards before
another attempt; do not retry a consumed grant.

R-13 explicitly includes path-prefixed bases, relay-pair baseUrls kind,
workspace\_offline mapping, cross-implementation Noise XX vectors and 512 KiB
chunking in contract proof, followed by the real off-LAN signed-phone matrix.
R-4 protected storage and R-5 real capture/playback/cancellation/FCM evidence
need their native measurement; an HTTP fixture cannot replace them.

### 4. Preserve falsifiability, independence and accountable residue

Rate each criterion using the unchanged scale
`healthy / degraded / broken / unknown`. Healthy requires its full outcome,
every verification condition, declared layers and current promised evidence
plane. An observed falsifier prevents healthy. Distinguish observed failure
from missing measurement; preserve unknowns explicitly, including the
rubric's pre-rollout unknown rule. Do not infer green from a phase label,
a source test, a missing error or another agent's announcement.

For mutation/counterexample adequacy, retain the ledger-backed exact case's
measured failure and a current passing baseline targeting the same accepted
clause. Binder-authored `falsifiable:true` or a pass-only probe is insufficient.
Keep source/spec/test/fixture/runtime fingerprints alongside the case titles.
Inspect current bindings and adequacy before claiming they apply to a revised
subject. Source qualification is not operational acceptance.

The leader/implementer may prepare evidence and this procedure. A
non-implementer must perform the plan's independent grading. Complete ratings
must cover exactly r-1 through r-13 and cite current evidence plus explicit
limits; use the existing scorecard/evidence surfaces, not a parallel gate.
Reconcile each out-of-scope residue to a named assignee before closure.
Preparing or completing a narrow procedure work-item must not mark P-015 or
P-016 done; those parents retain their execution acceptance obligations.

### 5. Record the verdict and stop at the measured boundary

Follow the common runbook's code-truth audit, current rubric vetting, proof and
adequacy, independent scorecard, and rubric author's explicit verdict.
A methodRef binding is a reference, not an acceptance score or author verdict.
After each contract/reference mutation, inspect its returned revision and
invalidation metadata; never assume old grading remains current.

Only the canonical shipment gate can establish a shipped plan. Keep direct
download readiness, Play readiness and public availability distinct. Do not
close known native-abort, service-context cause, full journey or iPhone
activation gaps as collateral to a successful Android slice. Any observation
window has a registered owner, a concrete next action, a named stop condition
and a bounded no-delta budget. Finish each unit with durable evidence and
custody/cleanup disposition; do not add a second monitor to another live
owner's lane.
