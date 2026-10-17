# Mobile sessions r11 — complete replay populations and explicit detector limits

Owned work: WI-6554700010015069; parent G2 WI-6554700010014994. This dossier supplies the completed enumeration/citation artifacts requested by objection thread-post:1183679; it is not an attestation card or a product test result. The prior inventory1183670 is superseded as evidence preparation, not as a rubric contract.

Exact subject: acceptance-mobile-agent-sessions-2026-10-12 revision11; criteriaHash 8405d64f0a4dd148c79038fac65ed6860c243106e020f5a4ac13dd42aed0e962; barSetHash e3ba4a7eb46ea76d3b540c4454fb4c59ea118d0d9a296f51c171c7e22d73eca3. Subject plan mobile-agent-sessions-2026-10-12 revision70; contentHash 0d21ada71780f5038b2e56b0d6c9ede31bc3ee70f081adfd12feb533e47e9cb0. Meta contract: meta-acceptance-rubric revision5/hash215de0837eaed307004dd8a9dfcf2cff9caaa47b9ee19e3f11bb2c5390a19614. Failed prior meta card EI-26071954825118708 and independent audit EI-26072441756692796 remain history. Canonical wording amendment approval1183645 / preview1183640 and activation audit6 remain unchanged.

## Boundary and process correction

The first card sampled R9/R46 and claimed six passes without the full meta-method populations. The first repair brief merely listed the missing work; reviewer1183679 correctly refused a card from that inventory. Before any third grading attempt, the preparation process now requires actual populated criterion, Decision/inverse, failure-surface, pair and detector tables. The structural preflight below fails on an omitted population row; it does NOT establish semantic adequacy or a passing grade.

No historical product suite was rerun. No mobile-hive source/CI was read or edited. Manual/live/candidate proof is NOT supplied or fabricated. Source-level detector observations are scoped to the exact committed blobs below, not a claim those tests passed now. R6's architecture-shaped wording, R9 actual-live under-binding, additional partial detectors, shared/overlapping pairs and unmeasured release scope are explicit findings. Do not erase guarantees or turn unknowns into passes.

## Reproduce the source reads

Use the attributed ptool transport at the staging operator, not an arbitrary HTTP identity. These reads do not execute product suites:

```bash
ptool rubrics:get --url=http://127.0.0.1:3170 --json - <<'JSON'
{"rubricRef":"acceptance-mobile-agent-sessions-2026-10-12","revision":11,"detail":"full","payloadTier":"full"}
JSON
ptool rubrics:get --url=http://127.0.0.1:3170 --json - <<'JSON'
{"rubricRef":"meta-acceptance-rubric","revision":5,"detail":"full","payloadTier":"full"}
JSON
ptool plans:get --url=http://127.0.0.1:3170 --json - <<'JSON'
{"slug":"mobile-agent-sessions-2026-10-12","harness":"papercusp","mode":"full","includeEnrichments":false,"includeHistory":false,"payloadTier":"full"}
JSON
```

The plan reader is current rather than revision-addressable: require version70/contentHash above before reusing its observations. The Goal/Decisions bodies used for this dossier are preserved below to make later plan movement visible, with owner names removed from provenance tags as required for repository source. Dates, directive references and behavioral content are preserved; the plan contentHash identifies the original canonical plan, not these normalized excerpts. Immutable rubric11 must resolve with the exact hash above.

For each alias/path below use:
```bash
git rev-parse f452f8379661eb2d6901dced28637cda4b337451:<path>
git show f452f8379661eb2d6901dced28637cda4b337451:<path> | nl -ba | sed -n '<start>,<end>p'
```
All selector lines in this dossier belong to that FULL commit. A range identifies the fixture body/assertions, not merely a filename. Source text from several selected blocks is inspected in this session; the exact replay command recovers every cited block. The original whole send.test.ts working tree differed from its pin; this dossier makes no whole-file current-tree equivalence claim.

## Enumeration preflight output

```json
{
  "rubricRevision": 11,
  "criteriaHash": "8405d64f0a4dd148c79038fac65ed6860c243106e020f5a4ac13dd42aed0e962",
  "planVersion": 70,
  "planContentHash": "0d21ada71780f5038b2e56b0d6c9ede31bc3ee70f081adfd12feb533e47e9cb0",
  "criterionRows": 50,
  "decisionRows": 20,
  "testBoundRows": 27,
  "manualRows": 23,
  "pairRows": 1225,
  "expectedPairs": 1225,
  "uniquePairs": 1225,
  "missing": {
    "sources": [],
    "witnesses": [],
    "detectors": [],
    "decisions": [],
    "boundFiles": []
  }
}
```

The writer computes pairs with sorted numeric BAR ids and nested indices i<j; it refuses duplicate/missing criterion/source/witness/detector/Decision/file entries. The pair table contains every unordered pair exactly once. Its default label is deliberately proposed-separable, not pass: a reviewer must judge each named counterexample construction against the full predicates. Exception rows override the default and disclose shared failures, containment or unresolved scope. Reproduce the enumeration with:
```javascript
const ids = criteria.map(c => Number(c.key.slice(2))).sort((a,b) => a-b);
const pairs = [];
for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++) {
  const key = ids[i]+","+ids[j];
  pairs.push([ids[i],ids[j],exceptions[key] || ["proposed-separable","W"+ids[i],"W"+ids[j]]]);
}
if (pairs.length !== ids.length*(ids.length-1)/2) throw Error("pair population gap");
if (new Set(pairs.map(p=>p[0]+","+p[1])).size !== pairs.length) throw Error("duplicate pair");
```

## Full source context: goal, scope, scenarios and design

## Product shaping

**Source turn:** owner directive #1747, 2026-10-12 [owner 2026-10-12]: *"do our android and iphone apps allow for viewing all agent sessions and interacting with them?  If not write a plan for adding that feature"*. The owner-dialog answers in the same session (turn 15) set D-001..D-004.

**Audience:** the owner, using the paired iPhone/Android companion app (papercup-rust-mobile) away from the desktop.

**Problem:** On the phone today, the owner can see how many agents exist but not which ones, what any of them is doing, or how to reach one. The desktop already does all three through the Sessions roster and the session chat popup.

**Outcome:** From either phone, the owner can:
1. see every agent session in the paired workspace (live, parked, recently ended);
2. open any session and read its current intent, held work item and live/recent transcript;
3. send that session a message that wakes it, and see what happened to the message;
4. end a session;
5. get a push notification when an agent messages them.

**Non-goals (v1):**
- Launching or resuming sessions from the phone.
- An interrupt/yield control (not selected, D-003).
- Approving tool permissions or editing files from the phone.
- Browsing sessions outside the device's workspace.
- A raw tool-output viewer.
- Per-device send rate limiting or abuse throttling (D-011).
- Replacing the Operator tab's chat with the operator brain.

**Scenarios:**
- **S1 — Roster.** Fleet → Sessions shows every session, grouped by fleet/pot, with its state badge, intent and last activity. It can be filtered and searched.
- **S2 — Read.** Tapping a session shows a header (intent, work item, state) and a condensed transcript. The transcript keeps updating while the screen is open, and older turns load on scroll.
- **S3 — Talk.** The owner sends "stop and checkpoint". The app shows the outcome: woken, staged, queued or agent ended.
- **S4 — Push.** An agent messages the owner, a push arrives, and tapping it opens that session.
- **S5 — End.** The owner ends a session from the phone after a confirm dialog. Its state turns to ended on both the phone and the desktop.
- **S6 — Revocation.** The owner revokes the phone, and every session route refuses it immediately.


## Design

**Shape:** four device routes, each a thin wrapper over shared server readers/actions; the Rust core mirrors them; both apps render a Fleet → Sessions segment and a session detail screen.
- **Server:** P-001 moves the roster, transcript, send and end logic the desktop uses into shared modules. On top of them: `GET /device/sessions`, `GET /device/sessions/:owner/transcript`, `POST /device/sessions/:owner/messages` and `POST /device/sessions/:owner/end`, with auth = device JWT plus a per-device Agent sessions capability. Agent-to-owner coord messages feed the existing push pipeline.
- **Transport:** SSE for live appends on a direct connection, cursor polling over the BYOC sealed relay if it cannot stream (verified first, in P-003).
- **Clients:** all logic in papercup-core behind UniFFI; screens only render. Send and end sit behind a biometric unlock window (D-002).
- **Reused, not new:** the presence oracle, coord:send delivery classification, the device actions log, PushManager/PushService and the BiometricPrompt callback. New durable surfaces: four routes and one per-device capability flag. Nothing existing fits them, because the device API has no session route today.

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001, P-002 | tree |
| R-2 | P-001, P-003, P-009, P-012 | tree |
| R-3 | P-001, P-004, P-009, P-012 | tree |
| R-4 | P-005, P-007, P-016 | tree |
| R-5 | P-003, P-007, P-014, P-015 | tree |
| R-6 | P-007, P-008, P-011 | tree |
| R-7 | P-006, P-014 | tree |
| R-8 | P-015, P-019 | deployed |
| R-9 | P-017, P-018 | tree |
| R-10 | P-014 | tree |
| R-11 | P-003, P-007, P-009, P-012 | tree |
| R-12 | P-004, P-006 | tree |
| R-13 | P-004 | tree |
| R-14 | P-007, P-009, P-012, P-018 | tree |
| R-15 | P-004, P-017 | tree |
| R-16 | P-007, P-015 | tree |
| R-17 | P-008, P-011 | tree |
| R-18 | P-016, P-018 | live |
| R-19 | P-002, P-003, P-004, P-006, P-017 | tree |
| R-20 | P-001, P-002, P-008, P-011 | tree |
| R-21 | P-001, P-002 | tree |
| R-22 | P-002, P-007 | tree |
| R-23 | P-002, P-008, P-011 | tree |
| R-24 | P-016 | live |
| R-25 | P-003, P-005 | tree |
| R-26 | P-017 | tree |
| R-27 | P-017 | tree |
| R-28 | P-017 | tree |
| R-29 | P-009, P-012, P-014 | tree |
| R-30 | P-014 | tree |
| R-31 | P-014 | tree |
| R-32 | P-007, P-016 | live |
| R-33 | P-004, P-006 | tree |
| R-34 | P-004, P-006 | tree |
| R-35 | P-004 | tree |
| R-36 | P-004, P-017 | tree |
| R-37 | P-016 | live |
| R-38 | P-016 | live |
| R-39 | P-010, P-013 | tree |
| R-40 | P-009, P-010, P-012, P-013 | tree |
| R-41 | P-007, P-016 | live |
| R-42 | P-015, P-019 | deployed |
| R-43 | P-019 | deployed |
| R-44 | P-007, P-018 | tree |
| R-45 | P-007, P-015 | tree |
| R-46 | P-016, P-018 | live |
| R-47 | P-016 | live |
| R-48 | P-009, P-012 | tree |
| R-49 | P-005, P-007, P-016 | live |
| R-50 | P-007, P-009, P-012, P-016 | live |


## Resolved questions

- Q1 send gate → D-002 (an unlock window). Q2 controls → D-003 (End session; no interrupt). Q3 release train → D-004 (current candidates). Q4 push → D-003 (yes).


## Phase 5 — Attention, privacy, acceptance

- **P-014** `todo` Push for agent-to-owner messages (R-10, D-003): route coord messages addressed to the owner (to human, or an ask-owner) from agent sessions into the existing push pipeline (PushManager/PushService) for capability-holding devices, with the payload deep-linking to the session (S4). The payload is limited to the session reference plus a redacted preview (R-30), and no push reaches another workspace or a device without the capability (R-31). Unit test in `session-push.test.ts`.
- **P-015** `todo` Update the App Store and Play privacy/review packets (`store/APP-STORE-REVIEW.md`, `store/PLAY-STORE-REVIEW.md`) for transcript display on the device (R-5, R-8).
- **P-016** `todo` Paired-device acceptance: run S1–S6 on an iPhone and an Android device against the live operator, over LAN and over the BYOC relay. Record evidence: the phone roster count equals the desktop's, a parked agent woken from the phone shows the message in its transcript, an ended session reads ended on the desktop, and a revoked device is refused.
- **P-018** `todo` Add an End session control to the iPhone and Android session detail screens (R-9, D-003): a confirm dialog naming the agent, the biometric window, and a result state, with XCUITest and Compose UI tests.
- **P-019** `todo` Release-candidate integration (R-8, D-004): before changing a candidate build, coordinate with the owners of iphone-public-release-2026-08-11 and android-public-release-2026-10-01. Agree how this feature joins the in-flight candidates, then re-run the acceptance evidence it affects (privacy disclosures, reviewer notes, UI test suites).



## Decision census and forward mapping

Every stored Decision is included; procedural/non-goal/amendment provenance is explicitly distinguished from a new product outcome.

| Decision | current title | covering BARs | disposition and limits |
|---|---|---|---|
| D-001 | Route: the authoring su session implements the plan itself (route A) | none — procedural | Procedural route/authorization, not a shipped product outcome. Route A remains direct author-side implementation; canonical outside-lineage review is verification. No acceptance BAR is invented for who executes. |
| D-002 | Send gate: one biometric unlock covers sends for a time window | R-4, R-14, R-44 | Windowed biometric send/end and independent server capability. No per-message biometric prompt and no server-signed unlock assertion. |
| D-003 | v1 scope adds End session and push for agent-to-owner messages; no interrupt control | R-9, R-10, R-18, R-26, R-27, R-28, R-29, R-30, R-31, R-37, R-46 | End via existing desktop action; push + deep link; interrupt/yield explicitly excluded from v1. |
| D-004 | Release train: ship in the current iPhone and Android release candidates | R-8, R-42, R-43 | Current artifacts, prior owner agreement, privacy and preservation of earlier mandatory acceptance; no future-release substitution. |
| D-005 | Acceptance BAR amendment | R-2, R-3, R-4, R-5, R-6, R-9, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19 | Historical approved atomic split; listed current BARs retain the original compound obligations. Amendment metadata/approval is procedural, not a separate product BAR. |
| D-006 | R-16, R-17 and R-18 are manual BARs: drop requiredTestLayers | R-16, R-17, R-18 | Manual evidence-channel ruling; exact mobile CI proof still required. instrument:none is an explicit boundary, not passing evidence. |
| D-007 | Acceptance BAR amendment | R-1, R-2, R-3, R-7, R-8, R-9, R-16, R-17, R-18, R-19 | Vocabulary/evidence-layer correction; preserves behavior and manual mobile proof. No new independent user outcome introduced. |
| D-008 | R-9 / P-017: the desktop 'End session' path is the Stop agent action, which runs fleet:kill | R-9, R-26, R-27, R-28 | Same fleet:kill dispatcher and arguments incl reason/close_terminal; existing tool safety inherited. Device admission/response/retry partitioned. |
| D-009 | R-14 is a papercup-core client gate per D-002; the BAR states that and is proven in mobile CI, not at the route | R-4, R-14, R-44 | Biometric gate is CLIENT-side core behavior; device JWT/capability is server authority. Owner-ask alternative remains a separate security decision, not silently adopted. |
| D-010 | R-13 / R-35: a phone-sent message is labelled as the owner's from a paired device but stays agent-origin in turn provenance (owner-ask default A) | R-13, R-35 | Paired-device owner label with agent-origin provenance; unresolved owner ask proceeds on recorded reversible default A. This is a source-authority caveat, not permission to mint owner directives. |
| D-011 | Per-device send rate limiting is a v1 non-goal | R-4, R-12, R-14, R-15, R-25, R-33, R-34, R-36, R-44 | Explicit no-rate-limit non-goal. Other safeguards are listed, but no criterion is added that demands a v1 throttle. Audit/query abuse trigger is a follow-up decision, not feature acceptance. |
| D-012 | Mobile item specs ITEM-P-008..013-1 and ITEM-P-018-1 are manual (non-automated, no test layers), extending D-006 | R-17, R-18, R-29, R-39, R-40, R-44, R-48 | Manual mobile framework evidence for UI items, not browser testing and not automatic product pass. |
| D-013 | Acceptance BAR amendment | R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32, R-33, R-34, R-35, R-36, R-37, R-38, R-39, R-40, R-41 | Approved R1-R41 decomposition, planes, live positive controls, owner-ask defaults. All listed current contracts retained; no acceptance from historical cards. |
| D-014 | Acceptance BAR amendment | R-3, R-5, R-7, R-10, R-12, R-13, R-15, R-30, R-31, R-33, R-34, R-35, R-36 | Identified authenticated refusal semantics and implemented check paths. Current R36/D17 is the later authority for auth partition. |
| D-015 | Acceptance BAR amendment | R-3, R-9, R-10, R-12, R-13, R-15, R-31, R-33, R-34, R-35, R-36 | Additive detector bindings. No claim that adding paths alone establishes adequacy; detector matrix below inspects actual assertions. |
| D-016 | Acceptance BAR amendment | R-25 | Open-stream revocation detector, multiple streams plus still-capable positive control, kept distinct from next-request refusal. |
| D-017 | Acceptance BAR amendment | R-4, R-36 | Exactly one identified row iff device JWT auth succeeds; unauthenticated denial produces zero device-action rows. |
| D-018 | Acceptance BAR amendment | R-1, R-3, R-4, R-6, R-7, R-8, R-14, R-16, R-18, R-23, R-24, R-35, R-36, R-38, R-40, R-42, R-43, R-44, R-45, R-46, R-47, R-48, R-49, R-50 | Current strengthening/splits retain platform, privacy, live, candidate and history proofs. Manual cross-hive obligations remain unverified here. |
| D-019 | Acceptance BAR amendment | R-9, R-26, R-46, R-49 | Historical r10 readback wording; superseded by D20 only for the duplicate R9 readback falsifier. Actual end and R46/R49 guarantees remain. |
| D-020 | Acceptance BAR amendment | R-9, R-26, R-46 | Exact r11 correction: R26 solely owns readback propagation; R9 action parity/actual end retained; R46 explicitly detects actual still-live target. |

## All-criterion outcome, falsifier, inverse source and detector results

Each row quotes the stored model/falsifier rather than inferring success from a file change. Source links invert the forward map and include the source scenario/design where the Decision is procedural. Every tests-bound row points to an actual assertion matrix entry; every manual row remains explicitly unverified.

| BAR | outcome/model | concrete falsifier | source/inverse | outcome-form observation | detector result |
|---|---|---|---|---|---|
| R-1 | Over the complete unfiltered cursor walk of a fixed roster snapshot, GET /device/sessions returns exactly the desktop Sessions roster population for the device's workspace | the complete unfiltered cursor walk omits a desktop session identity or includes an identity outside that workspace's desktop population | Product shaping S1; D-005,D-007,D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W1 below. | Source detector present for fixture population; no test run performed. Selectors S:134-167 |
| R-2 | GET /device/sessions/:owner/transcript returns, one bounded page at a time, the same condensed entries the desktop session stream shows for the same session and cursor range | for the same session and cursor range the device entries differ from the desktop stream, an ended session returns nothing while the desktop shows its archive, a cursor page repeats or skips entries, or a request with no limit returns more than one page | Product shaping S2; D-005,D-013 | Observable behavior/state/guarantee; named counter-observation W2 below. | Partial: archive traversal counts/turn0 do not independently assert every expected ordered text, so do not claim a universal sequence detector. Selectors T:143-176 |
| R-3 | POST /device/sessions/:owner/messages delivers through the same coord:send path as the desktop with wake required and returns the delivery outcome as woken, staged, queued or absent | the device send bypasses coord:send, does not request a wake, or reports an outcome that differs from the coord:send result for the same send | Product shaping S3; D-005,D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W3 below. | Source detector present for dispatch/classification; actual phone wake is R38. Selectors M:28-34,62-64; A:82-118 |
| R-4 | Every device session route refuses a request that has no valid device JWT, or whose device lacks the per-device Agent sessions capability, including a device whose capability was revoked before that request | the matrix inventory differs from registered session routes/stream/deviceSessions.list; an auth-state cell is missing; or a request without a valid device JWT or live Agent sessions capability returns session data or performs an action | Product shaping S6; Design Server; D-002,D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W4 below. | Source detector present for enumerated auth partitions; no live phone assertion. Selectors H:59-115,147-168 |
| R-5 | No device session payload contains a seeded secret, a raw tool output or raw tool arguments | a seeded secret, a raw tool output or raw tool arguments appears in a roster row, a transcript page, an archived transcript, a streamed entry, a cursor page or a push payload | Non-goal raw tool viewer; Design; D-013 | Observable behavior/state/guarantee; named counter-observation W5 below. | Source detectors present for specified payload fixtures; not proof every possible credential is recognized. Selectors S:296-326; T:180-208,240-254; P:20-24 |
| R-6 | Session types, client methods, the cursor follower and delivery classification live in papercup-core behind UniFFI, with no session logic in the SwiftUI or Compose layers | a required core session type/client method/cursor follower/delivery classifier is missing or cannot be compiled and used through generated UniFFI on either platform; its positive fixture is absent or unexercised; or Swift/Kotlin session UI parses transcript entries, computes cursors or classifies delivery instead of calling the facade | Design Clients; D-006,D-012,D-018 | Architecture/placement constraint with a positive observable facade-use contract; implementation-shaped wording is a finding, not silently pass. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-7 | Every device session route and the agent-to-owner push fanout have a passing Vitest suite with no skipped or quarantined test | a device session route or the push fanout has no Vitest file, or one of those suites is red, skips a test or is quarantined | Phase1 P-006; D-005,D-013,D-018 | Verification-process outcome (suite health), not direct user behavior; do not equate test files existing with shipped behavior. | Not operationally verified: must use testing router result at eventual product grading; no all-suite-green or zero-skip claim here. Selectors S/T/M/H/E/P/D/V suite index |
| R-8 | The feature is included in the current iOS and Android candidates of iphone-public-release-2026-08-11 and android-public-release-2026-10-01 with each release-plan owner's recorded agreement | either current candidate build lacks the session feature, or either release-plan owner's agreement is absent | D-004,D-013; Phase5 P-019 | Observable behavior/state/guarantee; named counter-observation W8 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names deployed evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-9 | POST /device/sessions/:owner/end ends the target session through the same server action the desktop Stop agent control uses | the device route dispatches a different server action than desktop Stop agent (fleet:kill, D-008). The bound tree tests establish action parity; they do not establish actual session termination. Oracle/readback propagation is graded by R-26. A session still live after a successful end remains an R-9 outcome failure requiring live evidence, with R-46 phone/desktop-oracle observations and R-49 successful pre-revocation end controls; those live obligations cannot be discharged by the mocked oracle. | Product shaping S5; D-003,D-008,D-019,D-020 | Observable behavior/state/guarantee; named counter-observation W9 below. | UNDER-BOUND for its retained actual-live falsifier: neither file terminates/observes a real session; R46/R49 manual proof remains required. Selectors E:33-41; A:136-160 |
| R-10 | A coord message from an agent session addressed to the owner produces one push to each paired device of that workspace that holds the Agent sessions capability | an agent-to-owner message (to human, or an ask-owner) produces no push for a capable paired device, or produces more than one push for it | Product shaping S4; D-003,D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W10 below. | Source detector present for provider-request cardinality, not real push arrival (R37). Selectors D:76-120; V:248-259; P:40-50 |
| R-11 | A new turn in a live session reaches an already-open device transcript stream without the client reopening it | a new turn reaches the device only after the stream is reopened | Product shaping S2; D-005,D-013 | Observable behavior/state/guarantee; named counter-observation W11 below. | Source detector present for server already-open stream; no client/LAN/relay UI proof. Selectors T:233-238 |
| R-12 | Two sends from one device carrying the same idempotency key and body deliver exactly one message | a retried send with the same key and body delivers a second message, or the same key used by two different devices delivers only one message | Product shaping S3; D-005,D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W12 below. | Source detector present for tested concurrency/idempotency scope. Selectors I:63-89; M:66-72 |
| R-13 | A message sent from the phone reaches the session labelled as sent by the owner from a paired device | the delivered message is attributed to an agent or an anonymous sender, or carries no paired-device label | Product shaping S3; D-005,D-010,D-013 | Observable behavior/state/guarantee; named counter-observation W13 below. | Source detector present for envelope label; provenance not inferred from label (R35 separate). Selectors A:71-80; M:28-34 |
| R-14 | Each phone app issues a session send only inside the configured biometric unlock window (D-002/D-009) | either app issues a send with no unlock or an expired unlock, or refuses a send solely for the biometric gate during a fresh configured window | D-002,D-009,D-018 | Observable behavior/state/guarantee; named counter-observation W14 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-15 | Every accepted send and end writes one device actions audit row naming the device, the target session and the action | a send or end completes with no audit row, or the row names the wrong device, session or action | Design device actions log; D-005,D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W15 below. | Source detector present for enumerated accepted send/end receipt cases. Selectors I:145-155; E:33-37; M:28-34 |
| R-16 | Each phone's transcript cache is readable only after a biometric unlock | either phone can read cached transcript text without a biometric unlock, or the positive unlocked read fixture cannot read the safe cached transcript | D-006,D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W16 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-17 | The iOS and Android apps present the same session screens and controls: the Sessions segment under Fleet with its roster filters, the session detail screen, the send composer and the End session control | a session screen or control exists on one platform but not the other, or is reached by a different path | Design Clients; D-005,D-006,D-012 | Observable behavior/state/guarantee; named counter-observation W17 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-18 | Both phone apps require confirmation before sending an End session action | either phone invokes an end action before confirmation or after cancellation | Product shaping S5; D-003,D-006,D-012,D-018 | Observable behavior/state/guarantee; named counter-observation W18 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-19 | Every device session route refuses a request whose target session owner belongs to a workspace other than the device's workspace | a capable device in one workspace reads the transcript of, sends to or ends a session in another workspace | Non-goal outside workspace; S6; D-005,D-013 | Observable behavior/state/guarantee; named counter-observation W19 below. | Source detector present for tested workspace admission partitions. Selectors H:172-185; T:211-214; S:203-227 |
| R-20 | Each GET /device/sessions row carries the owner id, label, role, harness, pot, fleet, intent, held work item and last activity time of its session | a row omits one of those fields, or a field value differs from the value the desktop roster shows for the same session | Product shaping S1/S2; D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W20 below. | Source detector present for full enumerated field/fallback contract. Selectors S:231-293 |
| R-21 | The session state on each GET /device/sessions row equals the state the shared presence oracle reports for that owner at the same moment | a row reports a different state (live, parked, draining, suspect, ended or recorded) than the presence oracle reports for that owner at the same moment | Product shaping S1; D-013 | Observable behavior/state/guarantee; named counter-observation W21 below. | Source detector present for named oracle states, independent of heartbeat. Selectors S:329-342 |
| R-22 | Following the returned cursor through GET /device/sessions visits every session of a fixed population exactly once | a cursor walk over a fixed population repeats a session or skips one | Product shaping S1; D-013 | Observable behavior/state/guarantee; named counter-observation W22 below. | Source detector present for fixed-population paging fixture. Selectors S:347-379 |
| R-23 | Over the complete cursor walk of a fixed snapshot, a filtered GET /device/sessions returns exactly the sessions matching every supplied filter | the complete filtered cursor walk includes a session failing any supplied filter or omits any session matching all supplied filters | Product shaping S1; D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W23 below. | Source detector present for enumerated filter matrix; not all arbitrary future filter keys. Selectors S:395-447 |
| R-24 | After completing roster paging/scrolling for a stable workspace snapshot, each paired phone displays exactly the desktop roster session identity set and count | either phone's fully traversed roster has a different session identity set/count from the stable desktop snapshot, or a duplicate substitutes for a missing session | Product shaping S1; D-013,D-018; P-016 | Observable behavior/state/guarantee; named counter-observation W24 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-25 | Revoking a device's Agent sessions capability ends every transcript stream that device has open | an open transcript stream keeps delivering entries to the device after its capability is revoked | Product shaping S6; D-013,D-016 | Observable behavior/state/guarantee; named counter-observation W25 below. | Source detector present for multi-stream revocation and unaffected-device positive control. Selectors T:257-298 |
| R-26 | The end response reports the session state the presence oracle shows for that owner after the end completes | the end response reports a state other than the post-end presence state for that owner | Product shaping S5; D-013,D-019,D-020 | Observable behavior/state/guarantee; named counter-observation W26 below. | Source detector present for mocked response propagation only; no actual termination proof. Selectors E:33-41 |
| R-27 | POST /device/sessions/:owner/end refuses a target that is not an agent session before any end action runs | the route ends, or starts ending, a routine host, git-sync, green-checkpoint, another human session or any other session that is not an agent session | Product shaping S5; D-008,D-013 | Observable behavior/state/guarantee; named counter-observation W27 below. | Source detector present for admission table; universal future-class guarantee rests on fail-closed production predicate, not exhaustive future enumeration. Selectors E:48-70 |
| R-28 | A repeated end request for an already-ended session returns the ended state without running the end action again | a retried end on an ended session errors, or runs the end action a second time | Product shaping S5; D-008,D-013 | Observable behavior/state/guarantee; named counter-observation W28 below. | Partial: unit directly sets ended state and same-key receipt does not prove a fresh-key second end observed a real lifecycle transition. Selectors E:43-46; I:145-150 |
| R-29 | Tapping a session push on the phone opens that session's detail screen | the tap opens a different screen or a different session | Product shaping S4; D-003,D-012,D-013 | Observable behavior/state/guarantee; named counter-observation W29 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-30 | A session push payload is limited to the session reference plus its redacted preview | a push payload carries transcript text beyond the redacted preview, a raw tool output, or any other field | Non-goal raw output; S4; D-013 | Observable behavior/state/guarantee; named counter-observation W30 below. | Source detector present for exact payload object and bounded/redacted fixture. Selectors P:20-24,36-38 |
| R-31 | An agent-to-owner push reaches only devices that hold the Agent sessions capability within the owner's workspace | a device in another workspace, or a device without the capability, receives the push | Non-goal outside workspace; S4/S6; D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W31 below. | Source detector present with allowed-device positive controls. Selectors V:231-259; D:317-325; P:29-34 |
| R-32 | Over the sealed relay an open phone transcript shows a live session's new turn without a manual refresh | over the relay a new turn appears only after the screen is reopened | Product shaping S2; Design Transport; D-013 | Observable behavior/state/guarantee; named counter-observation W32 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-33 | POST /device/sessions/:owner/messages refuses a send that carries no idempotency key | a send without an idempotency key is delivered | Product shaping S3; D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W33 below. | Source detector present for explicit missing/empty key cases. Selectors M:36-39; I:107-143 |
| R-34 | A send that reuses a device's idempotency key with a different body is refused with a conflict | a send reusing a key with a different body is delivered, or is refused with a status other than conflict | Product shaping S3; D-013,D-015 | Observable behavior/state/guarantee; named counter-observation W34 below. | Source detector present for body/target conflicts. Selectors I:73-81; M:66-72 |
| R-35 | Turn provenance classifies a phone-sent message as agent-origin and never as owner-typed | a phone-sent message is classified as an owner-typed turn, or is recorded as an owner directive | D-010,D-013,D-015,D-018 | Observable behavior/state/guarantee; named counter-observation W35 below. | Partial: source bridge asserts classifier/insert behavior and stamp-query absence; it does not execute every UserPromptSubmit side effect. Whole send file dirty at original pin; bridge snapshot scope explicit. Selectors C:380-446; A:71-80; M:28-34 |
| R-36 | Every refused send or end writes exactly one device actions audit row identifying the acting device, target session plus refusal reason if and only if the request passed device JWT authentication. | An authenticated refused send or end produces zero or more than one device-action audit row, or the row identifies the wrong authenticated device, target session, action or refusal reason; or a send/end that fails device-JWT authentication produces any device-action audit row. | D-013,D-014,D-015,D-017,D-018 | Observable behavior/state/guarantee; named counter-observation W36 below. | Partial split: realPG identified refusals measured in source; unauth no-row relies on mount test's mocked audit not-called, not a direct DB zero-row read for every JWT state. Selectors I:91-155; H:148-155; M:36-50; E:77-81 |
| R-37 | An agent message to the owner reaches each paired phone as a production push notification whose tap opens that session's detail screen | an agent message to the owner shows no notification on a paired iOS or Android device, the notification was simulated or injected rather than delivered by the production push pipeline, or tapping it opens a different screen or session | Product shaping S4; D-003,D-013 | Observable behavior/state/guarantee; named counter-observation W37 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-38 | A message sent from each paired phone to a parked agent wakes that agent | either phone send leaves the target agent parked or wakes a different agent | Product shaping S3; D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W38 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-39 | After the device's Agent sessions capability is revoked, each app replaces its session screens with a refusal message | after a capability revoke an app still renders roster rows, a transcript or the composer, or shows a blank screen instead of the refusal message | Product shaping S6; D-012,D-013 | Observable behavior/state/guarantee; named counter-observation W39 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-40 | Sending from each phone's session-detail composer constructs a request for the selected session with the exact typed text and a nonempty idempotency key | either composer changes the typed text, targets another session or omits/changes the action's idempotency key on retry | Product shaping S3; D-012,D-013,D-018 | Observable behavior/state/guarantee; named counter-observation W40 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-41 | Over a direct connection an open phone transcript shows a live session's new turn without a manual refresh | over a direct connection a new turn appears only after the screen is reopened | Product shaping S2; Design Transport; D-013 | Observable behavior/state/guarantee; named counter-observation W41 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-42 | The current iOS and Android candidate store privacy packets disclose on-device session transcript display | either candidate's privacy packet omits on-device session transcript display | D-004,D-018; P-015/P-019 | Observable behavior/state/guarantee; named counter-observation W42 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names deployed evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-43 | Each current iOS and Android release candidate retains all of its previously required acceptance after integrating the session feature | a prior mandatory candidate acceptance check regresses, or a fresh grade for either integrated artifact is missing | D-004,D-018; P-019 | Observable behavior/state/guarantee; named counter-observation W43 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names deployed evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-44 | Each phone app issues an End session action only inside the configured biometric unlock window (D-002/D-009) | either app issues an end without an unlock or with an expired unlock, or the biometric gate refuses an end inside a fresh window | D-002,D-009,D-012,D-018 | Observable behavior/state/guarantee; named counter-observation W44 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-45 | Unpairing deletes the transcript cache on each phone | either phone retains readable cached transcript text after unpair, including after re-pair and unlock | D-006,D-018; P-015 | Observable behavior/state/guarantee; named counter-observation W45 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-46 | After a confirmed End session each paired phone shows the returned session state, including ended or an explicitly unknown verdict | either phone keeps showing the session live after an ended verdict or fabricates ended when the resulting verdict is unknown/refused, or the target session is still live in the desktop/presence oracle after a successful confirmed End session on either paired phone | Product shaping S5; D-018,D-019,D-020 | Observable behavior/state/guarantee; named counter-observation W46 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-47 | A message sent from each paired phone is recorded in the target agent's transcript | either phone's sent message is missing from the target transcript or recorded under a different target/text | Product shaping S3; D-018; P-016 | Observable behavior/state/guarantee; named counter-observation W47 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-48 | One composer send action on either phone issues exactly one POST to the target session messages route | one composer submit issues zero or multiple POSTs on either platform | Product shaping S3; D-018; P-009/P-012 | Observable behavior/state/guarantee; named counter-observation W48 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names tree evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-49 | After desktop revocation of its Agent sessions capability, each paired phone's session reads/sends/ends are refused without an action side effect | either revoked phone receives session data or successfully sends/ends, a post-revoke action side effect occurs, or either platform lacks successful pre-revoke and refused post-revoke controls | Product shaping S6; D-018; P-016 | Observable behavior/state/guarantee; named counter-observation W49 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |
| R-50 | Both paired phone apps display current/recent and ended-session archived transcript entries in order and load older entries on scroll without omissions or duplicates | either phone fails to display historical/archive entries, cannot load older pages on scroll, or displays an out-of-order, omitted or duplicated transcript entry | Product shaping S2; D-018; P-016 | Observable behavior/state/guarantee; named counter-observation W50 below. | MANUAL / NOT VERIFIED. check=instrument:none; method names live evidence. Existing cross-hive detector/CI/artifact availability was not inspected; objective automation binding remains unestablished in this scope. See full stored method below. |

## Failure-surface census and coverage mapping

Population was derived from the complete preserved goal/scenarios/non-goals, design, phase5 acceptance and all Decision bodies below. These are logical contract mappings, not observations that product failure probes passed. Unavailable actual CI/live/candidate observations stay unavailable.

| Surface | concrete failure | source | current BARs |
|---|---|---|---|
| F01 | No valid JWT, expired/invalid/revoked-device auth; no data/action/audit side effect | S6;D2;D17 | R-4, R-36, R-49 |
| F02 | Missing/revoked capability, including desktop grant removal | S6;Design;D2 | R-4, R-25, R-39, R-49 |
| F03 | Foreign/unknown owner target or foreign push recipient | non-goal outside workspace;S6 | R-1, R-19, R-31, R-49 |
| F04 | New registered session door omitted from auth matrix | Design Server;D18 | R-4 |
| F05 | Roster primary read unavailable or degraded legs hidden | Current state/Design roster readers;S1 | R-1, R-20, R-21 |
| F06 | Roster population active/starting/pending/ended/global missing or foreign | S1;D13 | R-1, R-20, R-21, R-24 |
| F07 | Roster repeated/skipped rows, malformed cursors/limits and empty filters | S1;D13;D18 | R-1, R-22, R-23, R-24 |
| F08 | Roster field omission, wrong archival null/fallback or oracle-vs-heartbeat drift | S1/S2;D13;D18 | R-20, R-21 |
| F09 | Transcript archive empty, default unbounded page, missing/duplicate or wrong older order | S2;D13;D18 | R-2, R-50 |
| F10 | Transcript secret/tool argument/output leak across roster/page/archive/cursor/stream/push | no raw tool viewer;D13 | R-5, R-30, R-42 |
| F11 | New live turn requires reopening server stream or phone screen | S2;Design Transport;D13 | R-11, R-32, R-41 |
| F12 | Revocation leaves one of multiple existing streams delivering | S6;D16 | R-25, R-49 |
| F13 | Send bypasses shared path/wake or mislabels woken/staged/queued/absent | S3;Design;D13/D15 | R-3, R-38 |
| F14 | Same-key/body duplicate, cross-device key collapse, missing key or body/target conflict | S3;D13/D15 | R-12, R-33, R-34, R-48 |
| F15 | Phone sender label incorrect or paired token promotes owner-typed directives | S3;D10;D18 | R-13, R-35 |
| F16 | Accepted or refused actions lack exact identified audit cardinality | Design log;D14/D17 | R-15, R-36 |
| F17 | Missing/expired unlock allows send/end or fresh unlock is spuriously refused | D2/D9 | R-14, R-44 |
| F18 | Locked cache is readable or unpair leaves old safe turns after re-pair | D6/D18 | R-16, R-45 |
| F19 | Platform navigation/control mismatch or blank/stale revoked screen | Design Clients;S6;D12 | R-17, R-39 |
| F20 | End dispatched before confirmation/after cancel or from wrong selected session | S5;D3;P18 | R-18, R-40 |
| F21 | Protected/non-agent/unknown/malformed target reaches kill | D8;D13 | R-27 |
| F22 | Bespoke end implementation, wrong close_terminal/reason or stale repeat action | D3/D8 | R-9, R-28 |
| F23 | Kill refuses/unparseable, oracle unknown, fabricated ended or actual still-live after success | S5;D8/D19/D20 | R-9, R-26, R-46, R-49 |
| F24 | Eligible push missing/duplicated, foreign/ungranted target or wildcard preview | S4;D3/D13 | R-10, R-30, R-31 |
| F25 | Production push absent, simulated instead of delivered, or wrong tap target | S4;D3/D13 | R-29, R-37 |
| F26 | Phone send targets/wakes wrong agent, changes text, drops stored turn or POSTs twice | S3;D18 | R-38, R-40, R-47, R-48 |
| F27 | Core/UniFFI API missing/unused or screen implements parsing/cursor/classifier locally | Design Clients;D6/D12/D18 | R-6 |
| F28 | Mobile CI/positive facade fixtures unavailable; negative guard passes vacuously | D6/D12/D18 | R-6, R-7, R-14, R-16, R-17, R-18, R-29, R-39, R-40, R-44, R-45, R-48, R-50 |
| F29 | Current candidate feature/owner agreement absent; privacy disclosure or previous mandatory acceptance regresses | D4;P15/P19;D18 | R-8, R-42, R-43 |
| F30 | Live proof over only one phone/transport or counts substitute for identity sets | P16;S1-S6;D18 | R-24, R-32, R-37, R-38, R-41, R-46, R-47, R-49, R-50 |

Explicit boundary: the plan has no separate risk-note section in its section index. This census uses its named failure/degrade paths; it does not claim to discover every imaginable product risk. D11 rate limiting/abuse throttling and D3 interrupt/yield are explicit non-goals, not missing mandatory BARs.

## Exact committed detector source inventory

| Alias | full path | blob | whole working tree matched pin at capture |
|---|---|---|---|
| S | packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts | f64606ebf06fbda51e45bb491b695e4f7090b18d | true |
| T | packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts | 8a8202820558e82eca59b3b187e64de5fd47ad63 | true |
| M | packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts | 45aeb9b39890b04da484b177ef3c0e636c0f21e8 | true |
| H | packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts | 9136643855664201dc146ff1da6da521e146f0d8 | true |
| E | packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts | 50e89b2058f4f92431aea9d6c9ba4b9fd8932f46 | true |
| A | packages/operator-core/lib/owner-sessions/actions.test.ts | c2d584895ab3f0780eae479b1f282aa6f575189d | true |
| I | packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts | 807e06c5638f9e6db53a2b7511a1c5388f74c2c0 | true |
| P | packages/operator-core/lib/session-push.test.ts | 806612fb9d83ae902e422f5c90a1d434fa0db929 | true |
| D | packages/operator-core/lib/device-push-dispatcher.test.ts | 5fe1d8f1188a48631f7b0d843629fa88ddd8abc7 | true |
| V | packages/operator-core/lib/device-store.integration.test.ts | 99a42f0c738ca559a8729e269a9e3c5ea92575d1 | true |
| C | packages/operator-core/lib/agent-tools/coordination/tools/send.test.ts | 055843e553c456215130f208c79c37c7df4aaec9 | false |

## Every tests-bound BAR: assertion, fixture and positive-control matrix

This is source inspection of all tests-bound BARs, not a test execution. A detector-present statement means the named assertion can contradict the named fixture drift; it is not an adequacy verdict over untested populations.

| BAR | selectors at full pinned commit | actual assertion/fixture and positive control read | limitation/result |
|---|---|---|---|
| R-1 | S:134-167 | Complete unfiltered snapshot walk uses independent desktopKeys; asserts all keys equality, total, multi-page count, Set uniqueness. Positive fixture includes active/starting/pending/ended/global plus foreign controls. | Source detector present for fixture population; no test run performed. |
| R-2 | T:143-176 | Compares complete device body to desktopPage for the same request; archive fixture121 rows asserts cap<=50, unique count121, length121 and turn0; malformed paging returns400 beforeSQL; unavailable history503. | Partial: archive traversal counts/turn0 do not independently assert every expected ordered text, so do not claim a universal sequence detector. |
| R-3 | M:28-34,62-64; A:82-118 | Route asserts owner/workspace/text/scoped key/paired identity; shared sender decisive dispatch equals desktop and wake required; table asserts queued/woken/staged/absent exact delivery. | Source detector present for dispatch/classification; actual phone wake is R38. |
| R-4 | H:59-115,147-168 | AST registered route inventory == DOORS with nonzero route and sync positive controls; per-door missing/invalid/expired/revoked JWT refuse with zero data/action/audit calls; grant-off403 then grant-on200 and revoke403. | Source detector present for enumerated auth partitions; no live phone assertion. |
| R-5 | S:296-326; T:180-208,240-254; P:20-24 | Planted secret omitted with redacted/safe-text positive controls; tool_result/tool_use project null, text projection keeps answer; older cursor safe text retained; native append retains final-safe-text; push dispatched and seeded credentials/raw tool fields absent. | Source detectors present for specified payload fixtures; not proof every possible credential is recognized. |
| R-7 | S/T/M/H/E/P/D/V suite index | Current check binds route, push orchestration/dispatcher and store suites. Meta source inspection does not execute the union or inspect skip/quarantine run output. | Not operationally verified: must use testing router result at eventual product grading; no all-suite-green or zero-skip claim here. |
| R-9 | E:33-41; A:136-160 | E spies shared end args and mocked post-action oracle. A compares decisive dispatch with actual desktop route and requires /api/agent-tools/fleet/kill plus close_terminal:true/reason. | UNDER-BOUND for its retained actual-live falsifier: neither file terminates/observes a real session; R46/R49 manual proof remains required. |
| R-10 | D:76-120; V:248-259; P:40-50 | Composed production orchestration/dispatcher with FCM/APNs doubles records recipient ids for1/2 eligible devices, checks exact set and one dispatch each. RealPG targets exclude denied devices; hook waits durable append. | Source detector present for provider-request cardinality, not real push arrival (R37). |
| R-11 | T:233-238 | Opens stream, appends a native agent_message, ticks existing watcher, reads new-live-turn on same reader. | Source detector present for server already-open stream; no client/LAN/relay UI proof. |
| R-12 | I:63-89; M:66-72 | RealPG four concurrent same-key requests invoke action once and produce one row; two phones/workspaces invoke3 actions; changed body/target conflict without repeat. | Source detector present for tested concurrency/idempotency scope. |
| R-13 | A:71-80; M:28-34 | Exact paired-device body label, non-admin client prefix and forwarded verified phone fields. Positive accepted send reaches dispatch. | Source detector present for envelope label; provenance not inferred from label (R35 separate). |
| R-15 | I:145-155; E:33-37; M:28-34 | Accepted send/end via real route receipts called twice return200; action called once, DB row length1 with actor/subject/action/device/status; raw request text absent. | Source detector present for enumerated accepted send/end receipt cases. |
| R-19 | H:172-185; T:211-214; S:203-227 | Valid capable own-workspace request first200; foreign fixture404 with no history/send/end; S tests unknown/foreign refusal and valid/global/ended positive resolution. | Source detector present for tested workspace admission partitions. |
| R-20 | S:231-293 | All9 fields compared to desktop; ended field existence plus exact nulls; fallback table lastActive/endedAt/startedAt/null; empty label/intent retained. | Source detector present for full enumerated field/fallback contract. |
| R-21 | S:329-342 | Oracle map live/parked/draining/suspect/ended/recorded/null with all fresh heartbeats; compares each returned state to map. | Source detector present for named oracle states, independent of heartbeat. |
| R-22 | S:347-379 | 25 tied/null fixture rows, limit7:4pages, exact25length, unique25 and equality to expected owner set; malformed cursor/limit400. | Source detector present for fixed-population paging fixture. |
| R-23 | S:395-447 | All named filter combinations use independent desktop fixture predicate over complete filtered cursor walk; totals/set/each-row predicate/unique ids asserted; empty case and unknown-state refusal. | Source detector present for enumerated filter matrix; not all arbitrary future filter keys. |
| R-25 | T:257-298 | Operating stream positive append; two phone-a streams pre-revoke plus phone-b control; revoke emits access_revoked+EOF on both, stop count2, no further revoked reads, phone-b receives after-turn. | Source detector present for multi-stream revocation and unaffected-device positive control. |
| R-26 | E:33-41 | Fixture oracle ended ->response ended; oracle null ->response null. Success uses f.end positive spy. | Source detector present for mocked response propagation only; no actual termination proof. |
| R-27 | E:48-70 | Protected routine/git-sync/checkpoint/human/system roles, unknown/missing/malformed role/native handle/backend refuse403 before f.end; getKnownRoles positives call action once. | Source detector present for admission table; universal future-class guarantee rests on fail-closed production predicate, not exhaustive future enumeration. |
| R-28 | E:43-46; I:145-150 | Already-ended fixture returns ended/alreadyEnded and no end call; realPG same-key accepted retry invokes action once. | Partial: unit directly sets ended state and same-key receipt does not prove a fresh-key second end observed a real lifecycle transition. |
| R-30 | P:20-24,36-38 | Exact dispatcher payload title/body/data kind+owner; planted credential/tool field absent; preview length200; positive dispatcher invocation exists. | Source detector present for exact payload object and bounded/redacted fixture. |
| R-31 | V:231-259; D:317-325; P:29-34 | RealPG/RLS target query returns only allowed token then empty after revoke/grant removal; foreign/paused/revoked/ungranted excluded; dispatcher asserts capability forwarded; sender wildcard/foreign rejected. | Source detector present with allowed-device positive controls. |
| R-33 | M:36-39; I:107-143 | Missing/empty key returns400 and zero sender; realPG missing-key refusal exactly1 identified row; valid keyed accepted control M28/I145 remains. | Source detector present for explicit missing/empty key cases. |
| R-34 | I:73-81; M:66-72 | Initial key executes once; changed body/target409; action call count1 and2 conflict audit rows; route forwards conflict exactly. | Source detector present for body/target conflicts. |
| R-35 | C:380-446; A:71-80; M:28-34 | Real paired send through coord handler ->tagWakeText/ledger/classify/classifyRecordedTurn/insertTurns forClaude/Codex/OMP plus forged envelope; wake-pump/agent-injected, no ownerChat fields, excluded OWNER_CANDIDATE verdict; untagged owner text positive owner-interactive. | Partial: source bridge asserts classifier/insert behavior and stamp-query absence; it does not execute every UserPromptSubmit side effect. Whole send file dirty at original pin; bridge snapshot scope explicit. |
| R-36 | I:91-155; H:148-155; M:36-50; E:77-81 | RealPG table of identified authenticated send/end refusals asserts status/reason, DB length1/full fields and no private text; accepted retry positive writes1. JWT-negative auth tests assert f.audit never called. | Partial split: realPG identified refusals measured in source; unauth no-row relies on mount test's mocked audit not-called, not a direct DB zero-row read for every JWT state. |

## Every manual/deployed/live BAR: operational availability result

| BAR | plane | current binding | required method (verbatim) | observed availability result |
|---|---|---|---|---|
| R-6 | tree | instrument:none | Manual mobile-CI evidence per D-006/D-012, required during P-007: cite canonical papercup-core and papercup-bindings cargo test run ids plus iOS/Android CI run ids (tools/ios-ci.py and tools/android-ci.py). Require a positive session API compile/use contract through generated UniFFI Swift and Kotlin facades: construct/round-trip the exported roster/transcript/delivery types, invoke roster/transcript/send/end client methods against request-recording fixtures, advance the exported cursor follower across initial/older/new pages, and assert woken/staged/queued/absent delivery classification. A missing/renamed API or an unused facade must fail the positive contract. Also run the existing required mechanical Swift/Kotlin session-screen guard against local transcript parsing, cursor computation or delivery classification. A negative guard or unrelated cargo pass alone cannot satisfy R-6; future fixture names/source paths and actual per-platform CI run ids must be cited, never assumed present. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-8 | deployed | instrument:none | Cite the Decision/thread post on each release plan recording its owner's agreement before candidate changes, identify both exact candidate build versions/artifacts, and confirm the session feature on each installed candidate. R-42 and R-43 separately require privacy-packet updates and preservation of prior candidate acceptance. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-14 | tree | instrument:none | In papercup-rust-mobile CI, run the canonical papercup-core send unlock-window test and iOS/Android send-unit fixtures for no unlock, expired unlock and fresh unlock. Assert no send request in the first two cases and a send request in the fresh case; cite cargo and both platform CI run ids. R-44 independently checks end. The server does not verify a client unlock per D-009. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-16 | tree | instrument:none | In papercup-rust-mobile CI, cite the papercup-core transcript_cache_locked_and_cleared_on_unpair test's independent read-lock assertions and iOS TranscriptCacheLockTests / Android TranscriptCacheLockTest CI run ids. Require locked/unlocked positive and negative read controls on both platforms. R-45 separately owns delete-on-unpair. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-17 | tree | instrument:none | In papercup-rust-mobile CI, cite the run ids and screenshots of the XCUITest SessionsNavigationUITests (tools/ios-ci.py) and the Compose UI SessionsNavigationTest (tools/android-ci.py), each walking Fleet to Sessions to detail to composer to End session. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-18 | live | instrument:none | Require independently named confirmation/cancel/confirm assertions in XCUITest EndSessionUITests and Compose EndSessionTest; cite both mobile CI run ids. On each paired platform in P-016, show that the initial tap and cancel invoke no end action, then confirm the test session's end. R-46 owns resulting-state UI. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-24 | live | instrument:none | P-016: freeze or identify a stable desktop roster snapshot, then complete roster scrolling/paging on paired iOS and Android phones. Record timestamped per-platform identity sets and counts, with screenshots/automation captures covering all pages, and compare each against the same desktop snapshot. Assert count equality, set equality and no duplicate displayed identities; counts alone are insufficient. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-29 | tree | instrument:none | In papercup-rust-mobile CI, run the XCUITest PushTapOpensSessionUITests and the Compose UI PushTapOpensSessionTest (tools/ios-ci.py, tools/android-ci.py); cite both CI run ids. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-32 | live | instrument:none | Cite the papercup-core cursor-follower test run in papercup-rust-mobile CI, plus the P-016 artifact: a paired device on the BYOC relay showing a new turn appear in an open transcript. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-37 | live | instrument:none | P-016 artifact: with a paired iOS device and a paired Android device each locked and the app in the background, have a test agent coord:send to the owner. Per device, record a timestamped screenshot or screen recording showing the notification delivered through the production APNs or FCM pipeline (no simulated or test-injected notification), then the tap landing on that agent's session detail screen. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-38 | live | instrument:none | P-016: on paired iOS and Android, send to a parked test agent and record timestamped phone send evidence plus the desktop session/presence transition from parked to live for that exact agent. R-47 independently verifies transcript recording. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-39 | tree | instrument:none | In papercup-rust-mobile CI, run the XCUITest RevokedDeviceUITests and the Compose UI RevokedDeviceTest (tools/ios-ci.py, tools/android-ci.py), each revoking the capability on a stubbed server while the roster and a session detail screen are open; cite both CI run ids. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-40 | tree | instrument:none | In papercup-rust-mobile CI run XCUITest ComposerSendUITests and Compose ComposerSendTest with a recording server. Require separately named per-platform assertions for exact unchanged text, selected owner/session target and a nonempty per-action idempotency key retained on retry. Cite both CI run ids and recorded request fields; R-48 independently measures POST cardinality. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-41 | live | instrument:none | P-016 artifact: a paired iOS device and a paired Android device each connected directly to the desktop (not through the relay), each recording a new turn appearing in an open transcript, with the connection type shown or logged. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-42 | deployed | instrument:none | For both current release plans, cite the privacy-packet diffs and release-owner review against the actual candidate feature/data handling; identify the exact App Store and Play packet versions. Require the on-device transcript disclosure in both. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-43 | deployed | instrument:none | For iphone-public-release-2026-08-11 and android-public-release-2026-10-01 cite fresh release-rubric grades against the exact integrated candidate artifact, taken after integration and covering every prior mandatory release criterion. Missing/stale evidence is unknown; earlier grades do not satisfy this obligation. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-44 | tree | instrument:none | In papercup-rust-mobile CI, run the core end unlock-window test plus iOS/Android end-unit fixtures for no unlock, expired unlock and fresh unlock. Assert no end request for the first two and an allowed end request for the fresh case, with confirmation handled separately by R-18. Cite cargo and both platform CI run ids. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-45 | tree | instrument:none | Cite canonical cargo transcript_cache_locked_and_cleared_on_unpair independent delete assertions and iOS TranscriptCacheLockTests / Android TranscriptCacheLockTest CI run ids. Seed safe cached turns, unpair, then re-pair/unlock and assert old cached turns remain unavailable on each platform. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-46 | live | instrument:none | Cite independent resulting-state assertions in XCUITest EndSessionUITests and Compose EndSessionTest for ended and unknown responses. P-016 on each paired platform: confirm a test end, record the phone state and matching desktop/oracle verdict. Refusal leaves the prior state plus error, never a fabricated ended state. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-47 | live | instrument:none | P-016 on paired iOS and Android: record unique safe sent text and exact target, then cite the target's stored transcript turn plus the phone/desktop transcript displaying that same message. Keep R-35 agent-origin safety and R-38 wake evidence separate. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-48 | tree | instrument:none | In the XCUITest ComposerSendUITests and Compose ComposerSendTest recording-server fixtures, independently count POSTs for one submit on each platform, including rapid/double-tap UI input. Require exactly one POST before any separately initiated transport retry; cite both CI run ids and request counts. R-12 governs idempotent retry acceptance. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-49 | live | instrument:none | P-016 live evidence on paired iOS and Android, with exact builds/connection and device identities: perform successful pre-revoke read/send/end controls on disposable target sessions; revoke that phone's capability in desktop Settings; retry roster/transcript/stream read, send and end. Record refusal responses, absence of session payload, no delivered/woken message and no fleet:kill/end side effect for post-revoke actions. Cite device-action/refusal records without confusing them with action side effects. Both phones must pass independently; R-4 tree auth proof, R-25 stream termination and R-39 UI rendering cannot substitute. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |
| R-50 | live | instrument:none | Required canonical mobile fixtures: XCUITest SessionTranscriptHistoryUITests and Compose SessionTranscriptHistoryTest, added under the existing mobile CI suites and run through tools/ios-ci.py / tools/android-ci.py. Use active and ended archived transcripts larger than one page with uniquely identified ordered safe turns; assert initial page display, scroll through every older page, compare the complete ordered identity sequence and fail on missing/duplicate entries. Cite both platform CI run ids/test cases. P-016 also records the same history/archive/older-scroll journey on both paired phone builds; server page or new-append evidence alone cannot satisfy this BAR. | Not executed/inspected here. Future named mobile fixtures are not assumed to exist. Both-platform/live/candidate proof remains mandatory. An existing objectively deciding instrument is neither asserted absent nor asserted bound without a permitted read. |

## Pairwise counter-observation catalogue

Wn is a concrete counterfactual failure stimulus for Rn, not an observed regression. Its counterpart is the other BAR's stated positive fixture/observation held at baseline. For coupled predicates the exception row supplies a narrower witness, marks overlap, or explicitly leaves scope unresolved. This counterexample construction is subject to independent semantic review; it is not a generated all-pass certificate.

| witness | concrete observation |
|---|---|
| W1 | Unfiltered device roster adds a foreign identity once; the desktop identity set stays unchanged. |
| W2 | Device transcript changes one safe text entry for a fixed owner/cursor range while the desktop stream retains the original. |
| W3 | A valid send calls coord:send with wake omitted or reports queued for a staged result. |
| W4 | An expired device JWT is allowed on one registered route; valid granted requests continue working. |
| W5 | Roster intent contains a planted credential while all push payloads remain redacted. |
| W6 | SwiftUI parses transcript text locally while the generated core API remains usable and visible behavior is otherwise correct. |
| W7 | A route suite is skipped while the feature behavior remains correct. |
| W8 | Both candidates contain the feature but one release owner has not agreed to integration. |
| W9 | A confirmed end dispatches a bespoke kill path that nevertheless ends the target and returns the correct state. |
| W10 | One eligible device receives duplicate provider dispatches while at least one production notification arrives and taps correctly. |
| W11 | An already-open device SSE stops appending a new turn; a fresh bounded GET still returns the right entries. |
| W12 | Two identical keyed retries deliver twice, while a keyless request is still refused and a changed-body retry still conflicts. |
| W13 | A delivered phone message has no paired-device label although its provenance stays agent-injected. |
| W14 | The phone issues a SEND after the unlock expires; END remains gated correctly. |
| W15 | An accepted send has no device-action row; refused sends retain the correct single row. |
| W16 | A paired locked phone reads cached safe transcript text; unpair still deletes the cache. |
| W17 | The End control is absent only on iOS during normal navigation; both platforms show refusal after revocation. |
| W18 | Cancel invokes an end action; a separately confirmed end still terminates and displays its result correctly. |
| W19 | A valid capable JWT reads a foreign target while invalid JWTs and missing grants are still refused. |
| W20 | A roster row omits heldWorkItem while identity membership and oracle state remain correct. |
| W21 | A row reports live for a parked oracle owner, keeping every R20 field and identity intact. |
| W22 | A cursor walk repeats an otherwise correct identity without changing the membership set. |
| W23 | A fleet-filtered walk includes a nonmatching fleet row, while the unfiltered walk has correct membership and no duplicates. |
| W24 | A paired phone drops one rendered roster identity although the device API returns the desktop set correctly. |
| W25 | After revoke, a second existing stream continues delivering; the first closes and next HTTP requests refuse correctly. |
| W26 | The end response says parked when the post-action oracle says ended; the target actually ended through fleet:kill. |
| W27 | A protected routine target reaches an end action although an admitted agent end still uses the correct desktop action. |
| W28 | An already-ended repeat invokes the end action again; a fresh agent end remains correct. |
| W29 | A session push tap opens the wrong target; push arrival itself remains real and successful. |
| W30 | A push adds a harmless extra field while its preview remains redacted and all other device payloads remain secret-free. |
| W31 | A foreign or ungranted device receives an extra push while every eligible device receives exactly one. |
| W32 | The relay phone requires reopening to display a new turn; direct follow and server SSE remain correct. |
| W33 | A missing-key send is delivered; valid keyed repeats remain idempotent. |
| W34 | A changed-body reuse is accepted; identical-body keyed repeats still deduplicate. |
| W35 | A correctly labelled phone message enters owner-typed provenance; send delivery and attribution label otherwise remain correct. |
| W36 | An authenticated refused request writes two audit rows; accepted actions still write one. |
| W37 | Provider requests are correct but production APNs/FCM delivery never arrives on one background phone. |
| W38 | The unique message reaches and persists in the target transcript but the parked target is not woken. |
| W39 | The server refuses revoked reads/actions but the phone keeps rendering cached roster/composer UI. |
| W40 | One composer POST targets a different owner while its request count remains exactly one. |
| W41 | A direct phone fails to render a new turn although server append and relay rendering remain correct. |
| W42 | The new transcript use is omitted from one store privacy packet while the candidate feature and integration agreement exist. |
| W43 | A previously required unrelated release acceptance check regresses after integration, with the feature and privacy disclosure intact. |
| W44 | The phone issues END after the unlock expires; SEND remains gated correctly. |
| W45 | Unpair retains old cached turns readable after re-pair/unlock, while locked reads still refuse. |
| W46 | The phone keeps showing live after an ended return value; server fleet:kill and post-end response are correct. |
| W47 | The target wakes but the phone's unique sent text is absent from its persisted transcript. |
| W48 | A double tap produces two otherwise identical valid POSTs; the server deduplicates them. |
| W49 | Both phone apps hide revoked UI, but one real revoked phone still executes an end action. |
| W50 | The phone duplicates or omits an older archived turn while server page fidelity and new-turn appends remain correct. |

## Exhaustive pair classification

Each proposed-separable row uses the two concrete witness catalogue entries named in its columns, under the explicit baseline rule above. The raw row population is exhaustive; no claim is made that its proposed default classification is automatically true. The independent critic must reject invalid constructions rather than inherit a universal pass.

| pair | class/result | left-only construction | right-only construction | exception/disposition |
|---|---|---|---|---|
| R-1/R-2 | proposed-separable | W1; R-2 positive observation held | W2; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-3 | proposed-separable | W1; R-3 positive observation held | W3; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-4 | proposed-separable | W1; R-4 positive observation held | W4; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-5 | proposed-separable | W1; R-5 positive observation held | W5; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-6 | proposed-separable | W1; R-6 positive observation held | W6; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-7 | proposed-separable | W1; R-7 positive observation held | W7; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-8 | proposed-separable | W1; R-8 positive observation held | W8; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-9 | proposed-separable | W1; R-9 positive observation held | W9; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-10 | proposed-separable | W1; R-10 positive observation held | W10; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-11 | proposed-separable | W1; R-11 positive observation held | W11; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-12 | proposed-separable | W1; R-12 positive observation held | W12; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-13 | proposed-separable | W1; R-13 positive observation held | W13; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-14 | proposed-separable | W1; R-14 positive observation held | W14; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-15 | proposed-separable | W1; R-15 positive observation held | W15; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-16 | proposed-separable | W1; R-16 positive observation held | W16; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-17 | proposed-separable | W1; R-17 positive observation held | W17; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-18 | proposed-separable | W1; R-18 positive observation held | W18; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-19 | proposed-separable | W1; R-19 positive observation held | W19; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-20 | proposed-separable | W1; R-20 positive observation held | W20; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-21 | proposed-separable | W1; R-21 positive observation held | W21; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-22 | shared-detector-observation | W1; R-22 positive observation held | W22; R-1 positive observation held | Both bound walks assert uniqueness; R1 model/falsifier is membership, R22 traversal. W1 foreign-extra versus W22 duplicate supplies semantic discrimination, but one omission detector can co-fail. Do not claim disjoint detectors. |
| R-1/R-23 | proposed-separable | W1; R-23 positive observation held | W23; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-24 | proposed-separable | W1; R-24 positive observation held | W24; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-25 | proposed-separable | W1; R-25 positive observation held | W25; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-26 | proposed-separable | W1; R-26 positive observation held | W26; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-27 | proposed-separable | W1; R-27 positive observation held | W27; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-28 | proposed-separable | W1; R-28 positive observation held | W28; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-29 | proposed-separable | W1; R-29 positive observation held | W29; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-30 | proposed-separable | W1; R-30 positive observation held | W30; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-31 | proposed-separable | W1; R-31 positive observation held | W31; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-32 | proposed-separable | W1; R-32 positive observation held | W32; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-33 | proposed-separable | W1; R-33 positive observation held | W33; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-34 | proposed-separable | W1; R-34 positive observation held | W34; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-35 | proposed-separable | W1; R-35 positive observation held | W35; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-36 | proposed-separable | W1; R-36 positive observation held | W36; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-37 | proposed-separable | W1; R-37 positive observation held | W37; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-38 | proposed-separable | W1; R-38 positive observation held | W38; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-39 | proposed-separable | W1; R-39 positive observation held | W39; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-40 | proposed-separable | W1; R-40 positive observation held | W40; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-41 | proposed-separable | W1; R-41 positive observation held | W41; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-42 | proposed-separable | W1; R-42 positive observation held | W42; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-43 | proposed-separable | W1; R-43 positive observation held | W43; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-44 | proposed-separable | W1; R-44 positive observation held | W44; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-45 | proposed-separable | W1; R-45 positive observation held | W45; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-46 | proposed-separable | W1; R-46 positive observation held | W46; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-47 | proposed-separable | W1; R-47 positive observation held | W47; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-48 | proposed-separable | W1; R-48 positive observation held | W48; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-49 | proposed-separable | W1; R-49 positive observation held | W49; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-1/R-50 | proposed-separable | W1; R-50 positive observation held | W50; R-1 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-3 | proposed-separable | W2; R-3 positive observation held | W3; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-4 | proposed-separable | W2; R-4 positive observation held | W4; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-5 | proposed-separable | W2; R-5 positive observation held | W5; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-6 | proposed-separable | W2; R-6 positive observation held | W6; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-7 | proposed-separable | W2; R-7 positive observation held | W7; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-8 | proposed-separable | W2; R-8 positive observation held | W8; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-9 | proposed-separable | W2; R-9 positive observation held | W9; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-10 | proposed-separable | W2; R-10 positive observation held | W10; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-11 | proposed-separable | W2; R-11 positive observation held | W11; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-12 | proposed-separable | W2; R-12 positive observation held | W12; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-13 | proposed-separable | W2; R-13 positive observation held | W13; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-14 | proposed-separable | W2; R-14 positive observation held | W14; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-15 | proposed-separable | W2; R-15 positive observation held | W15; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-16 | proposed-separable | W2; R-16 positive observation held | W16; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-17 | proposed-separable | W2; R-17 positive observation held | W17; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-18 | proposed-separable | W2; R-18 positive observation held | W18; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-19 | proposed-separable | W2; R-19 positive observation held | W19; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-20 | proposed-separable | W2; R-20 positive observation held | W20; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-21 | proposed-separable | W2; R-21 positive observation held | W21; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-22 | proposed-separable | W2; R-22 positive observation held | W22; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-23 | proposed-separable | W2; R-23 positive observation held | W23; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-24 | proposed-separable | W2; R-24 positive observation held | W24; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-25 | proposed-separable | W2; R-25 positive observation held | W25; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-26 | proposed-separable | W2; R-26 positive observation held | W26; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-27 | proposed-separable | W2; R-27 positive observation held | W27; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-28 | proposed-separable | W2; R-28 positive observation held | W28; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-29 | proposed-separable | W2; R-29 positive observation held | W29; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-30 | proposed-separable | W2; R-30 positive observation held | W30; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-31 | proposed-separable | W2; R-31 positive observation held | W31; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-32 | proposed-separable | W2; R-32 positive observation held | W32; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-33 | proposed-separable | W2; R-33 positive observation held | W33; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-34 | proposed-separable | W2; R-34 positive observation held | W34; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-35 | proposed-separable | W2; R-35 positive observation held | W35; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-36 | proposed-separable | W2; R-36 positive observation held | W36; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-37 | proposed-separable | W2; R-37 positive observation held | W37; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-38 | proposed-separable | W2; R-38 positive observation held | W38; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-39 | proposed-separable | W2; R-39 positive observation held | W39; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-40 | proposed-separable | W2; R-40 positive observation held | W40; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-41 | proposed-separable | W2; R-41 positive observation held | W41; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-42 | proposed-separable | W2; R-42 positive observation held | W42; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-43 | proposed-separable | W2; R-43 positive observation held | W43; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-44 | proposed-separable | W2; R-44 positive observation held | W44; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-45 | proposed-separable | W2; R-45 positive observation held | W45; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-46 | proposed-separable | W2; R-46 positive observation held | W46; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-47 | proposed-separable | W2; R-47 positive observation held | W47; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-48 | proposed-separable | W2; R-48 positive observation held | W48; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-49 | proposed-separable | W2; R-49 positive observation held | W49; R-2 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-2/R-50 | different-plane-dependency | W2; R-50 positive observation held | W50; R-2 positive observation held | Server page fidelity vs both phone historical/older rendering. W50 client-only omission preserves server fidelity; W2 can alter safe text in a server range not used by the history fixture. Client proof cannot be replaced by server checks. |
| R-3/R-4 | proposed-separable | W3; R-4 positive observation held | W4; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-5 | proposed-separable | W3; R-5 positive observation held | W5; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-6 | proposed-separable | W3; R-6 positive observation held | W6; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-7 | proposed-separable | W3; R-7 positive observation held | W7; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-8 | proposed-separable | W3; R-8 positive observation held | W8; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-9 | proposed-separable | W3; R-9 positive observation held | W9; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-10 | proposed-separable | W3; R-10 positive observation held | W10; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-11 | proposed-separable | W3; R-11 positive observation held | W11; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-12 | proposed-separable | W3; R-12 positive observation held | W12; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-13 | proposed-separable | W3; R-13 positive observation held | W13; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-14 | proposed-separable | W3; R-14 positive observation held | W14; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-15 | proposed-separable | W3; R-15 positive observation held | W15; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-16 | proposed-separable | W3; R-16 positive observation held | W16; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-17 | proposed-separable | W3; R-17 positive observation held | W17; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-18 | proposed-separable | W3; R-18 positive observation held | W18; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-19 | proposed-separable | W3; R-19 positive observation held | W19; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-20 | proposed-separable | W3; R-20 positive observation held | W20; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-21 | proposed-separable | W3; R-21 positive observation held | W21; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-22 | proposed-separable | W3; R-22 positive observation held | W22; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-23 | proposed-separable | W3; R-23 positive observation held | W23; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-24 | proposed-separable | W3; R-24 positive observation held | W24; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-25 | proposed-separable | W3; R-25 positive observation held | W25; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-26 | proposed-separable | W3; R-26 positive observation held | W26; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-27 | proposed-separable | W3; R-27 positive observation held | W27; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-28 | proposed-separable | W3; R-28 positive observation held | W28; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-29 | proposed-separable | W3; R-29 positive observation held | W29; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-30 | proposed-separable | W3; R-30 positive observation held | W30; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-31 | proposed-separable | W3; R-31 positive observation held | W31; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-32 | proposed-separable | W3; R-32 positive observation held | W32; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-33 | proposed-separable | W3; R-33 positive observation held | W33; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-34 | proposed-separable | W3; R-34 positive observation held | W34; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-35 | proposed-separable | W3; R-35 positive observation held | W35; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-36 | proposed-separable | W3; R-36 positive observation held | W36; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-37 | proposed-separable | W3; R-37 positive observation held | W37; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-38 | proposed-separable | W3; R-38 positive observation held | W38; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-39 | proposed-separable | W3; R-39 positive observation held | W39; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-40 | proposed-separable | W3; R-40 positive observation held | W40; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-41 | proposed-separable | W3; R-41 positive observation held | W41; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-42 | proposed-separable | W3; R-42 positive observation held | W42; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-43 | proposed-separable | W3; R-43 positive observation held | W43; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-44 | proposed-separable | W3; R-44 positive observation held | W44; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-45 | proposed-separable | W3; R-45 positive observation held | W45; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-46 | proposed-separable | W3; R-46 positive observation held | W46; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-47 | proposed-separable | W3; R-47 positive observation held | W47; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-48 | proposed-separable | W3; R-48 positive observation held | W48; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-49 | proposed-separable | W3; R-49 positive observation held | W49; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-3/R-50 | proposed-separable | W3; R-50 positive observation held | W50; R-3 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-5 | proposed-separable | W4; R-5 positive observation held | W5; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-6 | proposed-separable | W4; R-6 positive observation held | W6; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-7 | proposed-separable | W4; R-7 positive observation held | W7; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-8 | proposed-separable | W4; R-8 positive observation held | W8; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-9 | proposed-separable | W4; R-9 positive observation held | W9; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-10 | proposed-separable | W4; R-10 positive observation held | W10; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-11 | proposed-separable | W4; R-11 positive observation held | W11; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-12 | proposed-separable | W4; R-12 positive observation held | W12; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-13 | proposed-separable | W4; R-13 positive observation held | W13; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-14 | proposed-separable | W4; R-14 positive observation held | W14; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-15 | proposed-separable | W4; R-15 positive observation held | W15; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-16 | proposed-separable | W4; R-16 positive observation held | W16; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-17 | proposed-separable | W4; R-17 positive observation held | W17; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-18 | proposed-separable | W4; R-18 positive observation held | W18; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-19 | proposed-separable | W4; R-19 positive observation held | W19; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-20 | proposed-separable | W4; R-20 positive observation held | W20; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-21 | proposed-separable | W4; R-21 positive observation held | W21; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-22 | proposed-separable | W4; R-22 positive observation held | W22; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-23 | proposed-separable | W4; R-23 positive observation held | W23; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-24 | proposed-separable | W4; R-24 positive observation held | W24; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-25 | proposed-separable | W4; R-25 positive observation held | W25; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-26 | proposed-separable | W4; R-26 positive observation held | W26; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-27 | proposed-separable | W4; R-27 positive observation held | W27; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-28 | proposed-separable | W4; R-28 positive observation held | W28; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-29 | proposed-separable | W4; R-29 positive observation held | W29; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-30 | proposed-separable | W4; R-30 positive observation held | W30; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-31 | proposed-separable | W4; R-31 positive observation held | W31; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-32 | proposed-separable | W4; R-32 positive observation held | W32; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-33 | proposed-separable | W4; R-33 positive observation held | W33; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-34 | proposed-separable | W4; R-34 positive observation held | W34; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-35 | proposed-separable | W4; R-35 positive observation held | W35; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-36 | proposed-separable | W4; R-36 positive observation held | W36; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-37 | proposed-separable | W4; R-37 positive observation held | W37; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-38 | proposed-separable | W4; R-38 positive observation held | W38; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-39 | proposed-separable | W4; R-39 positive observation held | W39; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-40 | proposed-separable | W4; R-40 positive observation held | W40; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-41 | proposed-separable | W4; R-41 positive observation held | W41; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-42 | proposed-separable | W4; R-42 positive observation held | W42; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-43 | proposed-separable | W4; R-43 positive observation held | W43; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-44 | proposed-separable | W4; R-44 positive observation held | W44; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-45 | proposed-separable | W4; R-45 positive observation held | W45; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-46 | proposed-separable | W4; R-46 positive observation held | W46; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-47 | proposed-separable | W4; R-47 positive observation held | W47; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-48 | proposed-separable | W4; R-48 positive observation held | W48; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-4/R-49 | different-plane-shared-auth | W4; R-49 positive observation held | W49; R-4 positive observation held | Expired-JWT W4 versus missing live pre/post-revocation controls (not W49 backend bypass) distinguishes; real revoked action bypass would co-fail both. Live controls are a proof obligation separate from the universal route guard. |
| R-4/R-50 | proposed-separable | W4; R-50 positive observation held | W50; R-4 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-6 | proposed-separable | W5; R-6 positive observation held | W6; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-7 | proposed-separable | W5; R-7 positive observation held | W7; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-8 | proposed-separable | W5; R-8 positive observation held | W8; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-9 | proposed-separable | W5; R-9 positive observation held | W9; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-10 | proposed-separable | W5; R-10 positive observation held | W10; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-11 | proposed-separable | W5; R-11 positive observation held | W11; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-12 | proposed-separable | W5; R-12 positive observation held | W12; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-13 | proposed-separable | W5; R-13 positive observation held | W13; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-14 | proposed-separable | W5; R-14 positive observation held | W14; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-15 | proposed-separable | W5; R-15 positive observation held | W15; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-16 | proposed-separable | W5; R-16 positive observation held | W16; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-17 | proposed-separable | W5; R-17 positive observation held | W17; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-18 | proposed-separable | W5; R-18 positive observation held | W18; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-19 | proposed-separable | W5; R-19 positive observation held | W19; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-20 | proposed-separable | W5; R-20 positive observation held | W20; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-21 | proposed-separable | W5; R-21 positive observation held | W21; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-22 | proposed-separable | W5; R-22 positive observation held | W22; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-23 | proposed-separable | W5; R-23 positive observation held | W23; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-24 | proposed-separable | W5; R-24 positive observation held | W24; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-25 | proposed-separable | W5; R-25 positive observation held | W25; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-26 | proposed-separable | W5; R-26 positive observation held | W26; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-27 | proposed-separable | W5; R-27 positive observation held | W27; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-28 | proposed-separable | W5; R-28 positive observation held | W28; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-29 | proposed-separable | W5; R-29 positive observation held | W29; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-30 | partial-secrecy-overlap | W5; R-30 positive observation held | W30; R-5 positive observation held | W5 roster secret and W30 harmless extra push field discriminate. Push secret/raw-tool leak is shared failure; field-set minimisation is stricter than privacy in that one channel. |
| R-5/R-31 | proposed-separable | W5; R-31 positive observation held | W31; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-32 | proposed-separable | W5; R-32 positive observation held | W32; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-33 | proposed-separable | W5; R-33 positive observation held | W33; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-34 | proposed-separable | W5; R-34 positive observation held | W34; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-35 | proposed-separable | W5; R-35 positive observation held | W35; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-36 | proposed-separable | W5; R-36 positive observation held | W36; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-37 | proposed-separable | W5; R-37 positive observation held | W37; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-38 | proposed-separable | W5; R-38 positive observation held | W38; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-39 | proposed-separable | W5; R-39 positive observation held | W39; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-40 | proposed-separable | W5; R-40 positive observation held | W40; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-41 | proposed-separable | W5; R-41 positive observation held | W41; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-42 | proposed-separable | W5; R-42 positive observation held | W42; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-43 | proposed-separable | W5; R-43 positive observation held | W43; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-44 | proposed-separable | W5; R-44 positive observation held | W44; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-45 | proposed-separable | W5; R-45 positive observation held | W45; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-46 | proposed-separable | W5; R-46 positive observation held | W46; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-47 | proposed-separable | W5; R-47 positive observation held | W47; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-48 | proposed-separable | W5; R-48 positive observation held | W48; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-49 | proposed-separable | W5; R-49 positive observation held | W49; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-5/R-50 | proposed-separable | W5; R-50 positive observation held | W50; R-5 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-7 | proposed-separable | W6; R-7 positive observation held | W7; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-8 | proposed-separable | W6; R-8 positive observation held | W8; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-9 | proposed-separable | W6; R-9 positive observation held | W9; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-10 | proposed-separable | W6; R-10 positive observation held | W10; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-11 | proposed-separable | W6; R-11 positive observation held | W11; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-12 | proposed-separable | W6; R-12 positive observation held | W12; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-13 | proposed-separable | W6; R-13 positive observation held | W13; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-14 | proposed-separable | W6; R-14 positive observation held | W14; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-15 | proposed-separable | W6; R-15 positive observation held | W15; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-16 | proposed-separable | W6; R-16 positive observation held | W16; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-17 | proposed-separable | W6; R-17 positive observation held | W17; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-18 | proposed-separable | W6; R-18 positive observation held | W18; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-19 | proposed-separable | W6; R-19 positive observation held | W19; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-20 | proposed-separable | W6; R-20 positive observation held | W20; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-21 | proposed-separable | W6; R-21 positive observation held | W21; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-22 | proposed-separable | W6; R-22 positive observation held | W22; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-23 | proposed-separable | W6; R-23 positive observation held | W23; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-24 | proposed-separable | W6; R-24 positive observation held | W24; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-25 | proposed-separable | W6; R-25 positive observation held | W25; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-26 | proposed-separable | W6; R-26 positive observation held | W26; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-27 | proposed-separable | W6; R-27 positive observation held | W27; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-28 | proposed-separable | W6; R-28 positive observation held | W28; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-29 | proposed-separable | W6; R-29 positive observation held | W29; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-30 | proposed-separable | W6; R-30 positive observation held | W30; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-31 | proposed-separable | W6; R-31 positive observation held | W31; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-32 | proposed-separable | W6; R-32 positive observation held | W32; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-33 | proposed-separable | W6; R-33 positive observation held | W33; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-34 | proposed-separable | W6; R-34 positive observation held | W34; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-35 | proposed-separable | W6; R-35 positive observation held | W35; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-36 | proposed-separable | W6; R-36 positive observation held | W36; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-37 | proposed-separable | W6; R-37 positive observation held | W37; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-38 | proposed-separable | W6; R-38 positive observation held | W38; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-39 | proposed-separable | W6; R-39 positive observation held | W39; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-40 | proposed-separable | W6; R-40 positive observation held | W40; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-41 | proposed-separable | W6; R-41 positive observation held | W41; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-42 | proposed-separable | W6; R-42 positive observation held | W42; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-43 | proposed-separable | W6; R-43 positive observation held | W43; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-44 | proposed-separable | W6; R-44 positive observation held | W44; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-45 | proposed-separable | W6; R-45 positive observation held | W45; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-46 | proposed-separable | W6; R-46 positive observation held | W46; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-47 | proposed-separable | W6; R-47 positive observation held | W47; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-48 | proposed-separable | W6; R-48 positive observation held | W48; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-49 | proposed-separable | W6; R-49 positive observation held | W49; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-6/R-50 | proposed-separable | W6; R-50 positive observation held | W50; R-6 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-8 | proposed-separable | W7; R-8 positive observation held | W8; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-9 | proposed-separable | W7; R-9 positive observation held | W9; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-10 | proposed-separable | W7; R-10 positive observation held | W10; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-11 | proposed-separable | W7; R-11 positive observation held | W11; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-12 | proposed-separable | W7; R-12 positive observation held | W12; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-13 | proposed-separable | W7; R-13 positive observation held | W13; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-14 | proposed-separable | W7; R-14 positive observation held | W14; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-15 | proposed-separable | W7; R-15 positive observation held | W15; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-16 | proposed-separable | W7; R-16 positive observation held | W16; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-17 | proposed-separable | W7; R-17 positive observation held | W17; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-18 | proposed-separable | W7; R-18 positive observation held | W18; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-19 | proposed-separable | W7; R-19 positive observation held | W19; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-20 | proposed-separable | W7; R-20 positive observation held | W20; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-21 | proposed-separable | W7; R-21 positive observation held | W21; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-22 | proposed-separable | W7; R-22 positive observation held | W22; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-23 | proposed-separable | W7; R-23 positive observation held | W23; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-24 | proposed-separable | W7; R-24 positive observation held | W24; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-25 | proposed-separable | W7; R-25 positive observation held | W25; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-26 | proposed-separable | W7; R-26 positive observation held | W26; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-27 | proposed-separable | W7; R-27 positive observation held | W27; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-28 | proposed-separable | W7; R-28 positive observation held | W28; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-29 | proposed-separable | W7; R-29 positive observation held | W29; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-30 | proposed-separable | W7; R-30 positive observation held | W30; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-31 | proposed-separable | W7; R-31 positive observation held | W31; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-32 | proposed-separable | W7; R-32 positive observation held | W32; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-33 | proposed-separable | W7; R-33 positive observation held | W33; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-34 | proposed-separable | W7; R-34 positive observation held | W34; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-35 | proposed-separable | W7; R-35 positive observation held | W35; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-36 | proposed-separable | W7; R-36 positive observation held | W36; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-37 | proposed-separable | W7; R-37 positive observation held | W37; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-38 | proposed-separable | W7; R-38 positive observation held | W38; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-39 | proposed-separable | W7; R-39 positive observation held | W39; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-40 | proposed-separable | W7; R-40 positive observation held | W40; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-41 | proposed-separable | W7; R-41 positive observation held | W41; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-42 | proposed-separable | W7; R-42 positive observation held | W42; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-43 | proposed-separable | W7; R-43 positive observation held | W43; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-44 | proposed-separable | W7; R-44 positive observation held | W44; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-45 | proposed-separable | W7; R-45 positive observation held | W45; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-46 | proposed-separable | W7; R-46 positive observation held | W46; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-47 | proposed-separable | W7; R-47 positive observation held | W47; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-48 | proposed-separable | W7; R-48 positive observation held | W48; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-49 | proposed-separable | W7; R-49 positive observation held | W49; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-7/R-50 | proposed-separable | W7; R-50 positive observation held | W50; R-7 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-9 | proposed-separable | W8; R-9 positive observation held | W9; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-10 | proposed-separable | W8; R-10 positive observation held | W10; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-11 | proposed-separable | W8; R-11 positive observation held | W11; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-12 | proposed-separable | W8; R-12 positive observation held | W12; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-13 | proposed-separable | W8; R-13 positive observation held | W13; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-14 | proposed-separable | W8; R-14 positive observation held | W14; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-15 | proposed-separable | W8; R-15 positive observation held | W15; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-16 | proposed-separable | W8; R-16 positive observation held | W16; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-17 | proposed-separable | W8; R-17 positive observation held | W17; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-18 | proposed-separable | W8; R-18 positive observation held | W18; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-19 | proposed-separable | W8; R-19 positive observation held | W19; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-20 | proposed-separable | W8; R-20 positive observation held | W20; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-21 | proposed-separable | W8; R-21 positive observation held | W21; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-22 | proposed-separable | W8; R-22 positive observation held | W22; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-23 | proposed-separable | W8; R-23 positive observation held | W23; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-24 | proposed-separable | W8; R-24 positive observation held | W24; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-25 | proposed-separable | W8; R-25 positive observation held | W25; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-26 | proposed-separable | W8; R-26 positive observation held | W26; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-27 | proposed-separable | W8; R-27 positive observation held | W27; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-28 | proposed-separable | W8; R-28 positive observation held | W28; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-29 | proposed-separable | W8; R-29 positive observation held | W29; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-30 | proposed-separable | W8; R-30 positive observation held | W30; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-31 | proposed-separable | W8; R-31 positive observation held | W31; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-32 | proposed-separable | W8; R-32 positive observation held | W32; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-33 | proposed-separable | W8; R-33 positive observation held | W33; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-34 | proposed-separable | W8; R-34 positive observation held | W34; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-35 | proposed-separable | W8; R-35 positive observation held | W35; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-36 | proposed-separable | W8; R-36 positive observation held | W36; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-37 | proposed-separable | W8; R-37 positive observation held | W37; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-38 | proposed-separable | W8; R-38 positive observation held | W38; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-39 | proposed-separable | W8; R-39 positive observation held | W39; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-40 | proposed-separable | W8; R-40 positive observation held | W40; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-41 | proposed-separable | W8; R-41 positive observation held | W41; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-42 | proposed-separable | W8; R-42 positive observation held | W42; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-43 | proposed-separable | W8; R-43 positive observation held | W43; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-44 | proposed-separable | W8; R-44 positive observation held | W44; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-45 | proposed-separable | W8; R-45 positive observation held | W45; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-46 | proposed-separable | W8; R-46 positive observation held | W46; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-47 | proposed-separable | W8; R-47 positive observation held | W47; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-48 | proposed-separable | W8; R-48 positive observation held | W48; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-49 | proposed-separable | W8; R-49 positive observation held | W49; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-8/R-50 | proposed-separable | W8; R-50 positive observation held | W50; R-8 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-10 | proposed-separable | W9; R-10 positive observation held | W10; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-11 | proposed-separable | W9; R-11 positive observation held | W11; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-12 | proposed-separable | W9; R-12 positive observation held | W12; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-13 | proposed-separable | W9; R-13 positive observation held | W13; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-14 | proposed-separable | W9; R-14 positive observation held | W14; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-15 | proposed-separable | W9; R-15 positive observation held | W15; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-16 | proposed-separable | W9; R-16 positive observation held | W16; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-17 | proposed-separable | W9; R-17 positive observation held | W17; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-18 | proposed-separable | W9; R-18 positive observation held | W18; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-19 | proposed-separable | W9; R-19 positive observation held | W19; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-20 | proposed-separable | W9; R-20 positive observation held | W20; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-21 | proposed-separable | W9; R-21 positive observation held | W21; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-22 | proposed-separable | W9; R-22 positive observation held | W22; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-23 | proposed-separable | W9; R-23 positive observation held | W23; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-24 | proposed-separable | W9; R-24 positive observation held | W24; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-25 | proposed-separable | W9; R-25 positive observation held | W25; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-26 | proposed-separable | W9; R-26 positive observation held | W26; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-27 | proposed-separable | W9; R-27 positive observation held | W27; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-28 | proposed-separable | W9; R-28 positive observation held | W28; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-29 | proposed-separable | W9; R-29 positive observation held | W29; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-30 | proposed-separable | W9; R-30 positive observation held | W30; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-31 | proposed-separable | W9; R-31 positive observation held | W31; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-32 | proposed-separable | W9; R-32 positive observation held | W32; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-33 | proposed-separable | W9; R-33 positive observation held | W33; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-34 | proposed-separable | W9; R-34 positive observation held | W34; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-35 | proposed-separable | W9; R-35 positive observation held | W35; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-36 | proposed-separable | W9; R-36 positive observation held | W36; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-37 | proposed-separable | W9; R-37 positive observation held | W37; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-38 | proposed-separable | W9; R-38 positive observation held | W38; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-39 | proposed-separable | W9; R-39 positive observation held | W39; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-40 | proposed-separable | W9; R-40 positive observation held | W40; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-41 | proposed-separable | W9; R-41 positive observation held | W41; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-42 | proposed-separable | W9; R-42 positive observation held | W42; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-43 | proposed-separable | W9; R-43 positive observation held | W43; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-44 | proposed-separable | W9; R-44 positive observation held | W44; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-45 | proposed-separable | W9; R-45 positive observation held | W45; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-46 | partial-overlap-retained-guarantee | W9; R-46 positive observation held | W46; R-9 positive observation held | W9 bespoke-but-effective kill and W46 stale phone display discriminate; actual still-live after confirmed end explicitly fails BOTH. This is deliberate retained safety redundancy, not proven non-overlap. |
| R-9/R-47 | proposed-separable | W9; R-47 positive observation held | W47; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-48 | proposed-separable | W9; R-48 positive observation held | W48; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-9/R-49 | positive-control-dependency | W9; R-49 positive observation held | W49; R-9 positive observation held | W9 wrong-but-effective dispatch can preserve post-revoke refusal; W49 post-revoke action can fail while fresh admitted-end parity passes. R49 also requires pre-revoke end controls, so actual-end positive evidence is shared. |
| R-9/R-50 | proposed-separable | W9; R-50 positive observation held | W50; R-9 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-11 | proposed-separable | W10; R-11 positive observation held | W11; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-12 | proposed-separable | W10; R-12 positive observation held | W12; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-13 | proposed-separable | W10; R-13 positive observation held | W13; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-14 | proposed-separable | W10; R-14 positive observation held | W14; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-15 | proposed-separable | W10; R-15 positive observation held | W15; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-16 | proposed-separable | W10; R-16 positive observation held | W16; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-17 | proposed-separable | W10; R-17 positive observation held | W17; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-18 | proposed-separable | W10; R-18 positive observation held | W18; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-19 | proposed-separable | W10; R-19 positive observation held | W19; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-20 | proposed-separable | W10; R-20 positive observation held | W20; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-21 | proposed-separable | W10; R-21 positive observation held | W21; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-22 | proposed-separable | W10; R-22 positive observation held | W22; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-23 | proposed-separable | W10; R-23 positive observation held | W23; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-24 | proposed-separable | W10; R-24 positive observation held | W24; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-25 | proposed-separable | W10; R-25 positive observation held | W25; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-26 | proposed-separable | W10; R-26 positive observation held | W26; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-27 | proposed-separable | W10; R-27 positive observation held | W27; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-28 | proposed-separable | W10; R-28 positive observation held | W28; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-29 | proposed-separable | W10; R-29 positive observation held | W29; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-30 | proposed-separable | W10; R-30 positive observation held | W30; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-31 | proposed-separable | W10; R-31 positive observation held | W31; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-32 | proposed-separable | W10; R-32 positive observation held | W32; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-33 | proposed-separable | W10; R-33 positive observation held | W33; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-34 | proposed-separable | W10; R-34 positive observation held | W34; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-35 | proposed-separable | W10; R-35 positive observation held | W35; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-36 | proposed-separable | W10; R-36 positive observation held | W36; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-37 | proposed-separable | W10; R-37 positive observation held | W37; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-38 | proposed-separable | W10; R-38 positive observation held | W38; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-39 | proposed-separable | W10; R-39 positive observation held | W39; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-40 | proposed-separable | W10; R-40 positive observation held | W40; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-41 | proposed-separable | W10; R-41 positive observation held | W41; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-42 | proposed-separable | W10; R-42 positive observation held | W42; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-43 | proposed-separable | W10; R-43 positive observation held | W43; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-44 | proposed-separable | W10; R-44 positive observation held | W44; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-45 | proposed-separable | W10; R-45 positive observation held | W45; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-46 | proposed-separable | W10; R-46 positive observation held | W46; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-47 | proposed-separable | W10; R-47 positive observation held | W47; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-48 | proposed-separable | W10; R-48 positive observation held | W48; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-49 | proposed-separable | W10; R-49 positive observation held | W49; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-10/R-50 | proposed-separable | W10; R-50 positive observation held | W50; R-10 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-12 | proposed-separable | W11; R-12 positive observation held | W12; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-13 | proposed-separable | W11; R-13 positive observation held | W13; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-14 | proposed-separable | W11; R-14 positive observation held | W14; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-15 | proposed-separable | W11; R-15 positive observation held | W15; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-16 | proposed-separable | W11; R-16 positive observation held | W16; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-17 | proposed-separable | W11; R-17 positive observation held | W17; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-18 | proposed-separable | W11; R-18 positive observation held | W18; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-19 | proposed-separable | W11; R-19 positive observation held | W19; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-20 | proposed-separable | W11; R-20 positive observation held | W20; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-21 | proposed-separable | W11; R-21 positive observation held | W21; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-22 | proposed-separable | W11; R-22 positive observation held | W22; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-23 | proposed-separable | W11; R-23 positive observation held | W23; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-24 | proposed-separable | W11; R-24 positive observation held | W24; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-25 | proposed-separable | W11; R-25 positive observation held | W25; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-26 | proposed-separable | W11; R-26 positive observation held | W26; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-27 | proposed-separable | W11; R-27 positive observation held | W27; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-28 | proposed-separable | W11; R-28 positive observation held | W28; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-29 | proposed-separable | W11; R-29 positive observation held | W29; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-30 | proposed-separable | W11; R-30 positive observation held | W30; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-31 | proposed-separable | W11; R-31 positive observation held | W31; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-32 | proposed-separable | W11; R-32 positive observation held | W32; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-33 | proposed-separable | W11; R-33 positive observation held | W33; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-34 | proposed-separable | W11; R-34 positive observation held | W34; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-35 | proposed-separable | W11; R-35 positive observation held | W35; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-36 | proposed-separable | W11; R-36 positive observation held | W36; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-37 | proposed-separable | W11; R-37 positive observation held | W37; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-38 | proposed-separable | W11; R-38 positive observation held | W38; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-39 | proposed-separable | W11; R-39 positive observation held | W39; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-40 | proposed-separable | W11; R-40 positive observation held | W40; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-41 | proposed-separable | W11; R-41 positive observation held | W41; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-42 | proposed-separable | W11; R-42 positive observation held | W42; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-43 | proposed-separable | W11; R-43 positive observation held | W43; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-44 | proposed-separable | W11; R-44 positive observation held | W44; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-45 | proposed-separable | W11; R-45 positive observation held | W45; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-46 | proposed-separable | W11; R-46 positive observation held | W46; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-47 | proposed-separable | W11; R-47 positive observation held | W47; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-48 | proposed-separable | W11; R-48 positive observation held | W48; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-49 | proposed-separable | W11; R-49 positive observation held | W49; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-11/R-50 | proposed-separable | W11; R-50 positive observation held | W50; R-11 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-13 | proposed-separable | W12; R-13 positive observation held | W13; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-14 | proposed-separable | W12; R-14 positive observation held | W14; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-15 | proposed-separable | W12; R-15 positive observation held | W15; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-16 | proposed-separable | W12; R-16 positive observation held | W16; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-17 | proposed-separable | W12; R-17 positive observation held | W17; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-18 | proposed-separable | W12; R-18 positive observation held | W18; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-19 | proposed-separable | W12; R-19 positive observation held | W19; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-20 | proposed-separable | W12; R-20 positive observation held | W20; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-21 | proposed-separable | W12; R-21 positive observation held | W21; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-22 | proposed-separable | W12; R-22 positive observation held | W22; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-23 | proposed-separable | W12; R-23 positive observation held | W23; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-24 | proposed-separable | W12; R-24 positive observation held | W24; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-25 | proposed-separable | W12; R-25 positive observation held | W25; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-26 | proposed-separable | W12; R-26 positive observation held | W26; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-27 | proposed-separable | W12; R-27 positive observation held | W27; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-28 | proposed-separable | W12; R-28 positive observation held | W28; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-29 | proposed-separable | W12; R-29 positive observation held | W29; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-30 | proposed-separable | W12; R-30 positive observation held | W30; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-31 | proposed-separable | W12; R-31 positive observation held | W31; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-32 | proposed-separable | W12; R-32 positive observation held | W32; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-33 | proposed-separable | W12; R-33 positive observation held | W33; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-34 | proposed-separable | W12; R-34 positive observation held | W34; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-35 | proposed-separable | W12; R-35 positive observation held | W35; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-36 | proposed-separable | W12; R-36 positive observation held | W36; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-37 | proposed-separable | W12; R-37 positive observation held | W37; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-38 | proposed-separable | W12; R-38 positive observation held | W38; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-39 | proposed-separable | W12; R-39 positive observation held | W39; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-40 | proposed-separable | W12; R-40 positive observation held | W40; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-41 | proposed-separable | W12; R-41 positive observation held | W41; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-42 | proposed-separable | W12; R-42 positive observation held | W42; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-43 | proposed-separable | W12; R-43 positive observation held | W43; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-44 | proposed-separable | W12; R-44 positive observation held | W44; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-45 | proposed-separable | W12; R-45 positive observation held | W45; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-46 | proposed-separable | W12; R-46 positive observation held | W46; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-47 | proposed-separable | W12; R-47 positive observation held | W47; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-48 | proposed-separable | W12; R-48 positive observation held | W48; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-49 | proposed-separable | W12; R-49 positive observation held | W49; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-12/R-50 | proposed-separable | W12; R-50 positive observation held | W50; R-12 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-14 | proposed-separable | W13; R-14 positive observation held | W14; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-15 | proposed-separable | W13; R-15 positive observation held | W15; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-16 | proposed-separable | W13; R-16 positive observation held | W16; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-17 | proposed-separable | W13; R-17 positive observation held | W17; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-18 | proposed-separable | W13; R-18 positive observation held | W18; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-19 | proposed-separable | W13; R-19 positive observation held | W19; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-20 | proposed-separable | W13; R-20 positive observation held | W20; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-21 | proposed-separable | W13; R-21 positive observation held | W21; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-22 | proposed-separable | W13; R-22 positive observation held | W22; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-23 | proposed-separable | W13; R-23 positive observation held | W23; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-24 | proposed-separable | W13; R-24 positive observation held | W24; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-25 | proposed-separable | W13; R-25 positive observation held | W25; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-26 | proposed-separable | W13; R-26 positive observation held | W26; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-27 | proposed-separable | W13; R-27 positive observation held | W27; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-28 | proposed-separable | W13; R-28 positive observation held | W28; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-29 | proposed-separable | W13; R-29 positive observation held | W29; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-30 | proposed-separable | W13; R-30 positive observation held | W30; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-31 | proposed-separable | W13; R-31 positive observation held | W31; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-32 | proposed-separable | W13; R-32 positive observation held | W32; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-33 | proposed-separable | W13; R-33 positive observation held | W33; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-34 | proposed-separable | W13; R-34 positive observation held | W34; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-35 | proposed-separable | W13; R-35 positive observation held | W35; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-36 | proposed-separable | W13; R-36 positive observation held | W36; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-37 | proposed-separable | W13; R-37 positive observation held | W37; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-38 | proposed-separable | W13; R-38 positive observation held | W38; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-39 | proposed-separable | W13; R-39 positive observation held | W39; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-40 | proposed-separable | W13; R-40 positive observation held | W40; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-41 | proposed-separable | W13; R-41 positive observation held | W41; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-42 | proposed-separable | W13; R-42 positive observation held | W42; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-43 | proposed-separable | W13; R-43 positive observation held | W43; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-44 | proposed-separable | W13; R-44 positive observation held | W44; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-45 | proposed-separable | W13; R-45 positive observation held | W45; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-46 | proposed-separable | W13; R-46 positive observation held | W46; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-47 | proposed-separable | W13; R-47 positive observation held | W47; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-48 | proposed-separable | W13; R-48 positive observation held | W48; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-49 | proposed-separable | W13; R-49 positive observation held | W49; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-13/R-50 | proposed-separable | W13; R-50 positive observation held | W50; R-13 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-15 | proposed-separable | W14; R-15 positive observation held | W15; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-16 | proposed-separable | W14; R-16 positive observation held | W16; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-17 | proposed-separable | W14; R-17 positive observation held | W17; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-18 | proposed-separable | W14; R-18 positive observation held | W18; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-19 | proposed-separable | W14; R-19 positive observation held | W19; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-20 | proposed-separable | W14; R-20 positive observation held | W20; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-21 | proposed-separable | W14; R-21 positive observation held | W21; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-22 | proposed-separable | W14; R-22 positive observation held | W22; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-23 | proposed-separable | W14; R-23 positive observation held | W23; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-24 | proposed-separable | W14; R-24 positive observation held | W24; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-25 | proposed-separable | W14; R-25 positive observation held | W25; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-26 | proposed-separable | W14; R-26 positive observation held | W26; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-27 | proposed-separable | W14; R-27 positive observation held | W27; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-28 | proposed-separable | W14; R-28 positive observation held | W28; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-29 | proposed-separable | W14; R-29 positive observation held | W29; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-30 | proposed-separable | W14; R-30 positive observation held | W30; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-31 | proposed-separable | W14; R-31 positive observation held | W31; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-32 | proposed-separable | W14; R-32 positive observation held | W32; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-33 | proposed-separable | W14; R-33 positive observation held | W33; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-34 | proposed-separable | W14; R-34 positive observation held | W34; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-35 | proposed-separable | W14; R-35 positive observation held | W35; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-36 | proposed-separable | W14; R-36 positive observation held | W36; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-37 | proposed-separable | W14; R-37 positive observation held | W37; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-38 | proposed-separable | W14; R-38 positive observation held | W38; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-39 | proposed-separable | W14; R-39 positive observation held | W39; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-40 | proposed-separable | W14; R-40 positive observation held | W40; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-41 | proposed-separable | W14; R-41 positive observation held | W41; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-42 | proposed-separable | W14; R-42 positive observation held | W42; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-43 | proposed-separable | W14; R-43 positive observation held | W43; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-44 | proposed-separable | W14; R-44 positive observation held | W44; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-45 | proposed-separable | W14; R-45 positive observation held | W45; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-46 | proposed-separable | W14; R-46 positive observation held | W46; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-47 | proposed-separable | W14; R-47 positive observation held | W47; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-48 | proposed-separable | W14; R-48 positive observation held | W48; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-49 | proposed-separable | W14; R-49 positive observation held | W49; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-14/R-50 | proposed-separable | W14; R-50 positive observation held | W50; R-14 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-16 | proposed-separable | W15; R-16 positive observation held | W16; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-17 | proposed-separable | W15; R-17 positive observation held | W17; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-18 | proposed-separable | W15; R-18 positive observation held | W18; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-19 | proposed-separable | W15; R-19 positive observation held | W19; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-20 | proposed-separable | W15; R-20 positive observation held | W20; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-21 | proposed-separable | W15; R-21 positive observation held | W21; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-22 | proposed-separable | W15; R-22 positive observation held | W22; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-23 | proposed-separable | W15; R-23 positive observation held | W23; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-24 | proposed-separable | W15; R-24 positive observation held | W24; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-25 | proposed-separable | W15; R-25 positive observation held | W25; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-26 | proposed-separable | W15; R-26 positive observation held | W26; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-27 | proposed-separable | W15; R-27 positive observation held | W27; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-28 | proposed-separable | W15; R-28 positive observation held | W28; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-29 | proposed-separable | W15; R-29 positive observation held | W29; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-30 | proposed-separable | W15; R-30 positive observation held | W30; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-31 | proposed-separable | W15; R-31 positive observation held | W31; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-32 | proposed-separable | W15; R-32 positive observation held | W32; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-33 | proposed-separable | W15; R-33 positive observation held | W33; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-34 | proposed-separable | W15; R-34 positive observation held | W34; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-35 | proposed-separable | W15; R-35 positive observation held | W35; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-36 | proposed-separable | W15; R-36 positive observation held | W36; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-37 | proposed-separable | W15; R-37 positive observation held | W37; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-38 | proposed-separable | W15; R-38 positive observation held | W38; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-39 | proposed-separable | W15; R-39 positive observation held | W39; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-40 | proposed-separable | W15; R-40 positive observation held | W40; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-41 | proposed-separable | W15; R-41 positive observation held | W41; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-42 | proposed-separable | W15; R-42 positive observation held | W42; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-43 | proposed-separable | W15; R-43 positive observation held | W43; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-44 | proposed-separable | W15; R-44 positive observation held | W44; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-45 | proposed-separable | W15; R-45 positive observation held | W45; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-46 | proposed-separable | W15; R-46 positive observation held | W46; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-47 | proposed-separable | W15; R-47 positive observation held | W47; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-48 | proposed-separable | W15; R-48 positive observation held | W48; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-49 | proposed-separable | W15; R-49 positive observation held | W49; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-15/R-50 | proposed-separable | W15; R-50 positive observation held | W50; R-15 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-17 | proposed-separable | W16; R-17 positive observation held | W17; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-18 | proposed-separable | W16; R-18 positive observation held | W18; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-19 | proposed-separable | W16; R-19 positive observation held | W19; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-20 | proposed-separable | W16; R-20 positive observation held | W20; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-21 | proposed-separable | W16; R-21 positive observation held | W21; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-22 | proposed-separable | W16; R-22 positive observation held | W22; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-23 | proposed-separable | W16; R-23 positive observation held | W23; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-24 | proposed-separable | W16; R-24 positive observation held | W24; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-25 | proposed-separable | W16; R-25 positive observation held | W25; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-26 | proposed-separable | W16; R-26 positive observation held | W26; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-27 | proposed-separable | W16; R-27 positive observation held | W27; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-28 | proposed-separable | W16; R-28 positive observation held | W28; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-29 | proposed-separable | W16; R-29 positive observation held | W29; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-30 | proposed-separable | W16; R-30 positive observation held | W30; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-31 | proposed-separable | W16; R-31 positive observation held | W31; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-32 | proposed-separable | W16; R-32 positive observation held | W32; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-33 | proposed-separable | W16; R-33 positive observation held | W33; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-34 | proposed-separable | W16; R-34 positive observation held | W34; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-35 | proposed-separable | W16; R-35 positive observation held | W35; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-36 | proposed-separable | W16; R-36 positive observation held | W36; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-37 | proposed-separable | W16; R-37 positive observation held | W37; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-38 | proposed-separable | W16; R-38 positive observation held | W38; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-39 | proposed-separable | W16; R-39 positive observation held | W39; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-40 | proposed-separable | W16; R-40 positive observation held | W40; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-41 | proposed-separable | W16; R-41 positive observation held | W41; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-42 | proposed-separable | W16; R-42 positive observation held | W42; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-43 | proposed-separable | W16; R-43 positive observation held | W43; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-44 | proposed-separable | W16; R-44 positive observation held | W44; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-45 | proposed-separable | W16; R-45 positive observation held | W45; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-46 | proposed-separable | W16; R-46 positive observation held | W46; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-47 | proposed-separable | W16; R-47 positive observation held | W47; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-48 | proposed-separable | W16; R-48 positive observation held | W48; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-49 | proposed-separable | W16; R-49 positive observation held | W49; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-16/R-50 | proposed-separable | W16; R-50 positive observation held | W50; R-16 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-18 | proposed-separable | W17; R-18 positive observation held | W18; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-19 | proposed-separable | W17; R-19 positive observation held | W19; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-20 | proposed-separable | W17; R-20 positive observation held | W20; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-21 | proposed-separable | W17; R-21 positive observation held | W21; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-22 | proposed-separable | W17; R-22 positive observation held | W22; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-23 | proposed-separable | W17; R-23 positive observation held | W23; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-24 | proposed-separable | W17; R-24 positive observation held | W24; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-25 | proposed-separable | W17; R-25 positive observation held | W25; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-26 | proposed-separable | W17; R-26 positive observation held | W26; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-27 | proposed-separable | W17; R-27 positive observation held | W27; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-28 | proposed-separable | W17; R-28 positive observation held | W28; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-29 | proposed-separable | W17; R-29 positive observation held | W29; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-30 | proposed-separable | W17; R-30 positive observation held | W30; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-31 | proposed-separable | W17; R-31 positive observation held | W31; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-32 | proposed-separable | W17; R-32 positive observation held | W32; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-33 | proposed-separable | W17; R-33 positive observation held | W33; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-34 | proposed-separable | W17; R-34 positive observation held | W34; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-35 | proposed-separable | W17; R-35 positive observation held | W35; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-36 | proposed-separable | W17; R-36 positive observation held | W36; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-37 | proposed-separable | W17; R-37 positive observation held | W37; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-38 | proposed-separable | W17; R-38 positive observation held | W38; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-39 | proposed-separable | W17; R-39 positive observation held | W39; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-40 | proposed-separable | W17; R-40 positive observation held | W40; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-41 | proposed-separable | W17; R-41 positive observation held | W41; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-42 | proposed-separable | W17; R-42 positive observation held | W42; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-43 | proposed-separable | W17; R-43 positive observation held | W43; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-44 | proposed-separable | W17; R-44 positive observation held | W44; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-45 | proposed-separable | W17; R-45 positive observation held | W45; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-46 | proposed-separable | W17; R-46 positive observation held | W46; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-47 | proposed-separable | W17; R-47 positive observation held | W47; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-48 | proposed-separable | W17; R-48 positive observation held | W48; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-49 | proposed-separable | W17; R-49 positive observation held | W49; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-17/R-50 | proposed-separable | W17; R-50 positive observation held | W50; R-17 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-19 | proposed-separable | W18; R-19 positive observation held | W19; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-20 | proposed-separable | W18; R-20 positive observation held | W20; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-21 | proposed-separable | W18; R-21 positive observation held | W21; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-22 | proposed-separable | W18; R-22 positive observation held | W22; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-23 | proposed-separable | W18; R-23 positive observation held | W23; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-24 | proposed-separable | W18; R-24 positive observation held | W24; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-25 | proposed-separable | W18; R-25 positive observation held | W25; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-26 | proposed-separable | W18; R-26 positive observation held | W26; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-27 | proposed-separable | W18; R-27 positive observation held | W27; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-28 | proposed-separable | W18; R-28 positive observation held | W28; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-29 | proposed-separable | W18; R-29 positive observation held | W29; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-30 | proposed-separable | W18; R-30 positive observation held | W30; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-31 | proposed-separable | W18; R-31 positive observation held | W31; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-32 | proposed-separable | W18; R-32 positive observation held | W32; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-33 | proposed-separable | W18; R-33 positive observation held | W33; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-34 | proposed-separable | W18; R-34 positive observation held | W34; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-35 | proposed-separable | W18; R-35 positive observation held | W35; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-36 | proposed-separable | W18; R-36 positive observation held | W36; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-37 | proposed-separable | W18; R-37 positive observation held | W37; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-38 | proposed-separable | W18; R-38 positive observation held | W38; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-39 | proposed-separable | W18; R-39 positive observation held | W39; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-40 | proposed-separable | W18; R-40 positive observation held | W40; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-41 | proposed-separable | W18; R-41 positive observation held | W41; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-42 | proposed-separable | W18; R-42 positive observation held | W42; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-43 | proposed-separable | W18; R-43 positive observation held | W43; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-44 | proposed-separable | W18; R-44 positive observation held | W44; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-45 | proposed-separable | W18; R-45 positive observation held | W45; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-46 | proposed-separable | W18; R-46 positive observation held | W46; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-47 | proposed-separable | W18; R-47 positive observation held | W47; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-48 | proposed-separable | W18; R-48 positive observation held | W48; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-49 | proposed-separable | W18; R-49 positive observation held | W49; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-18/R-50 | proposed-separable | W18; R-50 positive observation held | W50; R-18 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-20 | proposed-separable | W19; R-20 positive observation held | W20; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-21 | proposed-separable | W19; R-21 positive observation held | W21; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-22 | proposed-separable | W19; R-22 positive observation held | W22; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-23 | proposed-separable | W19; R-23 positive observation held | W23; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-24 | proposed-separable | W19; R-24 positive observation held | W24; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-25 | proposed-separable | W19; R-25 positive observation held | W25; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-26 | proposed-separable | W19; R-26 positive observation held | W26; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-27 | proposed-separable | W19; R-27 positive observation held | W27; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-28 | proposed-separable | W19; R-28 positive observation held | W28; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-29 | proposed-separable | W19; R-29 positive observation held | W29; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-30 | proposed-separable | W19; R-30 positive observation held | W30; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-31 | proposed-separable | W19; R-31 positive observation held | W31; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-32 | proposed-separable | W19; R-32 positive observation held | W32; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-33 | proposed-separable | W19; R-33 positive observation held | W33; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-34 | proposed-separable | W19; R-34 positive observation held | W34; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-35 | proposed-separable | W19; R-35 positive observation held | W35; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-36 | proposed-separable | W19; R-36 positive observation held | W36; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-37 | proposed-separable | W19; R-37 positive observation held | W37; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-38 | proposed-separable | W19; R-38 positive observation held | W38; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-39 | proposed-separable | W19; R-39 positive observation held | W39; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-40 | proposed-separable | W19; R-40 positive observation held | W40; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-41 | proposed-separable | W19; R-41 positive observation held | W41; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-42 | proposed-separable | W19; R-42 positive observation held | W42; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-43 | proposed-separable | W19; R-43 positive observation held | W43; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-44 | proposed-separable | W19; R-44 positive observation held | W44; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-45 | proposed-separable | W19; R-45 positive observation held | W45; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-46 | proposed-separable | W19; R-46 positive observation held | W46; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-47 | proposed-separable | W19; R-47 positive observation held | W47; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-48 | proposed-separable | W19; R-48 positive observation held | W48; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-49 | proposed-separable | W19; R-49 positive observation held | W49; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-19/R-50 | proposed-separable | W19; R-50 positive observation held | W50; R-19 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-21 | proposed-separable | W20; R-21 positive observation held | W21; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-22 | proposed-separable | W20; R-22 positive observation held | W22; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-23 | proposed-separable | W20; R-23 positive observation held | W23; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-24 | proposed-separable | W20; R-24 positive observation held | W24; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-25 | proposed-separable | W20; R-25 positive observation held | W25; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-26 | proposed-separable | W20; R-26 positive observation held | W26; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-27 | proposed-separable | W20; R-27 positive observation held | W27; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-28 | proposed-separable | W20; R-28 positive observation held | W28; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-29 | proposed-separable | W20; R-29 positive observation held | W29; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-30 | proposed-separable | W20; R-30 positive observation held | W30; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-31 | proposed-separable | W20; R-31 positive observation held | W31; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-32 | proposed-separable | W20; R-32 positive observation held | W32; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-33 | proposed-separable | W20; R-33 positive observation held | W33; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-34 | proposed-separable | W20; R-34 positive observation held | W34; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-35 | proposed-separable | W20; R-35 positive observation held | W35; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-36 | proposed-separable | W20; R-36 positive observation held | W36; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-37 | proposed-separable | W20; R-37 positive observation held | W37; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-38 | proposed-separable | W20; R-38 positive observation held | W38; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-39 | proposed-separable | W20; R-39 positive observation held | W39; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-40 | proposed-separable | W20; R-40 positive observation held | W40; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-41 | proposed-separable | W20; R-41 positive observation held | W41; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-42 | proposed-separable | W20; R-42 positive observation held | W42; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-43 | proposed-separable | W20; R-43 positive observation held | W43; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-44 | proposed-separable | W20; R-44 positive observation held | W44; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-45 | proposed-separable | W20; R-45 positive observation held | W45; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-46 | proposed-separable | W20; R-46 positive observation held | W46; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-47 | proposed-separable | W20; R-47 positive observation held | W47; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-48 | proposed-separable | W20; R-48 positive observation held | W48; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-49 | proposed-separable | W20; R-49 positive observation held | W49; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-20/R-50 | proposed-separable | W20; R-50 positive observation held | W50; R-20 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-22 | proposed-separable | W21; R-22 positive observation held | W22; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-23 | proposed-separable | W21; R-23 positive observation held | W23; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-24 | proposed-separable | W21; R-24 positive observation held | W24; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-25 | proposed-separable | W21; R-25 positive observation held | W25; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-26 | proposed-separable | W21; R-26 positive observation held | W26; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-27 | proposed-separable | W21; R-27 positive observation held | W27; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-28 | proposed-separable | W21; R-28 positive observation held | W28; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-29 | proposed-separable | W21; R-29 positive observation held | W29; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-30 | proposed-separable | W21; R-30 positive observation held | W30; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-31 | proposed-separable | W21; R-31 positive observation held | W31; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-32 | proposed-separable | W21; R-32 positive observation held | W32; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-33 | proposed-separable | W21; R-33 positive observation held | W33; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-34 | proposed-separable | W21; R-34 positive observation held | W34; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-35 | proposed-separable | W21; R-35 positive observation held | W35; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-36 | proposed-separable | W21; R-36 positive observation held | W36; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-37 | proposed-separable | W21; R-37 positive observation held | W37; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-38 | proposed-separable | W21; R-38 positive observation held | W38; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-39 | proposed-separable | W21; R-39 positive observation held | W39; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-40 | proposed-separable | W21; R-40 positive observation held | W40; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-41 | proposed-separable | W21; R-41 positive observation held | W41; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-42 | proposed-separable | W21; R-42 positive observation held | W42; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-43 | proposed-separable | W21; R-43 positive observation held | W43; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-44 | proposed-separable | W21; R-44 positive observation held | W44; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-45 | proposed-separable | W21; R-45 positive observation held | W45; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-46 | proposed-separable | W21; R-46 positive observation held | W46; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-47 | proposed-separable | W21; R-47 positive observation held | W47; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-48 | proposed-separable | W21; R-48 positive observation held | W48; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-49 | proposed-separable | W21; R-49 positive observation held | W49; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-21/R-50 | proposed-separable | W21; R-50 positive observation held | W50; R-21 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-23 | proposed-separable | W22; R-23 positive observation held | W23; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-24 | proposed-separable | W22; R-24 positive observation held | W24; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-25 | proposed-separable | W22; R-25 positive observation held | W25; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-26 | proposed-separable | W22; R-26 positive observation held | W26; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-27 | proposed-separable | W22; R-27 positive observation held | W27; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-28 | proposed-separable | W22; R-28 positive observation held | W28; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-29 | proposed-separable | W22; R-29 positive observation held | W29; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-30 | proposed-separable | W22; R-30 positive observation held | W30; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-31 | proposed-separable | W22; R-31 positive observation held | W31; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-32 | proposed-separable | W22; R-32 positive observation held | W32; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-33 | proposed-separable | W22; R-33 positive observation held | W33; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-34 | proposed-separable | W22; R-34 positive observation held | W34; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-35 | proposed-separable | W22; R-35 positive observation held | W35; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-36 | proposed-separable | W22; R-36 positive observation held | W36; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-37 | proposed-separable | W22; R-37 positive observation held | W37; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-38 | proposed-separable | W22; R-38 positive observation held | W38; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-39 | proposed-separable | W22; R-39 positive observation held | W39; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-40 | proposed-separable | W22; R-40 positive observation held | W40; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-41 | proposed-separable | W22; R-41 positive observation held | W41; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-42 | proposed-separable | W22; R-42 positive observation held | W42; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-43 | proposed-separable | W22; R-43 positive observation held | W43; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-44 | proposed-separable | W22; R-44 positive observation held | W44; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-45 | proposed-separable | W22; R-45 positive observation held | W45; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-46 | proposed-separable | W22; R-46 positive observation held | W46; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-47 | proposed-separable | W22; R-47 positive observation held | W47; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-48 | proposed-separable | W22; R-48 positive observation held | W48; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-49 | proposed-separable | W22; R-49 positive observation held | W49; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-22/R-50 | proposed-separable | W22; R-50 positive observation held | W50; R-22 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-24 | proposed-separable | W23; R-24 positive observation held | W24; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-25 | proposed-separable | W23; R-25 positive observation held | W25; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-26 | proposed-separable | W23; R-26 positive observation held | W26; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-27 | proposed-separable | W23; R-27 positive observation held | W27; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-28 | proposed-separable | W23; R-28 positive observation held | W28; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-29 | proposed-separable | W23; R-29 positive observation held | W29; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-30 | proposed-separable | W23; R-30 positive observation held | W30; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-31 | proposed-separable | W23; R-31 positive observation held | W31; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-32 | proposed-separable | W23; R-32 positive observation held | W32; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-33 | proposed-separable | W23; R-33 positive observation held | W33; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-34 | proposed-separable | W23; R-34 positive observation held | W34; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-35 | proposed-separable | W23; R-35 positive observation held | W35; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-36 | proposed-separable | W23; R-36 positive observation held | W36; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-37 | proposed-separable | W23; R-37 positive observation held | W37; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-38 | proposed-separable | W23; R-38 positive observation held | W38; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-39 | proposed-separable | W23; R-39 positive observation held | W39; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-40 | proposed-separable | W23; R-40 positive observation held | W40; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-41 | proposed-separable | W23; R-41 positive observation held | W41; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-42 | proposed-separable | W23; R-42 positive observation held | W42; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-43 | proposed-separable | W23; R-43 positive observation held | W43; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-44 | proposed-separable | W23; R-44 positive observation held | W44; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-45 | proposed-separable | W23; R-45 positive observation held | W45; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-46 | proposed-separable | W23; R-46 positive observation held | W46; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-47 | proposed-separable | W23; R-47 positive observation held | W47; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-48 | proposed-separable | W23; R-48 positive observation held | W48; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-49 | proposed-separable | W23; R-49 positive observation held | W49; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-23/R-50 | proposed-separable | W23; R-50 positive observation held | W50; R-23 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-25 | proposed-separable | W24; R-25 positive observation held | W25; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-26 | proposed-separable | W24; R-26 positive observation held | W26; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-27 | proposed-separable | W24; R-27 positive observation held | W27; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-28 | proposed-separable | W24; R-28 positive observation held | W28; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-29 | proposed-separable | W24; R-29 positive observation held | W29; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-30 | proposed-separable | W24; R-30 positive observation held | W30; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-31 | proposed-separable | W24; R-31 positive observation held | W31; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-32 | proposed-separable | W24; R-32 positive observation held | W32; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-33 | proposed-separable | W24; R-33 positive observation held | W33; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-34 | proposed-separable | W24; R-34 positive observation held | W34; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-35 | proposed-separable | W24; R-35 positive observation held | W35; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-36 | proposed-separable | W24; R-36 positive observation held | W36; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-37 | proposed-separable | W24; R-37 positive observation held | W37; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-38 | proposed-separable | W24; R-38 positive observation held | W38; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-39 | proposed-separable | W24; R-39 positive observation held | W39; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-40 | proposed-separable | W24; R-40 positive observation held | W40; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-41 | proposed-separable | W24; R-41 positive observation held | W41; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-42 | proposed-separable | W24; R-42 positive observation held | W42; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-43 | proposed-separable | W24; R-43 positive observation held | W43; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-44 | proposed-separable | W24; R-44 positive observation held | W44; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-45 | proposed-separable | W24; R-45 positive observation held | W45; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-46 | proposed-separable | W24; R-46 positive observation held | W46; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-47 | proposed-separable | W24; R-47 positive observation held | W47; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-48 | proposed-separable | W24; R-48 positive observation held | W48; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-49 | proposed-separable | W24; R-49 positive observation held | W49; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-24/R-50 | proposed-separable | W24; R-50 positive observation held | W50; R-24 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-26 | proposed-separable | W25; R-26 positive observation held | W26; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-27 | proposed-separable | W25; R-27 positive observation held | W27; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-28 | proposed-separable | W25; R-28 positive observation held | W28; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-29 | proposed-separable | W25; R-29 positive observation held | W29; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-30 | proposed-separable | W25; R-30 positive observation held | W30; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-31 | proposed-separable | W25; R-31 positive observation held | W31; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-32 | proposed-separable | W25; R-32 positive observation held | W32; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-33 | proposed-separable | W25; R-33 positive observation held | W33; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-34 | proposed-separable | W25; R-34 positive observation held | W34; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-35 | proposed-separable | W25; R-35 positive observation held | W35; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-36 | proposed-separable | W25; R-36 positive observation held | W36; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-37 | proposed-separable | W25; R-37 positive observation held | W37; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-38 | proposed-separable | W25; R-38 positive observation held | W38; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-39 | proposed-separable | W25; R-39 positive observation held | W39; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-40 | proposed-separable | W25; R-40 positive observation held | W40; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-41 | proposed-separable | W25; R-41 positive observation held | W41; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-42 | proposed-separable | W25; R-42 positive observation held | W42; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-43 | proposed-separable | W25; R-43 positive observation held | W43; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-44 | proposed-separable | W25; R-44 positive observation held | W44; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-45 | proposed-separable | W25; R-45 positive observation held | W45; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-46 | proposed-separable | W25; R-46 positive observation held | W46; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-47 | proposed-separable | W25; R-47 positive observation held | W47; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-48 | proposed-separable | W25; R-48 positive observation held | W48; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-25/R-49 | stream/revocation-overlap | W25; R-49 positive observation held | W49; R-25 positive observation held | An unclosed existing stream is read access after revoke and may fail both. A post-revoke end bypass can fail R49 with all streams closed. For R25-only distinction use additional-stream scope absent from the observed phone controls; universal contract overlap remains a finding. |
| R-25/R-50 | proposed-separable | W25; R-50 positive observation held | W50; R-25 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-27 | proposed-separable | W26; R-27 positive observation held | W27; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-28 | proposed-separable | W26; R-28 positive observation held | W28; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-29 | proposed-separable | W26; R-29 positive observation held | W29; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-30 | proposed-separable | W26; R-30 positive observation held | W30; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-31 | proposed-separable | W26; R-31 positive observation held | W31; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-32 | proposed-separable | W26; R-32 positive observation held | W32; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-33 | proposed-separable | W26; R-33 positive observation held | W33; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-34 | proposed-separable | W26; R-34 positive observation held | W34; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-35 | proposed-separable | W26; R-35 positive observation held | W35; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-36 | proposed-separable | W26; R-36 positive observation held | W36; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-37 | proposed-separable | W26; R-37 positive observation held | W37; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-38 | proposed-separable | W26; R-38 positive observation held | W38; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-39 | proposed-separable | W26; R-39 positive observation held | W39; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-40 | proposed-separable | W26; R-40 positive observation held | W40; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-41 | proposed-separable | W26; R-41 positive observation held | W41; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-42 | proposed-separable | W26; R-42 positive observation held | W42; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-43 | proposed-separable | W26; R-43 positive observation held | W43; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-44 | proposed-separable | W26; R-44 positive observation held | W44; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-45 | proposed-separable | W26; R-45 positive observation held | W45; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-46 | response/display-dependency | W26; R-46 positive observation held | W46; R-26 positive observation held | W46 stale UI with correct response proves R46-only failure. Oracle-mismatched response W26 may also defeat the method's phone/desktop comparison, so do not declare the propagation/display populations disjoint. |
| R-26/R-47 | proposed-separable | W26; R-47 positive observation held | W47; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-48 | proposed-separable | W26; R-48 positive observation held | W48; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-49 | proposed-separable | W26; R-49 positive observation held | W49; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-26/R-50 | proposed-separable | W26; R-50 positive observation held | W50; R-26 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-28 | proposed-separable | W27; R-28 positive observation held | W28; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-29 | proposed-separable | W27; R-29 positive observation held | W29; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-30 | proposed-separable | W27; R-30 positive observation held | W30; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-31 | proposed-separable | W27; R-31 positive observation held | W31; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-32 | proposed-separable | W27; R-32 positive observation held | W32; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-33 | proposed-separable | W27; R-33 positive observation held | W33; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-34 | proposed-separable | W27; R-34 positive observation held | W34; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-35 | proposed-separable | W27; R-35 positive observation held | W35; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-36 | proposed-separable | W27; R-36 positive observation held | W36; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-37 | proposed-separable | W27; R-37 positive observation held | W37; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-38 | proposed-separable | W27; R-38 positive observation held | W38; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-39 | proposed-separable | W27; R-39 positive observation held | W39; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-40 | proposed-separable | W27; R-40 positive observation held | W40; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-41 | proposed-separable | W27; R-41 positive observation held | W41; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-42 | proposed-separable | W27; R-42 positive observation held | W42; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-43 | proposed-separable | W27; R-43 positive observation held | W43; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-44 | proposed-separable | W27; R-44 positive observation held | W44; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-45 | proposed-separable | W27; R-45 positive observation held | W45; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-46 | proposed-separable | W27; R-46 positive observation held | W46; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-47 | proposed-separable | W27; R-47 positive observation held | W47; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-48 | proposed-separable | W27; R-48 positive observation held | W48; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-49 | proposed-separable | W27; R-49 positive observation held | W49; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-27/R-50 | proposed-separable | W27; R-50 positive observation held | W50; R-27 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-29 | proposed-separable | W28; R-29 positive observation held | W29; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-30 | proposed-separable | W28; R-30 positive observation held | W30; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-31 | proposed-separable | W28; R-31 positive observation held | W31; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-32 | proposed-separable | W28; R-32 positive observation held | W32; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-33 | proposed-separable | W28; R-33 positive observation held | W33; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-34 | proposed-separable | W28; R-34 positive observation held | W34; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-35 | proposed-separable | W28; R-35 positive observation held | W35; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-36 | proposed-separable | W28; R-36 positive observation held | W36; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-37 | proposed-separable | W28; R-37 positive observation held | W37; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-38 | proposed-separable | W28; R-38 positive observation held | W38; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-39 | proposed-separable | W28; R-39 positive observation held | W39; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-40 | proposed-separable | W28; R-40 positive observation held | W40; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-41 | proposed-separable | W28; R-41 positive observation held | W41; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-42 | proposed-separable | W28; R-42 positive observation held | W42; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-43 | proposed-separable | W28; R-43 positive observation held | W43; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-44 | proposed-separable | W28; R-44 positive observation held | W44; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-45 | proposed-separable | W28; R-45 positive observation held | W45; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-46 | proposed-separable | W28; R-46 positive observation held | W46; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-47 | proposed-separable | W28; R-47 positive observation held | W47; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-48 | proposed-separable | W28; R-48 positive observation held | W48; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-49 | proposed-separable | W28; R-49 positive observation held | W49; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-28/R-50 | proposed-separable | W28; R-50 positive observation held | W50; R-28 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-30 | proposed-separable | W29; R-30 positive observation held | W30; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-31 | proposed-separable | W29; R-31 positive observation held | W31; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-32 | proposed-separable | W29; R-32 positive observation held | W32; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-33 | proposed-separable | W29; R-33 positive observation held | W33; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-34 | proposed-separable | W29; R-34 positive observation held | W34; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-35 | proposed-separable | W29; R-35 positive observation held | W35; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-36 | proposed-separable | W29; R-36 positive observation held | W36; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-37 | conditional-containment | W29; R-37 positive observation held | W37; R-29 positive observation held | R37 explicitly includes the production-push tap requirement of R29. W37 missing production arrival can fail R37 with a correct tap handler; a wrong tap on that production notification fails both. No R29-only discriminator for the SAME production-tap trial is established. Overlap finding. |
| R-29/R-38 | proposed-separable | W29; R-38 positive observation held | W38; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-39 | proposed-separable | W29; R-39 positive observation held | W39; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-40 | proposed-separable | W29; R-40 positive observation held | W40; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-41 | proposed-separable | W29; R-41 positive observation held | W41; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-42 | proposed-separable | W29; R-42 positive observation held | W42; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-43 | proposed-separable | W29; R-43 positive observation held | W43; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-44 | proposed-separable | W29; R-44 positive observation held | W44; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-45 | proposed-separable | W29; R-45 positive observation held | W45; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-46 | proposed-separable | W29; R-46 positive observation held | W46; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-47 | proposed-separable | W29; R-47 positive observation held | W47; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-48 | proposed-separable | W29; R-48 positive observation held | W48; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-49 | proposed-separable | W29; R-49 positive observation held | W49; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-29/R-50 | proposed-separable | W29; R-50 positive observation held | W50; R-29 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-31 | proposed-separable | W30; R-31 positive observation held | W31; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-32 | proposed-separable | W30; R-32 positive observation held | W32; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-33 | proposed-separable | W30; R-33 positive observation held | W33; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-34 | proposed-separable | W30; R-34 positive observation held | W34; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-35 | proposed-separable | W30; R-35 positive observation held | W35; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-36 | proposed-separable | W30; R-36 positive observation held | W36; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-37 | proposed-separable | W30; R-37 positive observation held | W37; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-38 | proposed-separable | W30; R-38 positive observation held | W38; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-39 | proposed-separable | W30; R-39 positive observation held | W39; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-40 | proposed-separable | W30; R-40 positive observation held | W40; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-41 | proposed-separable | W30; R-41 positive observation held | W41; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-42 | proposed-separable | W30; R-42 positive observation held | W42; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-43 | proposed-separable | W30; R-43 positive observation held | W43; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-44 | proposed-separable | W30; R-44 positive observation held | W44; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-45 | proposed-separable | W30; R-45 positive observation held | W45; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-46 | proposed-separable | W30; R-46 positive observation held | W46; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-47 | proposed-separable | W30; R-47 positive observation held | W47; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-48 | proposed-separable | W30; R-48 positive observation held | W48; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-49 | proposed-separable | W30; R-49 positive observation held | W49; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-30/R-50 | proposed-separable | W30; R-50 positive observation held | W50; R-30 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-32 | proposed-separable | W31; R-32 positive observation held | W32; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-33 | proposed-separable | W31; R-33 positive observation held | W33; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-34 | proposed-separable | W31; R-34 positive observation held | W34; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-35 | proposed-separable | W31; R-35 positive observation held | W35; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-36 | proposed-separable | W31; R-36 positive observation held | W36; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-37 | proposed-separable | W31; R-37 positive observation held | W37; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-38 | proposed-separable | W31; R-38 positive observation held | W38; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-39 | proposed-separable | W31; R-39 positive observation held | W39; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-40 | proposed-separable | W31; R-40 positive observation held | W40; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-41 | proposed-separable | W31; R-41 positive observation held | W41; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-42 | proposed-separable | W31; R-42 positive observation held | W42; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-43 | proposed-separable | W31; R-43 positive observation held | W43; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-44 | proposed-separable | W31; R-44 positive observation held | W44; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-45 | proposed-separable | W31; R-45 positive observation held | W45; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-46 | proposed-separable | W31; R-46 positive observation held | W46; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-47 | proposed-separable | W31; R-47 positive observation held | W47; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-48 | proposed-separable | W31; R-48 positive observation held | W48; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-49 | proposed-separable | W31; R-49 positive observation held | W49; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-31/R-50 | proposed-separable | W31; R-50 positive observation held | W50; R-31 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-33 | proposed-separable | W32; R-33 positive observation held | W33; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-34 | proposed-separable | W32; R-34 positive observation held | W34; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-35 | proposed-separable | W32; R-35 positive observation held | W35; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-36 | proposed-separable | W32; R-36 positive observation held | W36; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-37 | proposed-separable | W32; R-37 positive observation held | W37; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-38 | proposed-separable | W32; R-38 positive observation held | W38; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-39 | proposed-separable | W32; R-39 positive observation held | W39; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-40 | proposed-separable | W32; R-40 positive observation held | W40; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-41 | proposed-separable | W32; R-41 positive observation held | W41; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-42 | proposed-separable | W32; R-42 positive observation held | W42; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-43 | proposed-separable | W32; R-43 positive observation held | W43; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-44 | proposed-separable | W32; R-44 positive observation held | W44; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-45 | proposed-separable | W32; R-45 positive observation held | W45; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-46 | proposed-separable | W32; R-46 positive observation held | W46; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-47 | proposed-separable | W32; R-47 positive observation held | W47; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-48 | proposed-separable | W32; R-48 positive observation held | W48; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-49 | proposed-separable | W32; R-49 positive observation held | W49; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-32/R-50 | proposed-separable | W32; R-50 positive observation held | W50; R-32 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-34 | proposed-separable | W33; R-34 positive observation held | W34; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-35 | proposed-separable | W33; R-35 positive observation held | W35; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-36 | proposed-separable | W33; R-36 positive observation held | W36; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-37 | proposed-separable | W33; R-37 positive observation held | W37; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-38 | proposed-separable | W33; R-38 positive observation held | W38; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-39 | proposed-separable | W33; R-39 positive observation held | W39; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-40 | proposed-separable | W33; R-40 positive observation held | W40; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-41 | proposed-separable | W33; R-41 positive observation held | W41; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-42 | proposed-separable | W33; R-42 positive observation held | W42; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-43 | proposed-separable | W33; R-43 positive observation held | W43; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-44 | proposed-separable | W33; R-44 positive observation held | W44; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-45 | proposed-separable | W33; R-45 positive observation held | W45; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-46 | proposed-separable | W33; R-46 positive observation held | W46; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-47 | proposed-separable | W33; R-47 positive observation held | W47; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-48 | proposed-separable | W33; R-48 positive observation held | W48; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-49 | proposed-separable | W33; R-49 positive observation held | W49; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-33/R-50 | proposed-separable | W33; R-50 positive observation held | W50; R-33 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-35 | proposed-separable | W34; R-35 positive observation held | W35; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-36 | proposed-separable | W34; R-36 positive observation held | W36; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-37 | proposed-separable | W34; R-37 positive observation held | W37; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-38 | proposed-separable | W34; R-38 positive observation held | W38; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-39 | proposed-separable | W34; R-39 positive observation held | W39; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-40 | proposed-separable | W34; R-40 positive observation held | W40; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-41 | proposed-separable | W34; R-41 positive observation held | W41; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-42 | proposed-separable | W34; R-42 positive observation held | W42; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-43 | proposed-separable | W34; R-43 positive observation held | W43; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-44 | proposed-separable | W34; R-44 positive observation held | W44; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-45 | proposed-separable | W34; R-45 positive observation held | W45; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-46 | proposed-separable | W34; R-46 positive observation held | W46; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-47 | proposed-separable | W34; R-47 positive observation held | W47; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-48 | proposed-separable | W34; R-48 positive observation held | W48; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-49 | proposed-separable | W34; R-49 positive observation held | W49; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-34/R-50 | proposed-separable | W34; R-50 positive observation held | W50; R-34 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-36 | proposed-separable | W35; R-36 positive observation held | W36; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-37 | proposed-separable | W35; R-37 positive observation held | W37; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-38 | proposed-separable | W35; R-38 positive observation held | W38; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-39 | proposed-separable | W35; R-39 positive observation held | W39; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-40 | proposed-separable | W35; R-40 positive observation held | W40; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-41 | proposed-separable | W35; R-41 positive observation held | W41; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-42 | proposed-separable | W35; R-42 positive observation held | W42; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-43 | proposed-separable | W35; R-43 positive observation held | W43; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-44 | proposed-separable | W35; R-44 positive observation held | W44; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-45 | proposed-separable | W35; R-45 positive observation held | W45; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-46 | proposed-separable | W35; R-46 positive observation held | W46; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-47 | proposed-separable | W35; R-47 positive observation held | W47; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-48 | proposed-separable | W35; R-48 positive observation held | W48; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-49 | proposed-separable | W35; R-49 positive observation held | W49; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-35/R-50 | proposed-separable | W35; R-50 positive observation held | W50; R-35 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-37 | proposed-separable | W36; R-37 positive observation held | W37; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-38 | proposed-separable | W36; R-38 positive observation held | W38; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-39 | proposed-separable | W36; R-39 positive observation held | W39; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-40 | proposed-separable | W36; R-40 positive observation held | W40; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-41 | proposed-separable | W36; R-41 positive observation held | W41; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-42 | proposed-separable | W36; R-42 positive observation held | W42; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-43 | proposed-separable | W36; R-43 positive observation held | W43; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-44 | proposed-separable | W36; R-44 positive observation held | W44; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-45 | proposed-separable | W36; R-45 positive observation held | W45; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-46 | proposed-separable | W36; R-46 positive observation held | W46; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-47 | proposed-separable | W36; R-47 positive observation held | W47; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-48 | proposed-separable | W36; R-48 positive observation held | W48; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-49 | proposed-separable | W36; R-49 positive observation held | W49; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-36/R-50 | proposed-separable | W36; R-50 positive observation held | W50; R-36 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-38 | proposed-separable | W37; R-38 positive observation held | W38; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-39 | proposed-separable | W37; R-39 positive observation held | W39; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-40 | proposed-separable | W37; R-40 positive observation held | W40; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-41 | proposed-separable | W37; R-41 positive observation held | W41; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-42 | proposed-separable | W37; R-42 positive observation held | W42; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-43 | proposed-separable | W37; R-43 positive observation held | W43; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-44 | proposed-separable | W37; R-44 positive observation held | W44; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-45 | proposed-separable | W37; R-45 positive observation held | W45; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-46 | proposed-separable | W37; R-46 positive observation held | W46; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-47 | proposed-separable | W37; R-47 positive observation held | W47; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-48 | proposed-separable | W37; R-48 positive observation held | W48; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-49 | proposed-separable | W37; R-49 positive observation held | W49; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-37/R-50 | proposed-separable | W37; R-50 positive observation held | W50; R-37 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-39 | proposed-separable | W38; R-39 positive observation held | W39; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-40 | proposed-separable | W38; R-40 positive observation held | W40; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-41 | proposed-separable | W38; R-41 positive observation held | W41; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-42 | proposed-separable | W38; R-42 positive observation held | W42; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-43 | proposed-separable | W38; R-43 positive observation held | W43; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-44 | proposed-separable | W38; R-44 positive observation held | W44; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-45 | proposed-separable | W38; R-45 positive observation held | W45; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-46 | proposed-separable | W38; R-46 positive observation held | W46; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-47 | proposed-separable | W38; R-47 positive observation held | W47; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-48 | proposed-separable | W38; R-48 positive observation held | W48; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-49 | proposed-separable | W38; R-49 positive observation held | W49; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-38/R-50 | proposed-separable | W38; R-50 positive observation held | W50; R-38 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-40 | proposed-separable | W39; R-40 positive observation held | W40; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-41 | proposed-separable | W39; R-41 positive observation held | W41; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-42 | proposed-separable | W39; R-42 positive observation held | W42; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-43 | proposed-separable | W39; R-43 positive observation held | W43; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-44 | proposed-separable | W39; R-44 positive observation held | W44; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-45 | proposed-separable | W39; R-45 positive observation held | W45; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-46 | proposed-separable | W39; R-46 positive observation held | W46; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-47 | proposed-separable | W39; R-47 positive observation held | W47; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-48 | proposed-separable | W39; R-48 positive observation held | W48; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-49 | proposed-separable | W39; R-49 positive observation held | W49; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-39/R-50 | proposed-separable | W39; R-50 positive observation held | W50; R-39 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-41 | proposed-separable | W40; R-41 positive observation held | W41; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-42 | proposed-separable | W40; R-42 positive observation held | W42; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-43 | proposed-separable | W40; R-43 positive observation held | W43; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-44 | proposed-separable | W40; R-44 positive observation held | W44; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-45 | proposed-separable | W40; R-45 positive observation held | W45; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-46 | proposed-separable | W40; R-46 positive observation held | W46; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-47 | separable-with-alternate-witness | W40; R-47 positive observation held | W47; R-40 positive observation held | For R40-only use a correct first request whose retry changes its key (falsifier explicitly forbids key changes): original message remains persisted, satisfying R47. W47 missing persistence with correct request proves converse. Wrong-target W40 would co-fail R47. |
| R-40/R-48 | proposed-separable | W40; R-48 positive observation held | W48; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-49 | proposed-separable | W40; R-49 positive observation held | W49; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-40/R-50 | proposed-separable | W40; R-50 positive observation held | W50; R-40 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-42 | proposed-separable | W41; R-42 positive observation held | W42; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-43 | proposed-separable | W41; R-43 positive observation held | W43; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-44 | proposed-separable | W41; R-44 positive observation held | W44; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-45 | proposed-separable | W41; R-45 positive observation held | W45; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-46 | proposed-separable | W41; R-46 positive observation held | W46; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-47 | proposed-separable | W41; R-47 positive observation held | W47; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-48 | proposed-separable | W41; R-48 positive observation held | W48; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-49 | proposed-separable | W41; R-49 positive observation held | W49; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-41/R-50 | proposed-separable | W41; R-50 positive observation held | W50; R-41 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-43 | unresolved-release-scope | W42; R-43 positive observation held | W43; R-42 positive observation held | W43 unrelated prior acceptance regression preserves transcript disclosure. It is unknown whether missing new transcript disclosure necessarily violates an existing mandatory release privacy criterion; external release rubric populations were not read in this permitted scope. Do not claim an R42-only discriminator. |
| R-42/R-44 | proposed-separable | W42; R-44 positive observation held | W44; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-45 | proposed-separable | W42; R-45 positive observation held | W45; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-46 | proposed-separable | W42; R-46 positive observation held | W46; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-47 | proposed-separable | W42; R-47 positive observation held | W47; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-48 | proposed-separable | W42; R-48 positive observation held | W48; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-49 | proposed-separable | W42; R-49 positive observation held | W49; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-42/R-50 | proposed-separable | W42; R-50 positive observation held | W50; R-42 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-44 | proposed-separable | W43; R-44 positive observation held | W44; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-45 | proposed-separable | W43; R-45 positive observation held | W45; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-46 | proposed-separable | W43; R-46 positive observation held | W46; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-47 | proposed-separable | W43; R-47 positive observation held | W47; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-48 | proposed-separable | W43; R-48 positive observation held | W48; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-49 | proposed-separable | W43; R-49 positive observation held | W49; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-43/R-50 | proposed-separable | W43; R-50 positive observation held | W50; R-43 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-45 | proposed-separable | W44; R-45 positive observation held | W45; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-46 | proposed-separable | W44; R-46 positive observation held | W46; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-47 | proposed-separable | W44; R-47 positive observation held | W47; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-48 | proposed-separable | W44; R-48 positive observation held | W48; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-49 | proposed-separable | W44; R-49 positive observation held | W49; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-44/R-50 | proposed-separable | W44; R-50 positive observation held | W50; R-44 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-45/R-46 | proposed-separable | W45; R-46 positive observation held | W46; R-45 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-45/R-47 | proposed-separable | W45; R-47 positive observation held | W47; R-45 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-45/R-48 | proposed-separable | W45; R-48 positive observation held | W48; R-45 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-45/R-49 | proposed-separable | W45; R-49 positive observation held | W49; R-45 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-45/R-50 | proposed-separable | W45; R-50 positive observation held | W50; R-45 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-46/R-47 | proposed-separable | W46; R-47 positive observation held | W47; R-46 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-46/R-48 | proposed-separable | W46; R-48 positive observation held | W48; R-46 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-46/R-49 | proposed-separable | W46; R-49 positive observation held | W49; R-46 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-46/R-50 | proposed-separable | W46; R-50 positive observation held | W50; R-46 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-47/R-48 | proposed-separable | W47; R-48 positive observation held | W48; R-47 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-47/R-49 | proposed-separable | W47; R-49 positive observation held | W49; R-47 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-47/R-50 | proposed-separable | W47; R-50 positive observation held | W50; R-47 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-48/R-49 | proposed-separable | W48; R-49 positive observation held | W49; R-48 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-48/R-50 | proposed-separable | W48; R-50 positive observation held | W50; R-48 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |
| R-49/R-50 | proposed-separable | W49; R-50 positive observation held | W50; R-49 positive observation held | Distinct scoped fault constructions; no product trial or all-pass claim. |

Known non-overlap residue is material: R9/R46 share actual still-live failure; R29/R37 include a conditional tap containment; R26/R46 and R25/R49 have cross-layer coupling; R42/R43 release privacy containment is unmeasured. The completed table therefore supports an honest weak/fail or qualified judgment, not the first card's blanket pass. Do not silently merge/remove safety, UI, production push or release guarantees to repair a grade.

## Full stored per-criterion methods

These preserve every current evidence requirement and let the critic compare detector findings with the full predicate, without relying on a short title.

### R-1 — Roster population

Method: Run sessions.test.ts over a fixed fixture containing active, starting, pending, ended and workspace-agnostic sessions plus foreign-workspace controls. Walk all unfiltered bounded pages to nextCursor=null, union row identities and compare that set with the desktop reader for that snapshot. R-22 independently checks visit-once and no-gap traversal.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-2 — Transcript

Method: Run the route test with live, ended (archive) and paged fixtures, comparing device pages with the desktop stream entries for the same range, plus a request with no limit.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-3 — Send

Method: Run session-messages.test.ts and device-actions.integration.test.ts for route/real-PG dispatch and retry behavior, plus owner-sessions/actions.test.ts for the real shared sender's woken, staged, queued and absent classification and desktop/device dispatch parity. Require all four distinct outcomes with wake required.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts","packages/operator-core/lib/owner-sessions/actions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-4 — Session-route authentication and capability matrix

Method: Run sessions-auth.test.ts. Derive the canonical device session route registrations (including transcript stream mode and deviceSessions.list), assert set equality with the auth-matrix doors, then cover each door against missing/invalid/expired/revoked-device JWT, valid JWT without grant, revoked capability and valid capable positive control. Denied reads return no session data; denied sends/ends invoke no action. R-49 separately requires both-platform real-phone live proof.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-5 — Data minimisation

Method: Run the roster, transcript and push route tests with a planted-secret fixture whose tool calls carry the secret in both arguments and output, covering roster, transcript tail, archive fallback, stream, cursor page and push.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts","packages/operator-core/lib/session-push.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-6 — Platform parity through the shared core

Method: Manual mobile-CI evidence per D-006/D-012, required during P-007: cite canonical papercup-core and papercup-bindings cargo test run ids plus iOS/Android CI run ids (tools/ios-ci.py and tools/android-ci.py). Require a positive session API compile/use contract through generated UniFFI Swift and Kotlin facades: construct/round-trip the exported roster/transcript/delivery types, invoke roster/transcript/send/end client methods against request-recording fixtures, advance the exported cursor follower across initial/older/new pages, and assert woken/staged/queued/absent delivery classification. A missing/renamed API or an unused facade must fail the positive contract. Also run the existing required mechanical Swift/Kotlin session-screen guard against local transcript parsing, cursor computation or delivery classification. A negative guard or unrelated cargo pass alone cannot satisfy R-6; future fixture names/source paths and actual per-platform CI run ids must be cited, never assumed present.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-7 — Tests in the canonical frameworks

Method: Run testing:run for every check-bound suite below: five device-session route suites, session-push orchestration, device-push-dispatcher provider/fanout, and device-store.integration target eligibility. Read the per-file/case result for each exact file; each must pass with zero skipped and zero quarantined cases. A missing file/result is unknown, never a pass.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts","packages/operator-core/lib/session-push.test.ts","packages/operator-core/lib/device-push-dispatcher.test.ts","packages/operator-core/lib/device-store.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-8 — Feature included in current coordinated candidates

Method: Cite the Decision/thread post on each release plan recording its owner's agreement before candidate changes, identify both exact candidate build versions/artifacts, and confirm the session feature on each installed candidate. R-42 and R-43 separately require privacy-packet updates and preservation of prior candidate acceptance.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: deployed; requiredScope: ["deployed"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-9 — End session

Method: Run the end-route test, which asserts the route invokes the same fleet:kill action the desktop Stop agent control calls (D-008) and reads the session state afterwards.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts","packages/operator-core/lib/owner-sessions/actions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-10 — Push fanout

Method: Run session-push.test.ts, device-push-dispatcher.test.ts and device-store.integration.test.ts. The composed notifySessionOwnerMessage -> notifyWorkspace -> real dispatchPush test uses one then two capable devices across FCM/APNs provider doubles; record recipient identities and assert exactly one provider dispatch per eligible device and none missing/duplicated. Keep R-31's denied-target eligibility controls separate and R-37's production phone-arrival proof mandatory.

Binding: {"kind":"tests","files":["packages/operator-core/lib/session-push.test.ts","packages/operator-core/lib/device-push-dispatcher.test.ts","packages/operator-core/lib/device-store.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-11 — Transcript live follow

Method: Run the transcript route stream case, which appends a turn to a live fixture while a stream is open.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-12 — Send idempotency

Method: Run the send route test, which posts twice with one key from one device, once with that key from a second device, and counts delivered messages.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-13 — Send attribution

Method: Run the send route test, which reads the delivered envelope.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/actions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-14 — Send biometric unlock window

Method: In papercup-rust-mobile CI, run the canonical papercup-core send unlock-window test and iOS/Android send-unit fixtures for no unlock, expired unlock and fresh unlock. Assert no send request in the first two cases and a send request in the fresh case; cite cargo and both platform CI run ids. R-44 independently checks end. The server does not verify a client unlock per D-009.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-15 — Action audit

Method: Run the send and end route tests, which read the device actions log after each accepted request.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-16 — Biometric-gated transcript cache read

Method: In papercup-rust-mobile CI, cite the papercup-core transcript_cache_locked_and_cleared_on_unpair test's independent read-lock assertions and iOS TranscriptCacheLockTests / Android TranscriptCacheLockTest CI run ids. Require locked/unlocked positive and negative read controls on both platforms. R-45 separately owns delete-on-unpair.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-17 — Same layout on both phones

Method: In papercup-rust-mobile CI, cite the run ids and screenshots of the XCUITest SessionsNavigationUITests (tools/ios-ci.py) and the Compose UI SessionsNavigationTest (tools/android-ci.py), each walking Fleet to Sessions to detail to composer to End session.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-18 — Confirmation before phone end

Method: Require independently named confirmation/cancel/confirm assertions in XCUITest EndSessionUITests and Compose EndSessionTest; cite both mobile CI run ids. On each paired platform in P-016, show that the initial tap and cancel invoke no end action, then confirm the test session's end. R-46 owns resulting-state UI.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-19 — Workspace isolation

Method: Run the auth route test with a capable device from workspace A against sessions in workspace B on the transcript, messages and end routes.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-20 — Roster row fields

Method: Run sessions.test.ts and compare presence/value of all nine fields for every active/starting/pending/ended row against the desktop snapshot. Ended archival rows retain owner id, label, role and harness; pot, fleet, intent and heldWorkItem remain present with null values; last activity is desktop lastActiveAt ?? endedAt ?? startedAt ?? null. Exercise each fallback and present empty label/intent controls; omitted fields fail.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-21 — Roster session state

Method: Run the route test, which reads the presence oracle and the device rows from one fixture snapshot and compares the state per owner.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-22 — Roster paging

Method: Run the route test, which walks a fixture larger than three pages with the returned cursor and counts each session.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-23 — Roster filters

Method: Run sessions.test.ts with each state/fleet/pot/search filter alone and in combinations over a fixed mixed roster with multiple matching pages and excluded controls. Walk to nextCursor=null, compare the union of identities with the independent desktop-fixture predicate's complete matching set, and assert every returned row matches every supplied filter. An empty-match fixture must finish empty. R-22 owns traversal mechanics.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-24 — Roster parity on a paired phone

Method: P-016: freeze or identify a stable desktop roster snapshot, then complete roster scrolling/paging on paired iOS and Android phones. Record timestamped per-platform identity sets and counts, with screenshots/automation captures covering all pages, and compare each against the same desktop snapshot. Assert count equality, set equality and no duplicate displayed identities; counts alone are insufficient.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-25 — Revocation closes open streams

Method: Run session-transcript.test.ts with two sessions/open streams for phone-a and a third live stream for still-capable phone-b. Observe pre-revoke turns on all streams, revoke only phone-a, then assert both phone-a streams send access_revoked and EOF with no subsequent append payload. Append new native turns to prove phone-b continues. Preserve the singleton operating-stream controls and native-ledger fidelity.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-transcript.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-26 — End reports the resulting state

Method: Run the end-route test, which compares the response state with the presence oracle read after the end.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-27 — End refuses protected sessions

Method: Run session-end.test.ts against the authoritative admission predicate: recognized getKnownRoles/getRole or classified su role AND a native backend in BACKEND_FEATURE_CAPABILITIES, excluding routine/git-sync/checkpoint/human/system/bg-host identities. Table-drive catalogued agent positive controls and protected/unknown/missing/malformed role or native-handle/backend cases (including an su-looking owner id). Every non-agent case must refuse with zero endOwnerSession/fleet:kill calls; recognized positive controls reuse the desktop fleet:kill path per D-008. A newly unknown class fails closed; preserve the universal non-agent refusal guarantee.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-28 — Repeated end is safe

Method: Run the end-route test, which ends a session twice and counts end actions.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-29 — Push opens the session

Method: In papercup-rust-mobile CI, run the XCUITest PushTapOpensSessionUITests and the Compose UI PushTapOpensSessionTest (tools/ios-ci.py, tools/android-ci.py); cite both CI run ids.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-30 — Push payload minimisation

Method: Run the push-fanout unit test, which inspects every field of the delivered payload with a planted-secret message.

Binding: {"kind":"tests","files":["packages/operator-core/lib/session-push.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-31 — Push isolation

Method: Run the push-fanout unit test with a foreign-workspace device and an uncapable device in the fixture.

Binding: {"kind":"tests","files":["packages/operator-core/lib/session-push.test.ts","packages/operator-core/lib/device-push-dispatcher.test.ts","packages/operator-core/lib/device-store.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-32 — Live follow over the relay

Method: Cite the papercup-core cursor-follower test run in papercup-rust-mobile CI, plus the P-016 artifact: a paired device on the BYOC relay showing a new turn appear in an open transcript.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-33 — Send requires a key

Method: Run the send route test with a keyless send.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-34 — Key reuse conflict

Method: Run the send route test, which reuses one key with a second body and reads the status.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-35 — Phone sends are not owner directives

Method: Run the bound real phone provenance bridge in agent-tools/coordination/tools/send.test.ts: paired-device action -> real coord:send handler -> stored payload/body -> actual wake text tagging and persisted/live provenance classifiers -> insertTurns. Cover Claude/Codex/OMP and a forged embedded owner envelope. Assert agent-injected/wake-pump persistence, exclusion from owner-speech candidates and inability to enter the owner-directive hook branch. Also run the route/action suites for the paired-device envelope; label-only assertions cannot satisfy this BAR.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/owner-sessions/actions.test.ts","packages/operator-core/lib/agent-tools/coordination/tools/send.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-36 — Refusal audit

Method: Run the bound send/end/auth/real-PG suites with the complete D-017 partition. Valid device JWT plus missing grant, revoked capability, invalid request, foreign/ended/protected target, idempotency conflict or action refusal yields exactly one device-action row naming the authenticated device, target, action and refusal reason. Missing, invalid, expired or revoked-device JWT yields zero device-action rows. Distinguish revoked capability under valid JWT from revoked-device authentication. R-4 owns JWT refusal; no extra row is allowed for retries.

Binding: {"kind":"tests","files":["packages/operator-core/lib/endpoint-route/routes/device/session-messages.test.ts","packages/operator-core/lib/endpoint-route/routes/device/session-end.test.ts","packages/operator-core/lib/endpoint-route/routes/device/sessions-auth.test.ts","packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts"]}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: ["unit"]; mandatory: true; passRatings: ["healthy"].

### R-37 — Push reaches a paired phone

Method: P-016 artifact: with a paired iOS device and a paired Android device each locked and the app in the background, have a test agent coord:send to the owner. Per device, record a timestamped screenshot or screen recording showing the notification delivered through the production APNs or FCM pipeline (no simulated or test-injected notification), then the tap landing on that agent's session detail screen.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-38 — Phone send wakes a parked agent

Method: P-016: on paired iOS and Android, send to a parked test agent and record timestamped phone send evidence plus the desktop session/presence transition from parked to live for that exact agent. R-47 independently verifies transcript recording.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-39 — Revoked device on the phone

Method: In papercup-rust-mobile CI, run the XCUITest RevokedDeviceUITests and the Compose UI RevokedDeviceTest (tools/ios-ci.py, tools/android-ci.py), each revoking the capability on a stubbed server while the roster and a session detail screen are open; cite both CI run ids.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-40 — Phone composer request correctness

Method: In papercup-rust-mobile CI run XCUITest ComposerSendUITests and Compose ComposerSendTest with a recording server. Require separately named per-platform assertions for exact unchanged text, selected owner/session target and a nonempty per-action idempotency key retained on retry. Cite both CI run ids and recorded request fields; R-48 independently measures POST cardinality.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-41 — Live follow on a direct connection

Method: P-016 artifact: a paired iOS device and a paired Android device each connected directly to the desktop (not through the relay), each recording a new turn appearing in an open transcript, with the connection type shown or logged.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-42 — Candidate privacy packets

Method: For both current release plans, cite the privacy-packet diffs and release-owner review against the actual candidate feature/data handling; identify the exact App Store and Play packet versions. Require the on-device transcript disclosure in both.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: deployed; requiredScope: ["deployed"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-43 — Prior candidate acceptance remains passing

Method: For iphone-public-release-2026-08-11 and android-public-release-2026-10-01 cite fresh release-rubric grades against the exact integrated candidate artifact, taken after integration and covering every prior mandatory release criterion. Missing/stale evidence is unknown; earlier grades do not satisfy this obligation.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: deployed; requiredScope: ["deployed"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-44 — End biometric unlock window

Method: In papercup-rust-mobile CI, run the core end unlock-window test plus iOS/Android end-unit fixtures for no unlock, expired unlock and fresh unlock. Assert no end request for the first two and an allowed end request for the fresh case, with confirmation handled separately by R-18. Cite cargo and both platform CI run ids.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-45 — Transcript cache deletion on unpair

Method: Cite canonical cargo transcript_cache_locked_and_cleared_on_unpair independent delete assertions and iOS TranscriptCacheLockTests / Android TranscriptCacheLockTest CI run ids. Seed safe cached turns, unpair, then re-pair/unlock and assert old cached turns remain unavailable on each platform.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-46 — Phone end resulting-state display

Method: Cite independent resulting-state assertions in XCUITest EndSessionUITests and Compose EndSessionTest for ended and unknown responses. P-016 on each paired platform: confirm a test end, record the phone state and matching desktop/oracle verdict. Refusal leaves the prior state plus error, never a fabricated ended state.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-47 — Phone-sent message recorded in transcript

Method: P-016 on paired iOS and Android: record unique safe sent text and exact target, then cite the target's stored transcript turn plus the phone/desktop transcript displaying that same message. Keep R-35 agent-origin safety and R-38 wake evidence separate.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-48 — Composer POST cardinality

Method: In the XCUITest ComposerSendUITests and Compose ComposerSendTest recording-server fixtures, independently count POSTs for one submit on each platform, including rapid/double-tap UI input. Require exactly one POST before any separately initiated transport retry; cite both CI run ids and request counts. R-12 governs idempotent retry acceptance.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: tree; requiredScope: ["tree"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-49 — Real-phone capability revocation refuses operations

Method: P-016 live evidence on paired iOS and Android, with exact builds/connection and device identities: perform successful pre-revoke read/send/end controls on disposable target sessions; revoke that phone's capability in desktop Settings; retry roster/transcript/stream read, send and end. Record refusal responses, absence of session payload, no delivered/woken message and no fleet:kill/end side effect for post-revoke actions. Cite device-action/refusal records without confusing them with action side effects. Both phones must pass independently; R-4 tree auth proof, R-25 stream termination and R-39 UI rendering cannot substitute.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].

### R-50 — Phone historical transcript and older scrolling

Method: Required canonical mobile fixtures: XCUITest SessionTranscriptHistoryUITests and Compose SessionTranscriptHistoryTest, added under the existing mobile CI suites and run through tools/ios-ci.py / tools/android-ci.py. Use active and ended archived transcripts larger than one page with uniquely identified ordered safe turns; assert initial page display, scroll through every older page, compare the complete ordered identity sequence and fail on missing/duplicate entries. Cite both platform CI run ids/test cases. P-016 also records the same history/archive/older-scroll journey on both paired phone builds; server page or new-append evidence alone cannot satisfy this BAR.

Binding: {"kind":"instrument","instrumentKey":"none"}. Plane: live; requiredScope: ["live"]; requiredTestLayers: []; mandatory: true; passRatings: ["healthy"].


## Decision bodies read (provenance tags normalized as described above)

### D-001 — Route: the authoring su session implements the plan itself (route A)

Date: 2026-10-12
[owner 2026-10-12, AskUserQuestion answer, session turn 15] Route A chosen: "You, this session". No fleet. The authoring session (su-440f5011) implements every phase directly, in plan order.

### D-002 — Send gate: one biometric unlock covers sends for a time window

Date: 2026-10-12
[owner 2026-10-12, AskUserQuestion answer, turn 15] Resolves Q1. Sending to (or ending) an agent session needs a biometric unlock within a short window, modelled on the existing workspace-switch gate (papercup-core biometric.rs, RiskLevel Medium). A prompt on every send was rejected as too much friction for conversation. The window length is an implementation constant defaulting to the existing gate's; the server also enforces the per-device Agent sessions capability.

### D-003 — v1 scope adds End session and push for agent-to-owner messages; no interrupt control

Date: 2026-10-12
[owner 2026-10-12, AskUserQuestion multi-select answer "End session, Push for agent→you", turn 15] Resolves Q2 and Q4. v1 includes: (a) End session from the phone, through the same server-side path the desktop uses, with no new kill path (R-9, P-017, P-018); (b) a push when an agent messages or asks the owner, deep-linking to that session (R-10, P-014). Interrupt/yield (turn:interrupt) was NOT selected and is out of v1.

### D-004 — Release train: ship in the current iPhone and Android release candidates

Date: 2026-10-12
[owner 2026-10-12, AskUserQuestion answer "Current candidates", turn 15] Resolves Q3. The phone feature goes into the in-flight releases (iphone-public-release-2026-08-11, android-public-release-2026-10-01), not the next version. R-8 becomes "join the candidates without breaking their acceptance". Coordinate with those release plans' owners before changing candidate builds and re-run the acceptance evidence the feature affects (P-019, P-015).

### D-005 — Acceptance BAR amendment

Date: 2026-10-12
Amendment-Id: amend-a9ddb7ea246837578afe6dd1
Request-Hash: c1a55b63e8c90f3007d1f36f0f200d3a5942d917b04505c8bf4ccd75a97c9d5e
Actor: su-440f5011-1dcd-4466-86d7-c20957d251ec
Reason: Split compound BARs R-2..R-6 and R-9 into single-behavior BARs R-11..R-19 (spec-quality atomic-observable-behavior); repaired per outside review thread-post:1176795 (JWT requirement, from-device attribution, screen+control parity, cross-workspace isolation R-19).
Approved-By: system:judge/su-f4caecee-cbe1-487c-8684-a96c89b47d07
Approval-Ref: thread-post:1177004
Approved-At: 2026-10-12T19:08:33.744Z
Rubric revision: 1 → 2
Subject plan revision: 18 → 19
Changed BARs: R-2, R-3, R-4, R-5, R-6, R-9, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.

### D-006 — R-16, R-17 and R-18 are manual BARs: drop requiredTestLayers

Date: 2026-10-12
Their proof is CI runs in papercup-rust-mobile (XCUITest via tools/ios-ci.py, Compose UI via tools/android-ci.py, unit tests). That repo's runs never reach this harness's test-run ledger, so the checks are explicitly manual (instrumentKey none). A manual BAR cannot also declare requiredTestLayers: the :3170 build refuses it as acceptance_bar_amendment_check_layer_mismatch, and the ledger could never satisfy a declared layer anyway. The METHOD text keeps naming the exact test runs and CI run ids the grader must cite, so no requirement is weakened. [self, 2026-10-12]

### D-007 — Acceptance BAR amendment

Date: 2026-10-13
Amendment-Id: amend-93ce498ed4d99481ab7199c9
Request-Hash: ed9849d7142c0854216a2310818e769ec16e8572657d6923b2c6409142d12711
Actor: su-440f5011-1dcd-4466-86d7-c20957d251ec
Reason: Reword BAR text to remove implementation tokens flagged by spec-quality implementation-independence (route parameter :ownerId -> :owner, field names ownerId/sessionState -> owner id/session state, product name iPhone -> iOS), and make R-16/R-17/R-18 consistent manual BARs by dropping requiredTestLayers (their check is instrumentKey none: proof is papercup-rust-mobile CI runs this harness ledger never records; plan decision records it). No requirement meaning changes; methods still name the required test runs.
Approved-By: system:judge/su-6c84b1a9-6343-478f-8377-d97c3f480a9f
Approval-Ref: thread-post:1177745
Approved-At: 2026-10-12T22:17:23.821Z
Rubric revision: 2 → 3
Subject plan revision: 31 → 32
Changed BARs: R-1, R-2, R-3, R-7, R-8, R-9, R-16, R-17, R-18, R-19
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.

### D-008 — R-9 / P-017: the desktop 'End session' path is the Stop agent action, which runs fleet:kill

Date: 2026-10-13
R-9 requires POST /device/sessions/:owner/end to end a session through the same server path the desktop uses. The desktop's owner-facing end action is the chat action 'Stop agent' (id session-stop). It sends POST /api/admin/coordination/fleet/kill { owner, close_terminal: true, reason } to the generic /admin/coordination/:group/:verb dispatcher, which runs the fleet:kill tool (killOne). session:end is not the path: it only ends the caller's own session.

Measured: 2026-10-13 by grep in the papercusp staging tree — papercusp/apps/operator/lib/chat-actions/SessionActions.ts:117 `export async function stopAgent`, :119 `postText('/api/admin/coordination/fleet/kill', {`, :121 `close_terminal: true`, :199 `id: 'session-stop'`; papercusp/packages/operator-core/lib/endpoint-route/routes/admin/coordination.ts:127 `path: '/admin/coordination/:group/:verb'`; papercusp/packages/operator-core/lib/agent-tools/fleet/kill.ts:37-38 (self-kill refused, required reason, every kill audited), :322 `export async function killOne`, :335 `code: 'self_kill_refused'`.

Decision: P-017's device end route dispatches fleet:kill with the same arguments the desktop sends (owner, close_terminal: true, a required reason). It inherits fleet:kill's rules unchanged: self-kill is refused, a reason is required, and the kill is audited. The route must not add a second kill implementation. R-9's 'End session action' means this Stop agent action.

### D-009 — R-14 is a papercup-core client gate per D-002; the BAR states that and is proven in mobile CI, not at the route

Date: 2026-10-13
Date: 2026-10-13
[self, su-440f5011] Responds to bar critique conv-request-2fbd33fe… item 2 (critic su-7ce688aa, 2026-10-13 03:00Z): R-14 as worded ('the device presents a biometric unlock inside the configured window', checked by a route test) is unfalsifiable at the route, because nothing the server receives proves an unlock happened.
Measured 2026-10-13 ~03:15Z: no server code in apps/operator/lib, packages/operator-core/lib or apps/operator/app/api mentions a biometric unlock, and no /device/sessions route exists yet, so no verification design is already built.
Ruling: D-002 [owner 2026-10-12] models the send gate on the existing CLIENT-side workspace-switch gate (papercup-core biometric.rs, RiskLevel Medium) and assigns the SERVER the per-device Agent sessions capability. So R-14 is reworded as a papercup-core behaviour: papercup-core refuses to issue a send or end request when the last biometric unlock is older than the window, proven by papercup-rust-mobile unit tests with CI run ids (a manual BAR, same evidence contract as R-16). The server-side defences stay R-4 (device JWT, revocation) and the capability check. The critic's alternative, a server-verified signed unlock assertion bound to the device key, would change D-002's security design; that is the owner's call and is asked separately, not assumed here.

### D-010 — R-13 / R-35: a phone-sent message is labelled as the owner's from a paired device but stays agent-origin in turn provenance (owner-ask default A)

Date: 2026-10-13
Date: 2026-10-13
[self-imposed default, pending owner answer] Owner ask conv-mv63ym1m-0000-176e576bdb7749be8337b8781a27ef07 (2026-10-13 03:15Z) Q2 offered A = keep agent-origin plus a 'sent from a paired device' label, or B = add an owner-device origin so a phone message counts as owner speech. Avi has not answered yet. As that ask said, the plan proceeds on default A, and this decision is reversible.
Why A: a stolen or leaked device token must not be able to create owner directives fleet-wide. B would widen who can issue owner directives and change every su's directive-provenance rules, which is a security change that needs the owner.
Effect: R-13 asserts the label. R-35 asserts turn provenance classifies a phone-sent message as agent-origin, never owner-typed. P-004 no longer stamps owner-directed provenance.
If Avi picks B: replace R-35 with an owner-device-origin BAR, amend P-004, and add a provenance-classifier work item.

### D-011 — Per-device send rate limiting is a v1 non-goal

Date: 2026-10-13
Date: 2026-10-13
[self] Disposition of bar-critique point 17 (WI-6554700010009280 thread post 1178103). v1 adds no per-device rate limit or abuse throttle on phone sends or ends.
Why that is acceptable for v1: the Agent sessions capability is per-device, granted only by the owner on the desktop, and revocable at once, which also closes open streams (R-4, R-25). Every accepted and refused action is audited (R-15, R-36). Sends need an idempotency key (R-12, R-33, R-34). The biometric window gates send and end on the phone (D-002, R-14).
Revisit if the device actions audit shows abuse, or if the owner asks for a limit. The plan's Non-goals list carries this entry.

### D-012 — Mobile item specs ITEM-P-008..013-1 and ITEM-P-018-1 are manual (non-automated, no test layers), extending D-006

Date: 2026-10-13
Date: 2026-10-13 [self]

P-008..P-013 and P-018 are SwiftUI and Compose work in papercup-rust-mobile. Their proof is XCUITest, Compose UI and unit test runs in that repo's CI (papercup-rust-mobile/tools/ios-ci.py, papercup-rust-mobile/tools/android-ci.py). Those runs never reach this harness's test-run ledger, so the item specs' previous requiredTestLayers ['browser'] could never be satisfied. A phone UI is also not a browser.

Ruling: each of these item specs is now behaviorClass non-automated with requiredTestLayers [] and requiredEvidence ['tree'], matching D-006 for R-16/R-17/R-18. Behavior text and falsifiers are unchanged. New revisions (plans:set-specs, 2026-10-13 ~03:53Z): ITEM-P-008-1 r3, ITEM-P-009-1 r3, ITEM-P-010-1 r3, ITEM-P-011-1 r2, ITEM-P-012-1 r3, ITEM-P-013-1 r2, ITEM-P-018-1 r2.

For implementers: closing one of these items still requires real evidence. Cite the papercup-rust-mobile CI run id and the named XCUITest / Compose UI test that exercises the clause's behavior, as manual evidence. A typecheck or a statement is not enough.

Coverage check: this change does not uncover any item.
Measured: 2026-10-13 ~03:50Z, papercusp staging tree, packages/operator-core/lib/agent-tools/plans/spec-quality.ts. Line 522: coveredItems is built from independent active item clauses plus valid exemptions, with no behaviorClass filter, so an active non-automated ITEM clause still covers its item. Lines 344-350: planClassFit for plan-class-feature-ship only needs clauses.length > 0. The same pattern (non-automated, []) was already accepted on AUTO-BAR-R-16-P-007/P-015 r3 and AUTO-BAR-R-17-P-008/P-011 r4 (dev:pg_query on harness_shared.plan_spec_clause_revisions).

### D-013 — Acceptance BAR amendment

Date: 2026-10-13
Amendment-Id: amend-5e620386b9312e146d684d3b
Request-Hash: 05439562d6ea2cfa2bfbfc98a58f30d29e581aa922eee1df0bcd5338a6e8090b
Actor: su-440f5011-1dcd-4466-86d7-c20957d251ec
Reason: Rev-4 BAR set answering both outside bar critiques (conv-request-2fbd33fe..., conv-request-ae9dad53...); dispositions = WI-6554700010009280 thread post 1178103. Splits compound BARs into atomic BARs (R-1 -> R-1,R-20..R-24; R-4 revocation -> R-25; R-9 -> R-9,R-26..R-28; R-10 -> R-10,R-29..R-31; R-11 -> R-11,R-32; R-12 -> R-12,R-33,R-34; R-13 -> R-13,R-35; R-15 refusals -> R-36). Unit-test-bound BARs move to the tree plane, live proof kept as separate manual BARs (R-24, R-32). R-5 covers every payload incl. tool arguments; R-6/R-14/R-29 are manual mobile-CI BARs (D-009); R-7 covers the push suite; R-8 cites release-plan agreement + fresh release grades. R-13/R-35/R-14 follow owner-ask defaults A/A (D-009, D-010), reversible. Re-route after outside review objection thread-post:1178128: adds manual live BARs R-37 (production push reaches a paired iOS and Android phone, tap opens the session; replaces old R-10 live proof) and R-38 (phone send wakes a parked agent, message in its transcript; replaces old R-3 live proof), both P-016 artifacts. Second re-route after objection thread-post:1178164: adds R-39 (both apps' revoked-state UI tests) and R-40 (both apps' composer-send tests) in the R-29 mobile-CI pattern, keeping the old R-7 mobile clause, and R-41 (live direct-connection follow, P-016 artifact) beside R-32 so both transports keep a device-level proof (old R-11). Non-blocking note fixed: R-13 method drops its live step (R-38 covers the live send) and R-13 maps to P-004 only. Nothing else changed from preview thread-post:1178138.
Approved-By: system:judge/su-44c77c37-d688-40bb-a660-195089898066
Approval-Ref: thread-post:1178179
Approved-At: 2026-10-13T04:25:08.366Z
Rubric revision: 3 → 4
Subject plan revision: 42 → 43
Changed BARs: R-1, R-2, R-3, R-4, R-5, R-7, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-19, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32, R-33, R-34, R-35, R-36, R-37, R-38, R-39, R-40, R-41
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-1, R-2, R-3, R-4, R-5, R-7, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-19, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32, R-33, R-34, R-35, R-36

### D-014 — Acceptance BAR amendment

Date: 2026-10-13
Amendment-Id: mobile-r36-and-test-paths-v1
Request-Hash: 9f47619a9bd34c1fe7d5a8c8002d7130ef338391496552073961064e95eb345a
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: Apply outside-vetting R36 identified-device clarification, retaining authenticated ungranted and revoked-capability audit; correct planned check paths to the implemented session-messages and shared session-push suites without changing the other BAR meanings.
Approved-By: su-bb828eeb-76e0-4a32-a593-bac9cb2269c3
Approval-Ref: thread-post:1179374
Approved-At: 2026-10-13T19:12:55.545Z
Rubric revision: 4 → 5
Subject plan revision: 48 → 49
Changed BARs: R-3, R-5, R-7, R-10, R-12, R-13, R-15, R-30, R-31, R-33, R-34, R-35, R-36
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.

### D-015 — Acceptance BAR amendment

Date: 2026-10-13
Amendment-Id: mobile-detection-bindings-additive-v1
Request-Hash: db0a70c7c38c328b917367d5af7e77a2aadb7738164fc8a1b576623839905d7d
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: Add existing real-PG audit/idempotency, shared desktop action/provenance, real JWT auth matrix, and dispatcher/device-store grant detector suites to the existing checks. No BAR wording, layer or plane changes; preserves every prior check. Audit route matrix19passes at ledger21216336 and focused typecheckclean.
Approval: not required — every change is additive (R-10, R-12, R-13, R-15, R-3, R-31, R-33, R-34, R-35, R-36, R-9)
Rubric revision: 5 → 6
Subject plan revision: 49 → 50
Changed BARs: R-3, R-9, R-10, R-12, R-13, R-15, R-31, R-33, R-34, R-35, R-36
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-3, R-9, R-10, R-12, R-13, R-15, R-31, R-33, R-34, R-35, R-36

### D-016 — Acceptance BAR amendment

Date: 2026-10-13
Amendment-Id: mobile-r25-stream-detector-method-v1-apply
Request-Hash: d4f62d6b40689b8ee4762149023b5080ffacd7799b9aa49c754e0a70951bc7d5
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: Correct grading-integrity audit EI-25897155176623878: R25 must bind its actual open-stream revocation detector, not only next-request JWT refusal. Preserve BAR text, falsifier, planes and every existing check; clarify the method to name the already passing and mutation-verified stream detector.
Approval: not required — every change is additive (R-25)
Rubric revision: 6 → 7
Subject plan revision: 50 → 51
Changed BARs: R-25
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.

### D-017 — Acceptance BAR amendment

Date: 2026-10-14
Amendment-Id: mobile-r36-atomic-authcondition-apply-20261014-v1
Request-Hash: 1bf04ea7036f998b1f7b3a6a26c6c58d40a5d0fd8c34b21fb8b8c4f771e992c8
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: Repair EI-25962456973873490 by expressing R-36 as one audit-row behavior conditioned on successful device authentication. Preserve authenticated refusal identity and cardinality, unauthenticated no-row semantics, existing falsifier and every detector check; JWT refusal itself is already required by R-4.
Approved-By: su-bf9ee38a-1d80-40ee-ba20-68e9060dc3d4
Approval-Ref: thread-post:1181316
Approved-At: 2026-10-14T16:17:02.560Z
Rubric revision: 7 → 8
Subject plan revision: 59 → 60
Changed BARs: R-36
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-36

### D-018 — Acceptance BAR amendment

Date: 2026-10-14
Amendment-Id: mobile-rubric8-final1181407-complete-amend-20261014-v1
Request-Hash: 2c691d69b3a3cdff63cb7da2c9d38927a6866a99d0cabe30b09b312213f61097
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: Complete final independent critique thread-post:1181407 under WI-6554700010013211. Preserve every R1..R41 obligation, full R20 ended-row fields and universal fail-closed R27; strengthen provenance/classification/cardinality/auth inventory/paging/filter/identity detectors, explicitly preserve both-platform live auth proof and manual mobile CI positive-core proof, split compound BARs into independent mandatory R42..R50 and add the existing S2 history/older-scroll acceptance. All existing phone/safety/privacy/current-candidate obligations retained; no product acceptance or shipment claim.
Approved-By: su-6776fa6c-c6a6-41f0-9f66-8d6f42444006
Approval-Ref: thread-post:1181671
Approved-At: 2026-10-14T21:34:19.431Z
Rubric revision: 8 → 9
Subject plan revision: 63 → 64
Changed BARs: R-1, R-3, R-4, R-6, R-7, R-8, R-14, R-16, R-18, R-23, R-24, R-35, R-36, R-38, R-40, R-42, R-43, R-44, R-45, R-46, R-47, R-48, R-49, R-50
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-1, R-3, R-4, R-5, R-6, R-7, R-8, R-10, R-14, R-16, R-18, R-20, R-23, R-24, R-25, R-27, R-30, R-35, R-36, R-38, R-40

### D-019 — Acceptance BAR amendment

Date: 2026-10-15
Amendment-Id: mobile-g2-r9-oracle-marker-20261015-1
Request-Hash: dd2d0f8aa38faaf34ed565c3675e4403d65a2020a6316a6bc74476173dedd1a8
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: WI-6554700010014994 implements independent definition review thread-post:1183508 G2: scope R-9's tree detector to oracle-readback evidence without weakening actual termination or phone guarantees. Preserve R-9 model/BAR/method/check/scope and all R-46/R-49 clauses. No product, phone, core/UniFFI, CI, privacy, current-candidate, history or shipment proof is claimed.
Approved-By: su-3aa0fac6-cf2d-49a8-b673-ebcf6a32a1ca
Approval-Ref: thread-post:1183565
Approved-At: 2026-10-15T17:40:09.680Z
Rubric revision: 9 → 10
Subject plan revision: 68 → 69
Changed BARs: R-9
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-9

### D-020 — Acceptance BAR amendment

Date: 2026-10-15
Amendment-Id: mobile-r9-r46-wording-20261015-wi15069-v1
Request-Hash: 745569f5797ec272d6bad7583acd39818df1c72145ddf04ee6d747ede26bb619
Actor: su-d5c71efc-9926-433f-b5eb-6045ae8ca56a
Reason: WI-6554700010015069 / independent critique thread-post:1183612 (and prior approval thread-post:1183565): remove only R-9's duplicated oracle-readback falsifier, leaving R-26 unchanged as its sole detector; preserve desktop fleet:kill action parity and R-9 actual-termination outcome failure; make the already-required live actual-termination falsifier explicit in R-46. All 50 keys, models, methods, check bindings, scopes, mandatory/pass semantics, R-49 controls and product-shipment obligations remain unchanged.
Approved-By: su-1a2c42bf-b8ec-420c-a635-51b11061f1c0
Approval-Ref: thread-post:1183645
Approved-At: 2026-10-15T18:33:47.011Z
Rubric revision: 10 → 11
Subject plan revision: 69 → 70
Changed BARs: R-9, R-46
Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.
Requirements re-rendered from the amended criterion: R-9, R-46


## Evidence disposition for a corrected independent card

Do not copy the old six-pass map. Re-derive each of the six meta5 ratings from its full population above and the immutable source reads. R6/verification-shaped wording, partial/absent operational bindings, partial detector coverage and overlap findings must be acknowledged. The meta runbook permits honest weak findings and has no mechanical score floor, but the critic decides fitness; this author enumeration does not decide it.

If a new card is justified, it must use the current subject/hash and the SAME active audit-repair consult, supersede EI-26071954825118708, acknowledgeExisting:true, and carry reproducible per-rating source reads, exhaustive scope, selectors and findings. Re-read emitter schema rather than inventing a generic rerunRecipe (that field is specialized). A non-author grading-integrity audit still must pass. No product/core/UniFFI/mobileCI/both-phone/live/privacy/current-candidate/history acceptance or shipment is established here.

