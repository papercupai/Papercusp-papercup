---
rel_path: "evidence/bg-host-r7-vet-post1204731-20261025.md"
updated_at: 1792900082150
_body: "content"
---

OBJECT — one remaining R1 detector gap; no additional defect found in the R2–R4 contract. First-principles contract review only; no implementation, runtime, or parent-settlement acceptance.

Verified subject: acceptance-bg-host-committed-generation-2026-10-24 revision 7, criteriaHash 085af8056b9a3efc5f3e0254d677e7a6b96f3275e3ab50a014b293326c16a356; subject plan revision 10/hash 7301d35de10de7dfd83afcf160376753a68308712bf12d2cda8c710b8d7c863a; barSetHash 044745a75f5c238ea4486300532ec25ba0e63fdf1d10fa1a3302da89f0cac94a. Compared against meta-acceptance-rubric revision 5/hash 215de0837eaed307004dd8a9dfcf2cff9caaa47b9ee19e3f11bb2c5390a19614.

I read the full opening request and empty post list through conversations:get, all four complete methods and all 129 exact selectors in bounded pages, and all eleven current clauses. The four r7-review-r packets exactly equal the authoritative revision-7 criteria; all eleven r7-review-clause packets exactly equal plans:get-specs. I independently recomputed r6→r7 preservation: every old method is a verbatim prefix, every prior selector survives, and the other criterion fields are unchanged. Candidate allSelectors exactly match current check.cases; its 22/26/16/35 branch rows match method rows and selectors, totaling 99, plus four census cases and 26 retained cases. I also checked the preservation/routing artifact and immutable clause history: all four custom prior probes remain prefixes and no prior requiredScenario was removed.

Remaining hole — R1 transient compiler-input substitution:

A plausible wrong implementation verifies source A and its receipt before invoking the maintained builder, permits a selected private source file to change to same-length B while the compiler reads it, and restores A before the postbuild census/artifact writer. The compiler emits B; both source fences, Git identity, original receipt, member set and boot sourceBlobs now describe A. Output digests can faithfully describe the B bundle, with the correct service/epoch/PID and successful normal bootstrap. Thus identity joins need not expose the wrong compiler-consumed bytes.

This is a counterexample to detector completeness, not permission under the prose: R1 already demands immutable inputs and compilation from that physical verified generation. The 29 exact R1 selectors, its parent selectors, and both preparation clauses do not bind a mutation-during-compile-and-restore branch. Endpoint hashes alone cannot establish that invariant.

Source evidence: packages/operator-core/lib/release/operator-artifact.ts writeOperatorArtifactManifest reads metafile input membership and hashes current source files against Git objects after the build; it hashes the resulting bundle separately. Its stableFile check stabilizes each individual read, not the earlier compiler read. operator-artifact.test.ts's 'does not stamp a source input changed after the compiler read it' leaves the differing source on disk when f.write runs, so it does not distinguish this restored-input case. Current-byte census/provenance assertions do not prove compiler-read contents. No code execution or production reproduction is claimed.

Concrete repair: bind an independently named maintained test for a selected source mutation after prebuild verification, consumption by the real compiler, and restoration before the final fence. Require prevention of the write or refusal of qualification; retain the ordinary immutable-build positive control. Include the analogous compile-time dependency case if handled by a separate custody mechanism. A narrow immutability/compiler-read-content validation bypass must parse, admit the substituted bytes, and fail the named decisive assertion with unrelated inputs unchanged. Immutable input enforcement or verified content supplied at compiler-read time can satisfy the guarantee; end-point comparison alone cannot. Route these scenarios into R1's census and both preparation clauses.

| BAR | Contract disposition |
|---|---|
| R-1 (29 cases) | OBJECT: compiler-consumed-byte gap above. Authority/schema/literal-member and both endpoint branch additions otherwise preserve the contract. |
| R-2 (34 cases) | No additional defect found: separate stale activation/publication/readiness/rollback, qualified baseline, readiness/rollback boundaries, first-start, cancellation/interruption and failed-recovery branches retain maintained drain, measured recovery and service identity. At/after D cannot be timely success. |
| R-3 (24 cases) | No additional defect found: eight live-parent authority/schema/digest/literal-member rows explicitly join the original expected authority to the actual guarded service entry before imports and the existing dependency/build/artifact/import/readiness cohort. Guard/invocation and epoch/process drift at all three observation positions remain required. R1 tree receipts cannot discharge this live conjunction. |
| R-4 (42 cases) | No additional defect found: twenty custody field/action rows and fifteen outcome/timing rows require individual proof, late-discovered descendants, immutable custody, and independent deadline-exceeded evidence even when another terminal cause already fails. Before-D rows additionally carry the unresolved control through original expiry. |

| Current clause | Disposition |
|---|---|
| AUTO-BAR-R-1-P-001@8 | OBJECT through R1 gap. |
| AUTO-BAR-R-2-P-002@8 | No additional contract defect. |
| AUTO-BAR-R-3-P-002@9 | No additional contract defect. |
| AUTO-BAR-R-3-P-003@9 | No additional contract defect. |
| AUTO-BAR-R-4-P-001@9 | No additional contract defect. |
| AUTO-BAR-R-4-P-002@9 | No additional contract defect. |
| AUTO-BAR-R-4-P-003@9 | No additional contract defect. |
| BG-PREP-EXACT-SELECTION@4 | OBJECT: add compiler-read/restoration scenario to its 29-scenario floor. |
| BG-PREP-REJECT-INCOHERENT@4 | OBJECT: same missing discriminator in its 33-scenario floor. |
| BG-ACTIVATION-PRESERVE-VERIFIED@4 | No additional contract defect; 75 scenarios and R2/R4 routing preserved. |
| BG-QUALIFY-ACTUAL-ENTRY@4 | No additional contract defect; 66 scenarios and R3/R4 routing preserved. |

Every clause is active, mutationRequired:true, exemption:null. All seven AUTO clauses pin rubric revision 7 with the matching BAR hashes. Live clauses retain live+operational+mutation+test evidence; source clauses retain their test/mutation/tree floors. requiredTestLayers:['unit'] is schema-compatible: I read RECORDED_TEST_LAYERS and the configured check-file classifier; all four named suites resolve to unit. Operational/live/manual provenance are evidence obligations, not invented recorder layers.

Meta dispositions for contract design: outcomes PASS; traces-to-goal/Decision PASS; falsifiable PASS; failure-mode-coverage WEAK for the R1 discriminator; non-overlapping PASS (source eligibility, activation recovery, actual runtime lineage, cleanup custody have distinguishable failures); prefer-structured-check WEAK for the same under-bound invariant. Actual detector execution adequacy remains UNVERIFIED: the packets mark all 129 cases UNEXECUTED, and I ran no tests or runtime effects.

Traceability is to the agent-derived plan shaping, SC-001–SC-005 and D-002–D-010; the cited source turn 7 is an assistant statement, not a new owner instruction. UNKNOWN original parent manifest still forbids actual preparation. Child service qualification, synthetic fixtures and this review cannot establish original fire24 producer/rearm/settlement. The routed historical transcript was background only and did not supply proof of this current subject.

Evidence: all supplied r7 review packets, granular-contract-candidate and preservation/routing artifacts; authoritative rubric6/7, meta5, plan10 shaping/Decisions, specs current/history, and the named source files.
