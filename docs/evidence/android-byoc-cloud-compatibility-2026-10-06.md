# Mobile (Android + iPhone) ↔ BYOC cloud workspace compatibility — 2026-10-06

Plan `android-public-release-2026-10-01` P-015 (D-008, D-009). Author: su-deb0a62a (android-release member 2).
Initial research was done before P-015 had a work item. Implementation and acceptance are tracked in
`WI-10006956`; native integration is `WI-10006994` under D-018, and runtime publication is `WI-10007013`.

## Current compatibility and release evidence — 2026-10-07 successor verification

This section supersedes the historical gap analysis below. Governing decisions are Android plan
D-013 and its amendments D-017 (exact URL), D-018 (native ownership), D-019 (sealed ingress), and
D-020 (bounded upload frames), plus D-021 (sealed phones on both hosting classes). P-015 is **open**:
server proofs do not establish a supported public
Android/cloud release combination.

### Release identities and support boundary

| Component / combination | Exact identity read | Verified extent | Public cloud support |
|---|---|---|---|
| Existing workspace runtime r63 | `0.0.21-p318r63`, source `9a3383955506d4f6d6e856527a041e443961236a`; bundle SHA-256 `b9ac9540801fc544a8a117e1d1c5da6813e6877ae3010071e2c504cc3cb9210b` | Local `wh-release-r63/build-result.json` records a built artifact. At that source, the host, HTTP channel and portal handler lack `device-http`, `bodyChunked` and `attachSealedDeviceSocket` respectively. This read does not prove which artifact a VM currently runs. | Not a P-015 compatible runtime. |
| Runtime cut r65 | `0.0.21-p318r65`, source `256a4151bca0d9ee0e04ffc60bf0058980cba442` | Local `release-cut.json` exists; `build-result.json` is absent. Runtime owner records failed sidecar build. This pin also precedes the sealed-error `relay.close` fix in `hosted-session-host.ts`. | No built or accepted candidate established. |
| Runtime cut r66 | `0.0.21-p318r66`, source `fce506df65dfd97fec4704f5c58f87da34306d18`; local `release-cut.json` exists, `build-result.json` absent at 07:52Z | `~/.papercusp/wh-release-r66.log` records `sidecar-build: bash exited 1`. The exact server source proof passed, but no successful runtime artifact is established. | No built or accepted candidate established. |
| Runtime cut r67 | `0.0.21-p318r67`, source `18e31538f81ba0ac5dca37b92d91e7396da4409c` | The five D-021 committed fingerprints match the table below; clean hosted-suite ledger rows `20889334/20889336/20889337/20889338` pass. The runtime owner's later checkpoint records a failed High Sharp 0.35.4 security verdict, tracked by `WI-10007103`; no publication. | Rejected runtime cut; passing device tests do not override its security verdict. |
| Runtime cut r68 | `0.0.21-p318r68`, source `9c6725e66689097f45e45b5d5ec962c569759582`; managed task `0muxx77izthce0e188p`, operation `df050847-df15-4f95-807c-135d992454b6`; built bundle SHA-256 `5b225614ae7e7b09baaa116ba78730f95111c19a5702bfcc0bf6f5bf65ee1ca0` | Maintained committed-source proof passes 104 assertions, zero skips; clean ledger rows `20892010/20892012/20892013/20892014`. Receipt/manifest identities agree. Runtime owner records publication PASS, hosted VM adoption, connector readiness and live QR URL/32-byte Noise key checks. The 12:28Z observation below adds public sealed pairing and a scoped request after portal adoption. | Published and adopted on the hosted acceptance VM; hosted transport probe passes. Actual Android and genuine BYOC journeys pending. |
| Portal / operator source candidate | `fce506df65dfd97fec4704f5c58f87da34306d18`; all five D-021 fingerprints below match its committed blobs. | Maintained isolated as-committed four-suite proof passes 104 assertions with stamped provenance. Exact loaded portal and VM artifacts must still be matched to the final candidate before live acceptance. | Committed source coverage; live acceptance pending. |
| Earlier Android/native source candidate | Mobile HEAD `1930c11b6d913c12b5a7bc632a0d4ede90e2fe4e`; Cargo workspace version `0.1.0` | Android `versionName` comes from `PAPERCUP_RELEASE_VERSION` or default `0.1.0`; it does not identify the APK under test. This earlier source observation is superseded by the dated native consumer proof below. | No accepted APK/cloud pair established. |
| Android JNI interop fixture APK | SHA-256 `ed4534a59ba8eba1b240b2f219ad60a57596ce86628d7d4b44fcf76e5edb0708`; result source base `de09010cec0cd3f84a2bff4624d73019e44190d0`, `sourceDirty:true`, with source fingerprints | Two real JNI/TypeScript Noise responder tests pass, including encrypted restoration, reconnect, 700 KiB upload and UTF-8 streaming. VM fetch is injected; see the 15:14Z observation below. | Local native interop proof; no accepted APK/cloud pair established. |
| GCP Papercusp-hosted acceptance target | Customer workspace `ws-3daf37098c8096b5d9e0ac72` → host `host-3daf37098c8096b5d9e0ac72` | Runtime owner's canonical provider-delegation read classifies it as `papercusp-hosted`, not BYOC. Evidence: `coord-send-1a18b99e1b09f709e8f8f67cd704c6fe876c59b2eeb8b966e21713bc43994744`. | Hosted acceptance pending; cannot satisfy BYOC acceptance. |
| GCP BYOC acceptance target | No active genuine BYOC target established in the supplied inventory | Previously verified BYOC customer rows are deleted. Existing project delegation is preparatory authority, not a provisioned workspace or a phone journey. | Pending maintained provisioning and acceptance. |
| AWS / Azure cloud images | No artifact + Android journey established by this P-015 evidence | Provider renderers existing in source do not prove this mobile contract on those providers. | Not covered by this acceptance record. |

Artifact source files read: `~/.papercusp/wh-release-r63/{release-cut,build-result}.json`
and `~/.papercusp/wh-release-r65/release-cut.json`. The absence observations for
r65/r66/r67 are bounded to those local cut directories, not a census of remote publication.

The supported-release policy for this record is **exact candidate pairs**: record the APK version,
versionCode, source and hash; the portal loaded source; and the workspace runtime version, source and
bundle digest. Claim support only for a pair that completes the hosted and genuine BYOC no-LAN
journeys. No minimum semantic version or range such as “0.0.21 and later” is established by this
evidence. A version label, source-only test, or Papercusp-hosted VM cannot substitute for those checks.

### Current transport and authentication contract

- **Endpoint:** the opaque HTTPS base is `https://app.papercusp.com/api/workspaces/<customerWorkspaceId>`.
  The phone appends `/api/device/<route>`, producing `/api/workspaces/<id>/api/device/<route>`.
  `parseDeviceRelayPath` in `packages/operator-core/lib/workspace-host/hosted-app-relay.ts` and the
  handler route implement D-017. The shorter historical `/api/workspaces/<id>/device/*` is obsolete.
- **Pairing:** `packages/operator-core/lib/endpoint-route/routes/device/pair.ts` obtains
  `hostedDeviceRelayBaseUrl`, advertises `noiseKey`, and requires a canonical phone `noisePublicKey`
  when a machine key is advertised. The VM consumes the pair token and issues the device JWT.
- **Sealed cloud phone channel:** `apps/operator/bin/hosted-handler.ts` upgrades exactly
  `/api/workspaces/<id>/api/device/sealed` for a live BYOC or Papercusp-hosted connector (D-021).
  Both hosting classes advertise a machine key in the QR. The portal transports
  `sealed.packet` values using `papercusp-byoc-noise-xx.v1`; it refuses plaintext BYOC HTTP content.
  `byoc-sealed-channel.ts` terminates Noise on the VM. The host binds the proven phone key to the
  registered device and checks the JWT subject against that device before forwarding a request.
- **Allowlist:** `DEVICE_HTTP_ROUTE_ALLOWLIST` derives from `device-ingress-paths.ts` rather than a
  separate copy. The VM remains the JWT verification/revocation authority. A route refusal is not
  evidence of revoked pairing.
- **Large uploads:** the existing HTTP channel accepts device-only `http.request {bodyChunked:true}`,
  ordered `http.body` frames and `http.end`. Chunks are at most 48 KiB raw; total assembly is at most
  32 MiB (`64 * HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES`). Inline bodies retain the 512 KiB cap.
  BYOC seals each frame. The Rust consumer must implement this before a large native upload passes.
- **Errors:** the current Rust `into_api_error` checks relay-policy codes and `workspace_offline`
  before its 401/403 Unauthorized fallback, and preserves retry-after for offline/rate-limit errors.
  This source mapping does not prove Android credential persistence or reconnect behavior.

### Acceptance still required

The pre-D-021 checkpoint references `test_runs` 20888062 (relay integration), 20888070/72/73/74/75
(five server mutants), and 20888077 (JWT-fixture clock regression); exact bindings are 28351–55 and
28362–66. `/tmp/android-device-stable-fixture-tests.log` records 13 integration + 48 host tests and
`TEST_FILE_RESULT ... status=passed head=746af82e1d uncommittedPaths=1/2`. These are local source
proofs; the fixture test and host close fix still require the final artifact provenance.

That source cohort passed P-015 adequacy for ALLOWLIST, FRAME-CAP, OFFLINE, SEALED and AUTHZ.
D-021 changed the portal and integration-test cohort, so those bindings now need renewal before a
current adequacy claim. The four D-021 focused suites passed 24 handler, 14 assembled relay and
66 relay/broker assertions (`/tmp/android-hosted-sealed-fixed.log`, final process exit 0). The runner
observed HEAD movement `3173d0518f` → `ae714b19c6` and reported `provenance=unknown`; the result
does not establish exact artifact readiness. Before the fix, the new Papercusp-hosted cases failed
with HTTP 403 and refused channel attachment (`/tmp/android-hosted-sealed-baseline.log`, exit 1).
The detector failure was coverage of only BYOC in the real ingress and assembled transport tests;
both now run with each hosting class. Root cause and fix are tracked in `EI-25301141794178113`.

The successor's correct four-file run also passed 104 assertions, exit 0:
`/tmp/android-hosted-sealed-current2.log`. The broker test is
`packages/operator-core/lib/endpoint-route/hosted-workspace-session.test.ts`.
Integration ledger `20888338` is PASS. Final runner provenance is still **unknown** because HEAD
moved `1d5f919a1f` → `c04d8b4de6`; named tests were unchanged, but the runner did not measure
their imported source graph. An earlier attempt with an incorrect broker path refused before
executing tests; its committed snapshot also lacked the D-021 working-tree cohort.

All five fresh private-overlay probes had passing original and copy baselines, caught the mutant,
and exited 0. Logs are `/tmp/android-d021-<name>-mutation.log`:

| Clause | Probe name | Mutant ledger | Renewed mutation binding | Renewed test binding |
|---|---|---|---|---|
| RELAY-ALLOWLIST | `allowlist` | `20888359` | `28413` | `28418` |
| FRAME-CAP | `framecap` | `20888354` | `28414` | `28419` |
| OFFLINE | `offline` | `20888361` | `28415` | `28420` |
| SEALED | `sealed` | `20888360` | `28416` | `28421` |
| RELAY-AUTHZ revision 2 | `authz` | `20888355` | `28417` | `28422` |

The measured evaluator returned five passing server clauses and three failing native/live clauses
for this renewed binding cohort. This is working-tree adequacy evidence; exact committed-source
proof and release readiness remain unresolved. All test/probe processes have completed.

The following SHA-256 values matched the predecessor checkpoint when read after the new runs:

| Repository path | SHA-256 |
|---|---|
| `apps/operator/bin/hosted-handler.ts` | `c47463fd5d340df51d98d83b3293bc3729379acb427cc642ea288a483eeef751` |
| `apps/operator/bin/hosted-handler.test.ts` | `a6a3b4f5546053bb1772ec6ad192126b13c53295a63b2b5ff86f02c9599309e7` |
| `packages/operator-core/lib/workspace-host/hosted-app-relay.ts` | `e2fa9117fbd4ddb2bb163ef623383e006703d1f9c8e685a1e6caec9a8c50a4ed` |
| `packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts` | `938631ed23a826e7fcf0a074205b9a3da53380392d13bf5cf176956dd68d0477` |
| `packages/operator-core/lib/workspace-host/hosted-device-relay.integration.test.ts` | `7f029bd2716cafa6b362dfbf1deaaf86ecf95d0035f47659c8a76169f2985ec4` |

A source-file fingerprint comparison does not resolve the runner's imported-source uncertainty.
Automatic sync is advancing other files while these D-021 paths remain dirty. A sanctioned
background-host sync attempt returned `held_exclusive`; no lease was acquired or bypassed.
The focused file-lock read found no active locks on these four dirty paths, and the routine's
content-error list was empty. The routine reports an active local-sync fire with recent progress;
there is no evidence here that a restart or lock override would be safe or useful.

### Exact committed-source proof — 2026-10-07 07:18Z

This observation supersedes the unresolved pin and dirty-cohort statements above. Independent
`git show` SHA-256 reads at `fce506df65dfd97fec4704f5c58f87da34306d18` match every entry in the
five-file fingerprint table. The maintained runner completed with exit 0:

```bash
npm run lint:as-committed -- test:file --any --ref=fce506df65dfd97fec4704f5c58f87da34306d18 -- apps/operator/bin/hosted-handler.test.ts packages/operator-core/lib/workspace-host/hosted-device-relay.integration.test.ts packages/operator-core/lib/workspace-host/hosted-app-relay.test.ts packages/operator-core/lib/endpoint-route/hosted-workspace-session.test.ts
```

It materialized the commit and pinned submodules into its disposable checkout, then ran the
committed command and runtime exports. Log `/tmp/android-d021-fce506df-pinned.log` records
24 handler, 14 assembled relay, 43 broker and 23 relay-policy assertions passing (104 total),
zero skips, and `TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed
head=fce506df65 uncommittedPaths=0/4 provenance=stamped`. The authoritative `testing:runs`
read confirms clean, non-scratch, `papercusp` rows `20888566`, `20888572`, `20888574` and
`20888575`, each at that full commit. All processes completed; the maintained runner cleaned
its disposable checkout.

The runtime owner received this exact server-ready source pin for the no-publish r66 cut.
The 07:52Z artifact recheck found the cut record and a failed sidecar-build log, with no
build-result file. At 08:56Z, r67's cut record exists at source
`18e31538f81ba0ac5dca37b92d91e7396da4409c`; its five D-021 fingerprints match the table and
the four clean hosted-suite ledger rows pass at that source, while its build-result remains absent.
The source proof is not proof of a built/published runtime, loaded portal, accepted APK, or
hosted/BYOC phone journey. EI-25301141794178113 covers the three hosting gates and their regression
tests; WI-10006956/P-015 retains the broader native and live acceptance scope.

P-015 also remains open for
REFUSAL-KEEPS-PAIRING (real native credential store), OPERATE and OUTCOME (real no-LAN journeys).
The live matrix must exercise QR and manual pairing; token storage, rotation and revocation;
endpoint discovery and reconnect; workspace/harness scope; sync; streaming chat; approvals;
monitoring; voice including large upload; and push. Repeat the relevant native/security tests when
their source cohort changes, then bind the exact final APK and runtime evidence. No shipment is
claimed here.

### Runtime frontier and native prerequisite — 2026-10-07 09:59Z

The runtime owner's latest `WI-10007013` checkpoint supersedes the earlier r67 pending-build
statement: r67 failed its Sharp security verdict, and r68 is now being built privately from the
patched source above. Publication, installation and cloud acceptance remain separate steps.
The immutable r68 candidate has the same five D-021 source/test fingerprints; this comparison
alone does not measure its imported-source graph or prove a successful runtime artifact.

The subsequent maintained as-committed check completed with exit 0 at 10:03Z, using the same
four-suite command above with `--ref=9c6725e66689097f45e45b5d5ec962c569759582`.
Log `/tmp/android-d021-r68-pinned.log` records 24 handler, 14 assembled relay and 66 broker/policy
assertions passing, zero skips, and `TEST_FILE_RESULT requested=4 executed=4 matched=4
status=passed head=9c6725e666 uncommittedPaths=0/4 provenance=stamped`. Independent ledger reads
confirm `20892010`, `20892012`, `20892013` and `20892014` are clean, non-scratch, local
`papercusp` passes at the full candidate commit. This establishes exact server source proof;
it does not establish a runtime security verdict, publication, loaded cloud artifact or phone journey.

Native `WI-10006994` still sequences client integration after `WI-10004768` (P-002). The P-002
owner has published and registered canonical native evidence, repaired Cargo case-identity
handling, and is now repairing a legacy operational receipt through owned
`EI-25313647126738805`. These are evidence-pipeline prerequisites, not the outstanding device
key persistence, pairing request, transport/UniFFI, chunked upload or credential-store acceptance.
The parent retains those checks and the actual hosted/genuine BYOC phone journeys.

### Private artifact ready — 2026-10-07 11:03Z

The completed local `~/.papercusp/wh-release-r68/build-result.json` supersedes
the earlier missing-result observation. Its source, version, operation and bundle digest match
`publication/manifest.json`; the manifest SHA-256 is
`45fb20b3276b1ebb4c5fdcd3c0ec29f595d3c3b67d363e3ed1fcb5d1ddb8858e`.
The manifest trust report has `trusted:true` and no failures. The runtime owner independently
verified all seven receipt-bound file hashes, minisign, final security and privacy at 10:53Z.
This parent consumed those saved proofs and checked the receipt/manifest identities; it did not
repeat the producer's full artifact verification or rebuild the bundle.

The cut was private (`--no-publish`), and the owner records `published:false`. The local manifest's
active lifecycle, publication timestamp and artifact URLs are prepared metadata, not evidence
of a remote upload or an installed workspace. Publication/adoption remain the existing
runtime/leader lane. No accepted Android/cloud pair or public support claim follows from this build.

P-002's 10:36Z checkpoint now records passing execution integrity, falsifiability, layer and risk
checks, with only fixture freshness/calibration unresolved. Native consumer integration remains
ordered after P-002. That dependency and the real hosted/genuine BYOC phone journeys still block
P-015 acceptance; the fixture owner and native owner retain their lanes.

### Hosted VM adopted; portal artifact still old — 2026-10-07 12:06Z

This parent consumed runtime `WI-10007013` checkpoint `a3ddc0566158`; its saved producer
observations supersede the earlier publication/adoption-pending statements. At 11:27Z the
producer recorded `/tmp/wh-r68-publish.log` with `PUBLISH_VERDICT=PASS`, all 63 multipart
parts finalized, the same manifest digest, public HEAD 200 and public SBOM bytes passing.
The maintained upgrade receipt is `/tmp/avi-r68-upgrade-admission.json`, operation prefix
`avi-test-upgrade-r68-20261007-1`. At 11:59Z initialization, desktop pack and connector all
succeeded. The producer recorded operator HTTP registry 200 for
`ws-3daf37098c8096b5d9e0ac72`, QR mint 200 with the expected cloud base URL and a 32-byte
Noise key, and maintained pair-payload evidence `/tmp/avi-r68-p016-evidence.jsonl`.
This parent read the saved evidence; it did not repeat publication, submit another upgrade,
or independently run the producer's live probes.

The same producer measured public and local `:3880` sealed WebSocket upgrades both refusing
with HTTP 403 `sealed_byoc_required`. Loaded `dist-hosted-control-plane/serve.mjs` contains
that old BYOC-only branch, while the D-021 source supports both hosting classes and emits
`sealed_hosting_required`. Portal artifact adoption and the existing sealed probe remain
in the runtime/portal lane; the producer requested action from the iPhone fleet leader in
`coord-send-45d490c065de50f1ad364b98e18d8e33c8b9b62db6f5f3c9248cb5fa4783bf59`.
The hosted VM/QR checks do not establish a successful sealed request, an Android credential
journey or genuine BYOC support.

Native `WI-10006994` checkpoint `43a655905be3` at 11:39Z still retains consumer integration,
chunked uploads and credential persistence after P-002. The Android leader reaffirmed D-018's
ordering at 11:08Z. P-002's saved frontier still needs the fixture producer's readiness and
calibration; no native consumer implementation or phone acceptance is inferred from these
runtime checks. P-015 remains open.

### Public hosted sealed transport passes — 2026-10-07 12:28Z

Runtime owner `WI-10007013` reports portal adoption with loaded PID `3589893`, the updated
`sealed_hosting_required` branch and health 200. Its full producer message is
`coord-send-60cc2dc17a1a5c69f0360e0c913ea386f18488d018ba9f06a49ed1d22fbc2b24`.
This supersedes the earlier BYOC-only portal refusal for the hosted acceptance target. It does
not independently bind the loaded portal bundle to a full source commit or digest.

The producer's fresh QR advertises the public workspace URL and a 32-byte Noise key. Saved
`/tmp/avi-r68-sealed-pair.log` records `NOISE_HANDSHAKE PASS`, `PAIR_STATUS 200` and the required
reconnect. `/tmp/avi-r68-sealed-probe.log` records `NOISE_HANDSHAKE PASS`,
`SEALED_DEVICE_HTTP 200 workspaceMatch true` and `CLEANUP_DELETE_STATUS 200`. The producer
reports reconnecting with the same registered key before the sealed
`GET /api/device/workspaces`. This parent read those saved logs and the full message; it did
not launch another probe. The initial attempt used an unbound pairing channel for a JWT
request and received 401. The subsequent canonical `WI-10007013` terminal receipt records
both test devices revoked, including the first orphan through remote-access/revoke HTTP 200.
The item is `done` with completion authority `committed`; its operational close adds no
tracked source changes. Saved cleanup evidence is `/tmp/avi-r68-device-cleanup-result.log`.

This establishes a public hosted transport probe using a Node client, not an Android phone
journey. Native `WI-10006994` checkpoint `08a8b11f5ab4` at 12:28Z still keeps key persistence,
`noisePublicKey`, QR pinning, transport/UniFFI, D-020 uploads and credential retention after
P-002. P-015 remains open for the exact APK/runtime pair, real credential-store behavior,
large native upload, the complete hosted journey and a genuine BYOC no-LAN journey.

### Native prerequisite closed; consumer integration underway — 2026-10-07 14:11Z

The timeout of native completion await `240234` did not signal native completion. A current
canonical read shows `WI-10004768` (P-002) is now `done`. Native `WI-10006994` remains open;
checkpoint `3ded628ac0aa` supersedes the earlier after-P-002 waiting frontier. Its owner records
an additive `OperatorClient::pair_with_noise(PairBody, &[u8; 32])` implementation, canonical
public-key/no-bearer wire coverage, authenticated follow-up token preservation, and legacy,
auth and offline tests. The focused `cargo test -p papercup-core --test client_test pair`
passed 12 tests, with 62 filtered, zero failures and zero ignored tests; saved producer log is
`/tmp/android-noise-pair-focused-1409.log`. This parent consumed the checkpoint, not a new run.

QR machine-key pinning, persisted phone seed, sealed response streaming, D-020 upload chunks,
additive UniFFI and Android wiring, and cross-language/application verification remain open.
The delivered fleet-leader reply assigns genuine BYOC setup to the leader and says
owner-authenticated setup remains open with no live provisioning lane claimed. This parent
does not duplicate that setup or infer a provisioned BYOC target. P-015 still requires the
exact APK/runtime pair and both complete no-LAN phone journeys.

### Real Android JNI sealed interop passes — 2026-10-07 15:14Z

The native producer's full handoff is
`coord-send-1529e8d31374a712eb0f053152b8ab544132c6aa6d51dba66ec1aed0d1be79fa`.
This parent read `/tmp/android-noise-ts-native-fixed-57/result.json`: `exitCode:0`,
`cleanupVerified:true`, the APK/source identities above, and an explicit scope excluding live
host or portal acceptance. The saved JUnit report has two tests and zero failures, errors or
skips. `qrPairEncryptedRestoreAndReconnectKeepIdentityAndBearerSealed` exercises real JNI
QR parsing/pairing, seed and machine-pin retention in encrypted storage, fresh-client restore,
reconnect and bearer use inside Noise. `restoredNativeClientStreamsUtf8AndChunksLargeSealedUpload`
exercises a 700 KiB request and UTF-8 SSE against the maintained TypeScript responder.
The producer also reports three passing credential tests. This parent did not repeat the run.

The source read confirms the interop test accepts only its owned loopback fixture and asserts
fixture identities. The existing `tools/run-android-checks.sh` `live` mode also requires a
loopback operator and explicitly excludes signed-candidate/phone acceptance. These routes
cannot simply be pointed at the public cloud or counted as that journey. Parent acceptance
must extend the maintained runner/test surfaces for the real hosted QR and opaque HTTPS
workspace URL, preserving isolated device ownership and cleanup. The native producer is
preparing the durable artifact and Swift bindings; the parent requested an artifact/runner
and isolated-emulator handoff in
`coord-send-74b247100750ce01a7dbd390c8864bc3c2ba124e73fc400e6de4f73ddf88bf1d`.
The producer's active emulator is not a parent-owned execution resource.

The subsequent canonical read shows native `WI-10006994` is `done` with completion authority
`proposed`: its producer reports only the durable evidence JSON is awaiting automatic commit
settlement, with the other declared source paths proved. This is not a committed-close claim.
The result's dirty source fingerprints are not an as-committed release proof. Exact
APK/portal/runtime acceptance, complete hosted and genuine BYOC no-LAN journeys, and the
remaining operational checks still keep P-015 open.

The producer released emulator `5584` for parent acceptance in
`coord-send-63e6dd1a18006a71ae4ef674d58d5d09c73e01d0e72997df5be1549d93037889` and
`coord-send-de843d1edef81497b7811c2bf62b8285ea5ea08004acd2ed7c884d48d52b8f43`.
Its owned guest is clean/uninstalled, with no producer process or reverse mapping pending.
Peer emulator `5582` remains outside this handoff; the parent must select `5584` explicitly.
The producer then corrected the shared debug output in
`coord-send-367d8f45eb905d46c0d377e8200348f38d819fe7eea542e8b2d63930b60e36b6`:
its new measured hash is `7ee90600abf3d4f135023c3371ca8ef4c5e7cab1afb01313d36f7b22c2e3460a`.
The interop hash above remains historical proof. Shared build output can advance again;
parent acceptance must capture and verify its exact current APK before installation.

### Maintained public Android runner prepared — 2026-10-07 15:39Z

Parent `WI-10006956` extends mobile `tools/run-android-checks.sh` with
`cloud-native EVIDENCE_DIR PRIVATE_QR_FILE`, backed by `tools/cloud-native-check.py`
and an opt-in branch of maintained `PapercupAppSmokeTest.launcherActivityStarts`.
Explicit `ANDROID_SERIAL` and `PAPERCUP_CLOUD_BASE` preserve the public HTTPS QR
payload, select the owned emulator among connected peers and bind captured APK
bytes to the installed digest. The native branch covers manual QR-payload entry,
encrypted seed/pin restore, activity recreation, fresh-client reconnect, scoped
reads, navigation and owned-device revocation. Failed remote cleanup retains
encrypted recovery credentials.

The maintained `run-android-checks-test.sh cloud` suite passes its public candidate
control and 31 unsafe-input/candidate-race/incomplete-proof refusal controls. SDK
dispatch now receives shared defaults before early native modes; six Rust
toolchain controls pass. Android test Kotlin compilation and test APK assembly
pass, with logs `/tmp/android-p015-cloud-compile.log` and
`/tmp/android-p015-cloud-testapk.log`. These local preparation checks establish
neither a cloud run nor committed-source release proof. Actual hosted execution,
camera scanning, full operation coverage and genuine BYOC acceptance remain open.

Leader replies `coord-send-3bf0ea7cd8337e31a0ed8ea569ca06cfcf218163f70ad8621fb54fef978aa0c1`
and `coord-send-efa17c5ede857607f892c6e0a19c8f2c098d5bfdbb33e594467cf9dbba497dd5`
identify maintained owner-authenticated mint
`POST /api/device/desktop/mint-pair-token {workspaceId}` through hosted operator-http.
The leader explicitly did not mint a fresh payload or measure the current portal
bundle; both remain parent acceptance work. Previous runtime/QR observations
remain dated evidence. No APK/cloud support pair is accepted by this preparation.

### Public native failure isolated — 2026-10-07 16:07Z

The public native run retained in `/tmp/android-p015-public-hosted-native-20261007-1553`
failed before saving credentials. Stage-only logs show `PairException.Decode` immediately
after request start; the test's 45-second wait hid this failure. Local absence of credentials
does not establish absence of a server device. Parent `WI-10006956` asked the fleet leader
to inspect the possible record through the existing host administration route after the
maintained owner relay refused desktop device enumeration (`route_not_relayed`).

Owned bug `EI-25336668159113928` isolates the protocol cause: the actual public sealed
channel emits encrypted `http.ready` without a request ID. The Rust client skipped only
`hello` before enforcing the response request ID. The maintained TS interop fixture had
omitted this readiness frame. Adding it reproduces the exact
`Decode("sealed device HTTP: response requestId mismatch")` failure in the canonical
Rust pairing test (`/tmp/android-p015-http-ready-before.log`, exit 101). Recognizing the
channel control frame fixes the failure; all six sealed HTTP interop tests pass with zero
skips (`/tmp/android-p015-http-ready-after.log`, exit 0), including wrong-pin and mismatched
response-ID refusal, bounded uploads/SSE, error mapping and reconnect coverage.

Harness fallout `EI-25336728975892198` is now admitted and assigned to the parent lane.
The native smoke test fails promptly on a visible pairing error and writes safe stage/class
evidence before teardown. The runner retains only allowlisted native stages and class names.
The canonical cloud runner guards verify private-text exclusion, fresh directory creation,
exclusive input preservation, and the existing unsafe-candidate refusal controls
(`/tmp/android-p015-cloud-diagnostic-guards-final.log`). This audits both prior failure classes
before a third full native run. The debug APK rebuild and native test-package assembly pass
(`/tmp/android-p015-ready-fix-prebuild2.log`, `/tmp/android-p015-ready-fix-testapk.log`),
including four-ABI packaging and 16 KB alignment checks. The measured shared APK digest is
`4e2b7522a1c3e89cab8bde002221038facb0041bd6b7a2dad96b22a8d5a292d0`; a later run must
capture and recheck its own candidate because shared output can advance. Actual public
native verification remains pending; these protocol and harness checks do not close public
hosted or genuine BYOC Android acceptance.

### Public Android pairing verified; attention blocked — 2026-10-07 16:20Z

The maintained public `cloud-native` journey on owned emulator 5584 (API 36,
16 KB pages) used a fresh owner-authenticated QR without changing its public
HTTPS base. Immutable evidence is retained in
`/tmp/android-p015-public-hosted-native-20261007-1620/result.json` and its
`instrumentation.log`. The captured APK SHA-256 is
`0c66d96ce3a205965e1bd32ef675362d6c17d44c7fd214046a0271725425db2c`;
the installed APK matches. The test APK SHA-256 is
`f5896c1b124b873d7b4c4b16e5c45311efa54ef19aebe74dab33c57bbcc20fa3`.
Source base is `612461f42beef3bb99877656076d2e5090c08e68` with a dirty tree;
the result records the individual source fingerprints. This is execution proof,
not a clean committed-source or signed-release claim.

The real Android JNI received the pairing response, saved credentials, and
restored the encrypted seed and pin after activity recreation. A fresh client
completed device, workspace and harness reads. The next call, `attention()`,
failed with `503 attention_unavailable` at smoke-test line 148. The test records
one executed JUnit test and one failure. Its safe failure proof retained
`failedStage=fresh-client-reconnect-and-scope` and `failureClass=Server`.
Cleanup revoked the newly created device and cleared local credentials. This
verifies the readiness-frame Decode fix (`EI-25336668159113928`); full hosted
acceptance remains open under `WI-10006956`. The attention failure is owned in
`EI-25338280978263840`, with its root cause still unconfirmed. The earlier run's
possible orphan remains a separate host-administration check.

Harness item `EI-25336728975892198` is closed with scoped canonical regression
evidence. `tools/tests/run-android-checks-test.sh cloud` now executes the actual
runner `main()` failure/finally path for both an instrumentation assertion and
a timeout. Both retain safe stage/class proof, exclude raw private log text,
remove only owned input, and target only emulator 5584. The suite passes in
`/tmp/android-p015-cloud-finally-guards.log`. These deterministic controls do not
claim successful native operation coverage. Camera scanning, remaining public
operations and genuine BYOC acceptance remain open.

### Strict release-gate applicability guard — 2026-10-07 16:54Z

The customer VM serial log for the 16:20Z run identifies the failed producer:
`system_source_unmeasured`, with `gateMeasured:false` and `poolMeasured:true`.
This establishes the unavailable release-gate measurement, but does not prove
why it was unavailable. `fetchOrientPipeline` returns null both for an absent
checkpoint and a failed reader; the snapshot also catches routine query errors.
Customer service configuration and its strict checkpoint row remain unmeasured.

The current local extension reuses the strict routine-control reader in
`git-pipeline-stats.ts`. Device attention accepts a null release-gate tile only
after a successful query proves there is no `green-checkpoint` routine for the
selected pipeline. A configured routine, a failed configuration query, or an
unmeasured inference pool still returns `503 attention_unavailable`. The absent
routine branch emits a fixed diagnostic so a cheap customer-host attention probe
can identify it without a privileged external database query.

Focused local verification passes 168 assertions with no skips across
`git-pipeline-stats.test.ts` (75), `device-monitoring.test.ts` (24),
`routes/device/attention.test.ts` (22), `device-revival-routes.test.ts` (28),
and `plans/attention.cache.test.ts` (19). The initial monitoring run had one
missing `vi` import; its corrected run passes. Logs are
`/tmp/android-p015-strict-routine.log`,
`/tmp/android-p015-applicability-corrected.log`,
`/tmp/android-p015-attention-applicability.log`, and
`/tmp/android-p015-applicability-diagnostic.log`. Their source stamp is
`4478c77fcc` with dirty named paths; this is local verification, not a committed
candidate or customer-runtime claim. Customer candidate adoption, the cheap
attention preflight, and the subsequent native journey remain open.

### Committed attention candidate and sealed preflight — 2026-10-07 17:27Z

The strict applicability fix and its tests are committed in superproject
`f0f67adb154dee54ad59a79c5ae6f7704fa2da62`. All seven changed source/test blobs
match the locally verified cohort; the complete SHA256 table is retained on
`EI-25338280978263840`. The maintained isolated runner passes all 168 tests
with zero skips against this exact commit:

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run lint:as-committed -- test:file --any --ref=f0f67adb154dee54ad59a79c5ae6f7704fa2da62 -- packages/operator-core/lib/git-pipeline-stats.test.ts packages/operator-core/lib/device-monitoring.test.ts packages/operator-core/lib/endpoint-route/routes/device/attention.test.ts packages/operator-core/lib/endpoint-route/__tests__/device-revival-routes.test.ts packages/operator-core/lib/agent-tools/plans/attention.cache.test.ts
```

Proof log: `/tmp/android-p015-attention-committed-corrected.log`, exit 0,
`requested=5 executed=5 matched=5`, clean stamped provenance. The preceding
attempt refused a mistyped test path before executing; it produced no test result.

The existing mobile `crates/papercup-core/tests/live_smoke.rs` now includes
`live_sealed_attention_preflight`. It consumes a fresh private QR file, requires
HTTPS and a valid machine pin, pairs through Noise, checks attention and workspace
scope, reconnects with the same identity, and revokes the test pairing even when
an assertion fails. Error output retains stage/status without response bodies.
Its committed blob at mobile source
`3f2cffa5f095a54b909efe57a2a6ae841d632dbb` has SHA256
`10827d512a75577030cf9f4f9efce7095250d8a73b59bf47b0fcb7dc8acaa33b`.
Local verification passes nine preflight/cleanup guards and six sealed JS
interoperability tests. Both explicitly live smoke cases remain ignored in that
local run; they are not customer-runtime evidence. Logs:
`/tmp/android-p015-sealed-preflight-guards.log` and
`/tmp/android-p015-sealed-preflight-guards-final.log`.

The leader reports the r69 build started from the exact operator source; publication
and customer adoption remain unverified. Customer checkpoint absence, the live sealed
attention probe, the subsequent native journey, camera and full-operation acceptance,
and genuine BYOC acceptance remain open. No public cloud support claim is made.

### Public hosted sealed attention verified — 2026-10-09

The old adoption wait timed out before the leader fired generation 1 of
`fleet:android-release:android-r69-attention-runtime-adopted` at
2026-10-07T20:05:40.291Z, with exact source
`f0f67adb154dee54ad59a79c5ae6f7704fa2da62` matched. That fired receipt
supersedes the adoption-pending statements above. On 2026-10-09T13:55:51.205Z,
the maintained `readWorkspaceHostRuntimeRelease` reader still reported avi-test
running `0.0.21-p318r69`, schema `schema-1415`, bundle
`81b87e9e15dd9a16734143d1409bfa718fd3d3ad90887c0cbbaa8826c60cf803`.
The runtime row reports the bundle and version; source binding comes from the
leader's matched adoption receipt, not a source field in that row.

The existing authenticated hosted relay returned HTTP 200 for the expected
workspace and minted a fresh public HTTPS QR. The private QR used mode 0600.
The maintained `live_sealed_attention_preflight` then passed against
`https://app.papercusp.com/api/workspaces/ws-3daf37098c8096b5d9e0ac72`:
sealed pairing, attention, reconnect, workspace scope, and device revocation
all succeeded. Cargo reported one passed, zero failed, zero ignored, and ten
filtered out. The preflight source still matches SHA256
`10827d512a75577030cf9f4f9efce7095250d8a73b59bf47b0fcb7dc8acaa33b`.
The newly minted QR and private mint response were removed after the run.

Durable receipt: [android-p015-sealed-attention-2026-10-09.json](android-p015-sealed-attention-2026-10-09.json).
Original log: `/tmp/android-p015-preflight-20261009-SxZzbz/preflight.log`, SHA256
`5a3056e20410632eb1d047096091c224eab740c4228ce36b610934fc00757905`.
This verifies the hosted attention failure is repaired on the nominated r69
runtime. Current native app operations, camera, and genuine BYOC acceptance
remain open; this receipt does not close parent P-015 or prove a current APK.

Recovery also found an earlier passing run completed at 13:42Z in the
predecessor's native tool transcript and
`/tmp/android-p015-r69-sealed-preflight-20261009.log`. The carry note omitted
that work, so the continuation repeated the bounded probe with a fresh QR
before recovering it. Both runs report revocation, and both sets of newly
minted private QR/response files are now removed. The durable receipt records
both logs and the recovery limitation. Independent customer-side proof of
strict checkpoint absence remains outstanding; the actual live pass alone
does not distinguish absence from a recovered configured gate reader.

### Accepted r69 transport source qualified — 2026-10-09 14:20Z

The maintained isolated committed-source runner passed the four D-021 transport
suites at accepted source `f0f67adb154dee54ad59a79c5ae6f7704fa2da62`:
104 assertions, zero skips, exit 0, and four requested/executed/matched files.
The test ledger independently records clean, non-scratch local `papercusp`
passes `20958702`, `20958703`, `20958704`, and `20958705` at that exact commit.
Log `/tmp/android-d021-r69-pinned-20261009.log` has SHA256
`64921212fed6d21c2895ad2ad0bed58da9404e7da3f0ce3cdf98b8b5734cbf77`.
This renews the accepted-candidate source check; no native run or new pairing
was performed in this qualification.

The current avi-test VM incarnation is `7419102153377783583`. Controller IAP
SSH succeeded with its existing incarnation-bound known-host pin. A bounded
read of the operator journal for the preflight interval could not establish
the strict absent-routine diagnostic: `sudo -n` requires a password, and the
customer account's journal scope excludes system and other-user messages.
These are unreadable evidence, not evidence of absence. The attention defect
remains open until a maintained service-context read distinguishes absent
checkpoint configuration from recovery of a configured reader. No privilege,
service, or VM configuration was changed.

## Historical discovery — 2026-10-06

The following sections preserve the initial analysis and agreement context. Their gap states,
route spellings, image/bootstrap description, and client error mappings are historical; use the
current source and dated section above for implementation or support decisions. The current bootc
image carries an immutable versioned runtime (see `workspace-host.Containerfile` release target),
so the initial first-boot shallow-clone description below is also superseded.

Every claim is tagged **[code]** (read in source at the path given) or **[inferred]** (reasoned, not yet probed).

## 1. What a BYOC cloud workspace runs, and how anything reaches it

- **Machine image.** A CentOS Stream 10 bootc image, `infra/images/bootc/workspace-host.Containerfile`,
  rendered per provider: GCE image family, AWS AMI, Azure Compute Gallery
  (`packages/operator-core/lib/workspace-host/gcp-image-family.ts`, `aws-ami-release.ts`,
  `azure-compute-gallery-release.ts`). The operator comes from the first-party release bundle that the
  content bootstrap shallow-clones at first boot. So a cloud workspace runs the **same operator code
  as the desktop**, pinned to a release sha. **[code]** It does not run a separate cloud fork. **[inferred]**
- **No inbound ingress.** The VM has an nftables firewall (`papercusp-firewall.nft`) and reaches the cloud
  only through an **outbound workspace connector** to the hosted control plane. The portal "never dials a
  machine address" (`hosted-app-relay.ts` header). **[code]**
- **Public origin.** `app.papercusp.com` is served through a Cloudflare tunnel whose ingress lives outside
  the repo (`~/.cloudflared/papercup-demos.yml`). Route families are classified in
  `endpoint-route/hosted-public-ingress.ts`. TLS ends at Cloudflare. **[code]**
- **Relay planes the connector carries.** Channel kinds are `pty | psu | desktop | operator-http | app-http |
  app-key-mint` (`hosted-session-host.ts:107-116`). **[code]**
  - `operator-http` (`hosted-operator-http.ts`): carries the **portal web UI's** traffic. The principal is bound
    from a single-use workspace-operator ticket tied to a **portal browser session**. The relay drops
    `Authorization` and cookies and forwards to the VM's loopback operator under a default-deny allowlist.
    That allowlist has **no `/api/device/*` route** except `mint-pair-token` and `qr.svg`, which are listed as
    "remote access device pairing". **[code]**
  - `app-http` (`hosted-app-relay.ts`): `POST /api/workspaces/<id>/agent-tools/...` and `/api/workspaces/<id>/mcp`.
    It accepts **only `Bearer pcapp_…` app keys**, with no queueing: an offline connector gives `workspace_offline`.
    Its allowlist covers only `/api/agent-tools/*`, `/api/mcp` and `/api/hooks/*`. **[code]**
- **Own tunnel (local installs only).** `own-tunnel/*` provisions cloudflared in the **user's** Cloudflare
  account for a desktop install. Its external-ingress listener **does** serve the phone's device routes
  (`apps/operator/bin/external-ingress-paths.ts`: `/api/device/pair` plus the routes that need a device JWT).
  No hosted-bring-up or workspace-host file configures cloudflared or own-tunnel on a cloud VM. **[code: grep of
  workspace-host/*.ts]** So a BYOC VM has no own tunnel. **[inferred]**

## 2. What the mobile client needs

The shared Rust client (`papercup-rust-mobile/crates/papercup-core`) talks only to `<serverUrl>/api/device/*`.
It needs: pair, heartbeat, rest-query, the operator converse/conversation stream, voice, voice-lease, plans,
attention, monitoring, running, harnesses, workspaces/switch, push/register and notifications. Auth is a
device JWT minted by `/api/device/pair` from a one-use pair token. **[code]**

Pairing (`endpoint-route/routes/device/pair.ts:55-79`). `mint-pair-token` is loopback-only. The QR's
`serverUrl` is taken from the first of these that is set:
1. `MOBILE_DESKTOP_PUBLIC_URL`
2. `MOBILE_DESKTOP_HOST`
3. the detected LAN IP plus the request port
4. the request Host

**[code]** On a cloud VM, (3) gives the VM's **private VPC address**, which a phone cannot reach. **[inferred
from the code path; not probed on a live VM]**

## 3. Compatibility matrix

| Cloud release | Mobile client | Supported | Why |
|---|---|---|---|
| byoc-cloud-workspaces (shipped 2026-10-02; GCP + AWS + Azure images), reached via app.papercusp.com | Android `papercup-rust-mobile` master (current candidate) and iPhone (shared crates) | **NO** | The phone has no path to `/api/device/*` on the VM, and pairing advertises an unreachable private URL. |
| Desktop/local install with own tunnel (external-ingress) | same | yes (route-level) | `external-ingress-paths.ts` allowlists every device route. This is the current non-LAN path. |
| Desktop/local install, same LAN | same | yes | The current verified path (WI-10004697 / WI-10004773 evidence). |

## 4. Gap list (byoc cloud)

| # | Area | Gap | Where the fix lives |
|---|---|---|---|
| G1 | No-LAN reachability | No relay plane carries `/api/device/*` to the VM. `operator-http` requires a portal browser session and strips `Authorization`. `app-http` accepts only `pcapp_` keys. **[code]** | Portal/control plane plus workspace-host: a new `device-http` relay plane (proposal in §5). |
| G2 | Pairing from a cloud workspace | The portal UI can reach `mint-pair-token` and `qr.svg` through operator-http, but the QR `serverUrl` is the VM's private address, and `/api/device/pair` is not relayed. **[code + inferred]** | VM operator: on a hosted VM, the advertised base URL must be the portal relay URL `https://app.papercusp.com/api/workspaces/<id>`. Portal: route `/api/workspaces/<id>/device/pair` as public own-auth (the one-use token is the credential). |
| G3 | Auth/token lifecycle | Device JWT is minted and verified on the VM, so the portal cannot verify it (same split as app keys). The JWT's audience is the VM's own origin; relay origin and JWT issuer must agree. **[inferred]** | Portal forwards only device-JWT-shaped bearers and stamps the deny-only ingress marker. The VM bearer chain stays authoritative. Rust client: refresh and re-pair unchanged. |
| G4 | Scope | A device is paired to one workspace on a desktop. On cloud, the relay path pins the customer workspace id, and `workspace/switch` across cloud workspaces cannot cross VMs. **[inferred]** | Rust client: one pairing per cloud workspace. `workspace/switch` is limited to the operator's own workspaces. |
| G5 | Sync / SSE | `rest-query` is fine over a request/response relay. A long-lived stream needs the relay to pass a chunked response without the 30 s header cap, which operator-http already handles. **[code: operator-http wire streams `http.body`]** Confirm the device relay inherits this. | workspace-host channel. |
| G6 | Chat streaming (`operator/converse`) | Long turns need a response-header budget like app-http's 120 s and no body cut. Reconnect on `workspace_offline` instead of hanging. **[inferred]** | Relay timeout config, plus a Rust client mapping for the `workspace_offline` error. |
| G7 | Approvals / attention / standing-candidates decide | Plain request/response once G1 lands. No extra gap is known. | — |
| G8 | Monitoring / running / harnesses | Same as G7. | — |
| G9 | Voice | `voice-session-init` and `voice/turn` may return provider URLs (LiveKit/ElevenLabs) that the phone dials directly. Those must be public, not VM-local. Request bodies are capped at 512 KiB per relay frame, so audio upload over `voice/turn` may exceed it. **[inferred; check payload sizes]** | VM voice routes plus relay body cap. Possibly a chunked upload. |
| G10 | Push | `push/register` stores the token on the VM, and the VM sends FCM/APNs directly over outbound HTTPS, which the firewall must allow. **[inferred]** | Image firewall egress check. Push delivery is otherwise unaffected by the relay. |
| G11 | Offline semantics | The relay refuses at once when the connector heartbeat is stale (D-008 of the EAA plan). The client must show "workspace offline" and not report an auth failure. **[code for portal behaviour]** | Rust client error mapping. |
| G12 | Billing / rate limits | The app relay applies per-workspace request-rate and monthly-bandwidth limits (D-006). Phone traffic, especially polling and SSE, would count against them. **[code for app relay]** | Decide whether device traffic shares the app-relay budget. |

## 5. Proposed endpoint/auth/pairing model (for agreement with member 1 and su-b9f6deac)

1. **Base URL is opaque to the client.** The Rust client keeps calling `<serverUrl>/api/device/<route>`.
   - Desktop: `serverUrl = http://<lan>:<port>` or the own-tunnel URL.
   - Cloud: `serverUrl = https://app.papercusp.com/api/workspaces/<workspaceId>`.

   The client has no cloud branch. Base-URL handling must allow a path prefix, which is a contract test
   for the shared crate. A wss/https-only rule applies when the host is not on the LAN.
2. **Portal `device-http` relay plane.** It is a sibling of `app-http` in `hosted-app-relay.ts`:
   - Route: `/api/workspaces/<id>/device/*` → connector → VM `/api/device/*`.
   - Default-deny allowlist: reuse the `external-ingress-paths.ts` device list as the single source (derive it, do not copy it).
   - `Authorization` is forwarded only when it is device-JWT shaped. `/device/pair` needs no bearer, because the one-use token is the credential.
   - The deny-only ingress marker is stamped on every forward.
   - Streaming and timeouts follow app-http.
3. **Pairing on cloud.** The user opens Remote access → Pair phone in the portal UI. That call goes over operator-http to the VM's `mint-pair-token`. On a hosted VM, the advertised `serverUrl` is the portal relay URL (G2). The VM knows its customer workspace id and the public origin from its connector binding.
4. **Auth stays on the VM.** The device JWT is issued and verified only by the VM, and the portal does shape checks only. This is the same split the shipped app-key relay uses.

### Agreement status (19:20Z)

**Member 1 (su-a64f40ce, P-002/P-004) agreed** and added four constraints:

- (a) Normalise a trailing slash in the shared crate's `base_url()`. Android `EndpointSecurity.kt` must accept an https URL that has a path. Member 1 adds that Android test in P-004.
- (b) `workspace_offline` gets its own error, not `Unauthorized`. On Android, `Unauthorized` forces a re-pair, which would wipe valid credentials.
- (c) `/api/device/voice` is a WebSocket (`device-voice-ws.ts`), so the device relay must carry the Upgrade, not only HTTP. This adds to G9.
- (d) Revocation and rotation stay on the VM, so the relay must pass a 401 through unchanged.

Member 1 also asked to keep the QR payload shape unchanged apart from the URL value.

**su-b9f6deac (iPhone) agreed** to points (1)–(4), which match `iphone-public-release-2026-08-11#D-014`. They added one **required amendment**:

- **End-to-end sealing.** On a `byoc` workspace, every device-http content frame is sealed end-to-end with the existing Noise XX channel (`BYOC_SEALED_PROTOCOL 'papercusp-byoc-noise-xx.v1'`, `byoc-sealed-channel.ts`). The phone is the initiator.
- **Machine key in the QR.** The machine's static Noise public key travels inside the pair QR, so trust never routes through the vendor. The phone's static key is registered when the pair is redeemed.
- **The relay refuses plaintext** byoc device content (hosted-byoc-confidentiality-correction D-003). Classify the plane in `HOSTED_RELAY_FRAME_REGISTRY`.
- **No cloud branch.** The client seals whenever the pair payload carries a machine Noise key.
- **Implementation.** Use a maintained Noise library in the shared Rust core, with cross-implementation test vectors against `byoc-sealed-channel.ts`.

Under D-015 the shared BYOC Rust layer is **this lane** (P-015): URL-prefix handling, `workspace_offline` mapping and the sealed-channel initiator. The client must also accept the pair baseUrls kind `relay`. The Swift side (DesktopVoiceSession) is su-d34a76e0's, the iOS half of WI-10006857.

The 512 KiB frame cap (G9) must be an **acceptance check** on the relay item: voice/turn bodies either fit under the cap or are chunked.

### Status-code mapping the shared client must get right (read in code, 19:25Z)

The relay's refusal codes (`packages/operator-core/lib/workspace-host/hosted-app-relay.ts`, `refuse(...)` and `RELAY_ERROR_STATUS`) do not line up with the Rust client's mapping. In `papercup-rust-mobile/crates/papercup-core/src/client.rs`, `into_api_error` turns **every** 401 and 403 into `ApiError::Unauthorized`, and everything else into `Server{status}`. **[code]**

| Relay response | Today's client result | Required result |
|---|---|---|
| `503 workspace_offline` (+ `retry-after: 30`) | `Server{503}` | A distinct `WorkspaceOffline { retry_after }`. Retryable, never re-pair. |
| `403 byoc_plaintext_relay_refused` | **`Unauthorized` → re-pair, wiping valid credentials** | A distinct relay-policy error. A sealing bug must never wipe the pairing. |
| `403 route_not_relayed` | **`Unauthorized` → re-pair** | Same relay-policy error: the client called an off-allowlist path. |
| `401` from the VM (device JWT revoked or rotated) | `Unauthorized` | Unchanged. This is the only true re-pair signal (constraint d). |
| `413 request_body_too_large` (cap `HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES` = 512 KiB) | `Server{413}` | A distinct too-large error, so voice/turn can chunk. G9 acceptance. |
| `429 rate_limited` (+ `retry-after`) | `Server{429}` | A distinct rate-limited error that honours `retry-after`. |

So the device-http plane must tell its own refusals apart from the VM's. Either the relay never answers 403 for the device plane, or the client branches on the `error` code in the body before it falls back to "403 means Unauthorized". Branching on the body code is the safer contract, because it does not depend on the relay's choice of status code. These are the first contract tests to write once the work item is held (wiremock, in `crates/papercup-core`).

Base-URL joining is already safe for a relay path prefix: `new`/`set_base_url` trim trailing slashes, and requests are built as `format!("{base}{path}")`. Constraint (a) only needs a test that pins this, plus the Android `EndpointSecurity.kt` change (member 1, P-004). **[code]**

No code changes before P-015's work item is held.
