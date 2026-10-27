---
rel_path: "evidence/identity-assume/recovery44/rubric7-independent-critique.md"
updated_at: 1792921600883
_body: "content"
---

Independent vet — acceptance-agent-assume-identity-2026-10-23

VERDICT: ATTESTABLE as an acceptance contract (not an implementation, run-cleanliness, acceptance, or shipment verdict).

Exact immutable identity checked:
- rubricRef: acceptance-agent-assume-identity-2026-10-23
- revision: 7
- criteriaHash: 08a7d57cc6779c78a040764f22736c7184b76d44f4e9d6fbdf1dd9ad86b2efc1
- subject plan: agent-assume-identity-2026-10-23 revision 20
- subject plan contentHash: bb8ddd60baaecbc6a19f42f6e12f7a1391e97a798b621f8751c43ded296807d2
- BAR subjectPlanRevision: 20
- meta-rubric: meta-acceptance-rubric revision 5, criteriaHash 215de0837eaed307004dd8a9dfcf2cff9caaa47b9ee19e3f11bb2c5390a19614

Evidence checked:
- Full current rubric readback, all twelve R-1..R-12 criteria including intent/model/method/drift markers/scope/plane/layers/check bindings.
- Current plan Product shaping, Design, Requirements, and D-001..D-007.
- Full revision-6 critique thread-post:1204995.
- Exact amendment approval thread-post:1205039 and D-007.
- Current selector resolver packages/operator-core/lib/testing-case-filter.ts: exact full title or complete suffix at a “ > ” boundary; zero-match and skipped-only cases refuse.
- Current maintained titles/assertions in assume.test.ts, assume.integration.test.ts, psu-session-assume.test.ts, psu-identity-assume-native.integration.test.ts, including response ordering and both SIGKILL windows.
I did not run suites or verify clean committed proof, current-build receipts, deployment, or shipment.

Meta-rubric ratings

1. PASS — outcomes-not-diff-restatements.
All twelve criteria state externally observable guarantees rather than edit inventory:
R-1 exclusive same-channel managed transition and response/completion/exit order; R-2 target responsibility continuity; R-3 explicit context-mode fidelity; R-4 exact custody/CAS exclusivity; R-5 caller recoverability; R-6 truthful accepted-versus-verified status; R-7 exact-artifact acceptance/shipment; R-8 atomic crash recovery; R-9 bounded authorization; R-10 context confidentiality/integrity; R-11 immutable provenance; R-12 preview nonmutation. A non-implementer can falsify each without accepting “the diff exists.”

2. PASS — traces-to-goal-or-decision.
The outcomes cover shaping scenarios/non-goals and the complete plan contract. D-002’s previously uncovered consequence is now explicit in R-1: invoking response delivered to the pinned caller, then a fresh native completion boundary, then verified caller exit. D-001/D-003 establish substantive BAR history, D-004/D-006 preserve selector-only routing repairs, D-005 adds native crash evidence, and D-007 records the rev6 repair with independent approval. No gradeable D-001..D-007 consequence is dropped, and no criterion imports unrelated scope.

3. PASS — falsifiable-with-evidence.
Every criterion has a concrete breaking observation and named method. Representative falsifiers: early caller exit or ACK/status-triggered replacement (R-1), lost/duplicated/misattributed target responsibilities (R-2), silent context fallback (R-3), two writers or stale-token commit (R-4), unrecoverable caller or transferred obligations (R-5), “accepted” reported as “verified” without routed probes (R-6), artifact/provenance mismatch (R-7), ghost custody/nonconvergent retry (R-8), unauthorized disclosure/mutation (R-9), caller secret/history leakage (R-10), missing/mutable audit provenance (R-11), and any preview state-version change (R-12).

4. PASS — failure-mode coverage.
The contract covers success plus refusal, race/CAS, replay/expiry, live/foreign/unknown custody, stale incarnation/writer/context, unavailable/corrupt context, wake and caller recovery, indeterminate timeout/host death, confidentiality, audit immutability, read-only preview, exact shipment, and ordered crash recovery. The prior gaps are repaired:
- D-002 order is response delivery → fresh native completion → caller exit, with early input/lifecycle fencing.
- R-8 binds real SIGKILL before target execution and a second real SIGKILL after target native-writer acquisition but before verification, preserving durable reservation, one-writer behavior, recoverability, and idempotent retry.

5. PASS — non-overlapping.
Each close pair has a distinguishing failure: R-1 channel/cutover order vs R-6 status truth; R-2 target obligations vs R-5 caller restoration; R-3 selected context identity vs R-10 boundary confidentiality/integrity; R-4 admission exclusivity vs R-8 recovery after admission; R-9 authority vs R-11 audit provenance; R-12 preview invariance vs execution outcomes. R-7 alone owns final promoted/deployed-artifact shipment. A defect can affect multiple guarantees, but no pair is coextensive.

6. PASS — prefer-structured-check / detector adequacy.
All objectively checkable R-1..R-6 and R-8..R-12 carry tests bindings with unit and integration layers; R-7 retains its explicit deployed manual-provenance instrument contract and exact-artifact mandatory evidence fields.

The six previously unresolved parameterized selector entries are repaired by realized titles, not broad substrings:
- R-4 expands the unit matrix to eight complete realized suffixes: identity, incarnation, registration, native session, writer generation, context hash, context revision, backend.
- R-6 expands real-PG timeout and host death.
- R-8 expands four unit plus four real-PG boundaries: caller-checkpointed, caller-quiesced, target-custody-acquired, handoff-requested.
- R-11 expands three unit terminal outcomes and three real-PG outcomes (including actual PG title “target-verified”).
These conform to the full-title/complete-suffix resolver and no longer rely on an internal substring of an it.each title.

Added installed-native bindings are responsible:
- R-2: real routed responsibilities/continuity in native-resume and checkpoint modes.
- R-3: exact native context versus fresh pinned checkpoint mode.
- R-4: real preview/refusal plus two-caller custody race.
- R-6: actual writer/attachment and post-cutover routing verification.
- R-9: native preflight/refusal complements exact unit/real-PG token and commit-authorizer checks.
- R-10: both context modes exercise target context and caller-secret exclusion.
- R-11: production-custody journeys retain runtime transition provenance, complementing exact append-only unit/real-PG checks.
- R-12: native preview/refusal supplies real host/process nonmutation evidence.
R-1 binds the response-ordering case, which holds the pinned caller across host inspection ticks, rejects early turn/carry-respawn input, observes the original caller receive the tool result, releases fresh completion, then permits replacement/exit.
R-8 binds both host crash windows: persisted handoff + SIGKILL before target execution, and target process/native writer acquired + SIGKILL before verification.

No weakening found.
Revision 7 preserves all twelve outcomes, required scopes, evidence planes, unit/integration layers, methods, and falsifiers. R-5 and R-7 are unchanged. The amendment adds ordering semantics and responsible detectors; it narrows no prior obligation. Approval post 1205039 confirms all ten prior hashes, unchanged R-5/R-7, no removed BAR, and no weakened scope/plane/layer/falsifier.

Limits:
This says revision 7 is an adequate, traceable, falsifiable, non-overlapping and appropriately bound acceptance rubric. It does not say any case passed on a clean committed tree, native13/race-mutant proof is current, implementation is accepted, or the artifact is promoted/deployed. Those remain later evidence and grading obligations.
