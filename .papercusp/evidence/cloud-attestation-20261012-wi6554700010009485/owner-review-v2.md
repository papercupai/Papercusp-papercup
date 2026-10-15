# Current Cloud rubric attestation review

Work-item: WI-6554700010009485. Author: su-ec5efb56-8a98-4efe-a8e2-02017ee78bb8. Reviewed 2026-10-13.
Subject: acceptance-cloud-cross-feature-e2e-shipment-2026-10-08 revision 6, criteriaHash 50c85cea02abc61fa13a85280a3bdffd6fcfa6acebb423a9920613bd2c3d6dfc.
Plan: cloud-cross-feature-e2e-shipment-2026-10-08 revision 16, contentHash 67e21d9136af1493c5b4645a27cdbed50c10a885941c74c0ab84c5b4f574a4c4.
Meta rubric: meta-acceptance-rubric revision 5, criteriaHash 215de0837eaed307004dd8a9dfcf2cff9caaa47b9ee19e3f11bb2c5390a19614.

This review grades the acceptance contract. It supplies no new functional, real-provider, affected-selection or shipped-artifact proof. Historical controls remain at their original generations. Current R4 edition 6 remains NONPASS, including unresolved repair/runtime joins. Existing host and Git credential-source/scope questions remain pending.

## Source and consultation

The complete existing consultation conv-mv1jv15d-0000-248852d6ea4940c88476953379e3d3d9 was recovered from the full tools:invoke overflow, not inferred from its earlier partial response. Third-party post 1169421 rejected the revision-5 shipment checker for accepting arbitrary nonempty references. Author repair post 1169446 described the canonical shipment context. Third-party post 1169455 approved exact revision 6/hash, explicitly limiting approval to rubric adequacy and preserving empty actual acceptance evidence. The recovered record is consult-full.json.

Current rubrics:get still rejects old meta card EI-25585761932988344 because its grading-audit criteria hash is stale. That historical terminal observation and audit are preserved. A new current meta card must obtain an independent current audit; a new author emit alone does not settle the prerequisite.

Both checker files remain exact committed bytes:
- packages/operator-core/lib/workspace-host/cloud-e2e-campaign-evidence.ts: SHA256 6016943d82e87410e81ee5f28b7eff8ac4c77425837967ebf586d1ac572ce4d4; Git blob 0204bc06d8918a911d48704d46d180d2b4cc52c7.
- packages/operator-core/lib/workspace-host/cloud-e2e-campaign-evidence.test.ts: SHA256 88716794d22372240c327ed81504464aa8b468f538eb63ed4c2363db08bbd80f; Git blob 99afbc58eb8f12a7b7249517a74e594db93b1797.

All fifteen distinct bound paths resolve. Detector adequacy below derives from read assertions and branches, rather than path resolution or historic pass counts.

## Criterion-specific detector mapping

All line references below are in the bound cloud-e2e-campaign-evidence.test.ts unless a source branch is named.

| BAR | Concrete falsifier and bound detector | Observation forced by the detector |
| --- | --- | --- |
| R-1 Inventory | Lines 29-53 compare the source-backed population, uniqueness, names SHA, canonical exact partition, supported GCP/AWS and planned Azure refusal. Omitted, overlapping and invented partition entries are explicitly rejected at lines 43-45. The evaluator compares independently supplied ordered population and exact partition. | Dropping a documented population member or duplicating its disposition fails inventory; an owned gap accounts for disclosure without passing later bars. |
| R-2 Persistent coverage | Lines 238-243 mutate result, affected selection, test-file hash, full case title and source SHA; lines 253-261 remove or contradict canonical ledger rows, including collection failure. Each requires unproven-detector:Provisioning. The evaluator joins scenario/class/file/title/source/test hash with the measured passed ledger and affected selection. | A green authored detector claim with absent selection or a different source/title/row stays nonpass. |
| R-3 Adversarial recovery | Lines 245-250 mutate the adversarial negative control to missed; R-3 must fail while R-2 remains empty. The evaluator requires a caught adversarial control and the same exact detector/ledger joins. The rubric additionally binds maintained chaos, hosted lifecycle policy, action, browser, provisioning and restore tests and requires actual permission/lifecycle controls. | An uncaught adversarial control cannot be converted into coverage by a passing happy-path detector. Fixture controls cannot establish provider reality. |
| R-4 Durable repair | Lines 264-273 mutate missing defect, unowned residue, owned-open repair, identical predictions, absent triggering journey and proposed completion. Every case requires an R-4 problem. Lines 276-281 positively permit accountable deferred residue in R-4 but require final shipment failure. The evaluator checks the discovered-defect denominator, committed completion, originating fix reference, v2 root-cause fields, caught recurrence detector and actual non-synthetic triggering receipt. | Ownership alone cannot close an open repair; identical hypotheses, missing guard/journey, or proposed closure fail. Accountable deferred residue is not a shipment pass. |
| R-5 Real runtime | Lines 284-319 mutate synthetic/authentication/source/artifact/tenant/workspace/account/run/label/time identity, incomplete provider-kind census, unknown billing closure, omitted obligation, duplicate receipt, partial actions and malformed/truthy-string census. These require unproven-runtime for the affected provider. Source lines 243-274 require all five runtimes, fresh exact identities, every action, controller-independent full-kind census and separately timed billing closure. | Mocked, stale, foreign, partially exercised or incompletely cleaned provider input remains nonpass while detector coverage may remain eligible. |
| R-6 Exact shipment | Lines 322-390 mutate invented nonempty refs, missing/wrong/duplicate canonical records, red promotion, failed deployment, foreign serving identity, final execution before deployment, proposed/partial audit, plan/rubric hash mismatch, self/unverified/pending-audit grade and report digest/readback/visibility/time. Each requires R-6 failure while eligible R-5 remains distinct. Source lines 276-361 exact-join promotion/deployment/serving/audit/grade/report to independent obligations and enforce identity, ordering, full scope and prior-bar/residue gates. | Invented nonempty strings no longer satisfy shipment. Candidate runtime proof cannot substitute for exact post-deploy journeys and settled audit/independent grade/owner report. |

Positive control: lines 226-229 require complete correlated synthetic input to pass all six validator partitions. Lines 231-235 require the actual incomplete campaign to fail R-2 through R-6 even if its authored status says shipped. The controls exercise the existing evaluator; deleting or always-failing it cannot satisfy the positive assertion. They validate the checker only.

## Current plan trace and independence

R-1 through R-6 trace directly to the six current plan Requirements. The distinct outputs are inventory disclosure, persistent happy-path detectors, adversarial/recovery outcomes, durable repairs, candidate real-runtime execution, and final exact deployed-artifact acceptance.
- D-001 strengthens R-4 by binding the three maintained Cloud UI regression files; they remain in the rubric.
- D-002 pins R-1's population and explicitly limits the inventory checker proof.
- D-003 supplies canonical detector/defect/runtime/shipment joins for R-2 through R-6 while preserving the original outcome and evidence planes.
- D-004 authorizes repair of this session's thirteen portal findings under R-4 and the existing execution phase. Root cause, recurrence guard and triggering journey remain required; source/fixture success is not promoted to real-runtime proof.
- D-005 reuses the maintained hosted PTY/file/reconnect/desktop acceptance slice under R-2/R-3/R-5. It expressly preserves authorization boundaries, current host/session identity prerequisites, provider/billing/model/Git/full-scope obligations and the exact shipment bar. It grants no target access.

Independent-axis observations are explicit: caught happy guards with a missed adversarial control fail R-3 independently of R-2; unverified repair fails R-4; synthetic or wrong-identity execution fails R-5 without changing detector eligibility; valid R-5 candidate proof with invented deployment or report references fails R-6.

## Meta ratings and limits

The six meta criteria are rated pass for this contract review: observable outcomes; current requirement/decision trace; specific falsifiers; named failure surfaces; distinct acceptance outcomes; and maintained assertion bindings with positive controls.
The fresh card requires an independent grading-integrity audit. No old audit stamp is edited, no acceptance BAR or provider scope is weakened, and no actual acceptance/shipment pass is asserted.
No test, browser, native, provider, build, billing or gate execution was performed in this review. Historical 92-case checker proof is referenced only as the consultation's original record, not replayed or relabeled current acceptance.

## Settled attestation

Fresh terminal meta card EI-25820926789813836 was independently audited by system:judge/su-53792f79-4481-44e1-925e-bb540a9a6bfb. Audit card EI-25821501641646181 passed at 2026-10-13T00:21:43.678Z under current grading-integrity revision 12/hash23b30ebf. All six complete audit criterion records were read, including its positive source checks, uniform-rating review, and stated hash-probe capability limitation. Complete audit evidence is retained in audit-settlement.json.

Authoritative rubrics:get now reports satisfied:true, state:vetted, reason:current for acceptance revision 6/hash50c85cea and attestation EI-25820926789813836. The old stale card and its old audit remain historical. This restores the rubric-attestation prerequisite; it does not meet real Cloud R-2 through R-6 or turn R4 edition6 NONPASS into a pass.

The independent audit noted an optional detector hardening gap: there are no isolated controls removing only originatingFixRef or only regressionDetectorId from an otherwise complete committed defect. Owned follow-up WI-6554700010009518 extends the existing test suite with those two controls. Its assignee was confirmed as this session before closing the attestation prerequisite.

## Notification correction

Await284976 timed out after the audit had passed. I initially filed it as a suspected notification mismatch, then measured the actual matcher: my registered all:[{field:'subjectRef',op:'eq',value:ref}] returns false, canonical {subjectRef:{equals:ref}} returns true, and the same canonical filter rejects a foreign subject. The matcher expects payload-path match maps. My invalid filter explains the non-match; this is not evidence that the emitter failed. Correction posts1177896/1177897 and a direct correction message were delivered to the existing event-fix lane owner. No further monitor or duplicate audit is needed.

The sole vetting critic su-35888ce7 remains excluded from later independently grading this plan's acceptance. That later stage must use another lineage-independent grader.

The existing host/tenant/workspace/DesktopSession and Git credential-source/scope choices remain already asked and pending. No new provider/browser/native/build/gate execution, historical proof replay or live-target grant occurred in restoring this prerequisite.
