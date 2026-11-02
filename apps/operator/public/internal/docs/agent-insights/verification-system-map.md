# Verification-system map: doors, layers, refusal codes, tables, tools, evidence kinds
URL: /internal/docs/agent-insights/verification-system-map

One map of everything that enforces a plan's requirement contract: the six doors that refuse (plans:start, plans:bind-spec-evidence, plans:set-plan-status shipped, plans:acceptance-disposition, plans:promote), the layer order, every contract refusal code with its meaning, the tables, tools and evidence kinds. Refusal codes are pinned to source by a doc-claims test.

A plan's **requirement contract** is the set of things it promises and how each promise is proven. This page maps every part of the system that enforces that contract, in one place: the doors that refuse, the order the layers run in, every refusal code those doors return, the tables behind them, the tools you call, and the kinds of evidence that count.

The refusal-code list below is checked against the code by `packages/operator-core/lib/doc-claims/verification-system-map.test.ts`. That test derives every code from the typed unions registered in `CONTRACT_GATE_CODE_TYPES` (`packages/operator-core/lib/doc-claims/verification-system-map.ts`). It fails when this page names a code no gate emits, omits one a gate does emit, or names a code that has no source definition or no test that triggers it.

## The doors that enforce the requirement contract

Six tools refuse when the contract is not met. Every other tool on this page prepares input for one of them.

| door                                                  | what it guards                                  | refuses when                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans:start`                                         | Turning plan items into work-items.             | The inputs, activation audit, spec quality, spec coverage or bar critique are not ready.                                                                                                                                                                                  |
| `plans:bind-spec-evidence`                            | Recording evidence for a spec clause.           | The measuring instrument has no provenance, a derived binding or mutation target is invalid, or an independent-verification row cites no valid implementer binding or re-observes a different source or environment.                                                      |
| `plans:set-plan-status` with `status:'shipped'`       | Shipping the plan.                              | Items are unfinished, code truth is unaudited, the acceptance-bar contract is incomplete, grading is missing or self-graded, the implementer has not accepted, a live/deployed bar lacks independent verification, or the blind gap review is missing or undispositioned. |
| `plans:set-status` (the item flip that drains a plan) | Moving a plan to `awaiting-acceptance`.         | No blind gap review counts for the plan's latest activation audit, or a review gap has neither a plan item nor an accepted-risk Decision. Returned as `acceptanceBlocked`; the item flip itself still lands.                                                              |
| `plans:acceptance-disposition`                        | Deciding a plan stuck in `awaiting-acceptance`. | The disposition is not a typed kind with evidence and a reason.                                                                                                                                                                                                           |
| `plans:promote`                                       | Promoting plan content.                         | The plan still carries a retired VAL-\* assertion block.                                                                                                                                                                                                                  |

## Layers, in the order they run

1. **Contract (at activation).** The acceptance rubric's bars are seeded into `AUTO-BAR-*` spec clauses, beside hand-written `SPEC-*` clauses. Each clause states a behavior, a falsifier, its required test layers and an evidence plane (`tree`, `deployed` or `live`). Read them with `plans:get-specs`; write them with `plans:set-specs`; certify them with `plans:certify-spec-clauses`.
2. **Start gates (`plans:start`).** Plan inputs, the activation audit of the source conversation, the spec-quality scorecard (`plans:evaluate-spec-quality`), spec coverage, and the bar critique (closed `bar-critique` consults from outside the author's lineage).
3. **Evidence (`plans:bind-spec-evidence`).** Each clause is bound to evidence. `operational`/`manual` bindings must name a committed instrument in the repository. A non-implementer re-observes live/deployed bars with an `independent-verification` binding. `plans:evaluate-spec-test-adequacy` judges whether bound tests are deep enough.
4. **Completion (`plans:set-plan-status shipped`).** In order: every item done or dropped; a per-item code-truth audit (`plans:audit`); the acceptance-bar contract snapshot; a vetted rubric; independent grading by a non-implementer (`scorecards:emit`); the implementer's acceptance verdict; independent verification of mandatory live/deployed bars.
5. **After completion.** The acceptance drain files one work-item per plan held in `awaiting-acceptance`. A plan idle past the surfacing threshold owes a typed decision through `plans:acceptance-disposition`.
6. **Health.** The `verification.health` state cell (P-002) reports whether the layers above are actually being used: contract triage gaps, stale acceptance without a disposition, and remaining VAL-\* usage. A count reads `null`, never `0`, when its population is empty or its measurement failed.

## Bar timing

Acceptance bars are seeded at plan activation, as part of the contract the plan starts under. At completion, amend them to as-built with `rubrics:amend`, then vet and grade that revision. Any rubric edit invalidates both the vetting attestation and any independent grading, so finish every amendment before asking for grading.

## Refusal codes

Every code below is checked against source by the doc-claims test. Codes are grouped by the door that returns them, then by the typed union that defines them.

### `plans:start`

From `PlanStartRefusal` (`packages/operator-core/lib/agent-tools/plans/plan-input-validation.ts`):

| code                           | meaning                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_required`             | A required plan input is missing.                                                                                                                                                               |
| `invalid_data`                 | A plan input fails its schema.                                                                                                                                                                  |
| `bad_schema`                   | The plan's property schema is invalid.                                                                                                                                                          |
| `unknown_template`             | The plan names a template that does not exist.                                                                                                                                                  |
| `schema_conflict`              | Plan inputs conflict with the template schema.                                                                                                                                                  |
| `plan_inputs_not_ready`        | The plan's inputs are not ready for start.                                                                                                                                                      |
| `initial_change_scope_missing` | A draft or ready plan lacks the initial code-scope anchors required to start. Add `plans:edit` anchors with `action:create` for known new work or `action:investigate` when scope is uncertain. |

From `DraftItemStartRefusal` (`packages/operator-core/lib/agent-tools/plans/draft-item-start-gate.ts`):

| code                        | meaning                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `activation_audit_required` | Starting a draft item needs a current activation audit. Run `plans:audit { phase:'activation' }`. |

From `ActivationGateRefusalCode` (`packages/operator-core/lib/agent-tools/plans/plan-activation-gate.ts`):

| code                          | meaning                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `conversation_audit_required` | Activation needs an audit of the complete source conversation (`plans:audit { phase:'activation' }`).              |
| `item_provenance_unresolved`  | A plan item maps to no owner-typed turn and has no `itemProvenance` entry declaring it `derived` or `agent-added`. |
| `plan_declarations_invalid`   | One or more required plan declaration sections are missing or invalid at activation.                               |
| `unregistered_type`           | The plan references a plan-item type that is not registered in the workspace.                                      |

From `PlanSpecQualityGateCode` (`packages/operator-core/lib/agent-tools/plans/plan-spec-quality-gate.ts`):

| code                                           | meaning                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `spec_quality_failed`                          | The spec-quality scorecard for the current spec set failed.                                   |
| `spec_quality_scorecard_missing`               | No spec-quality scorecard exists for the current spec set. Run `plans:evaluate-spec-quality`. |
| `spec_quality_scorecard_grading_audit_pending` | The spec-quality scorecard's grading audit has not finished.                                  |
| `spec_quality_scorecard_grading_audit_failed`  | The spec-quality scorecard's grading audit failed.                                            |
| `spec_quality_class_missing`                   | The plan has no plan class to score its specs against.                                        |
| `spec_quality_class_ambiguous`                 | More than one plan class matches.                                                             |
| `spec_quality_class_invalid`                   | The plan's class is not a valid plan class.                                                   |
| `spec_quality_unavailable`                     | The spec-quality check could not read its inputs.                                             |

From `BarCritiqueGateCode` (`packages/operator-core/lib/agent-tools/plans/plan-start-critique-gate.ts`):

| code               | meaning                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critique_missing` | A current clause or the current bar set is not covered by enough closed `bar-critique` consults answered from lineages outside the plan author's. |
| `critique_stale`   | A `bar-critique` consult pinned an earlier version of a clause or of the bar set, or a clause it pinned was removed or superseded since.          |

From `PlanStartDoorRefusalCode` (`packages/operator-core/lib/agent-tools/plans/start.ts`):

| code                        | meaning                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `spec_quality_not_current`  | The spec-quality scorecard is for an older spec set than the plan now has. |
| `claim_spec_binding_failed` | Linking a promoted work-item to its spec clause revisions failed.          |

### `plans:bind-spec-evidence`

From `InstrumentRefusalCode` (`packages/operator-core/lib/agent-tools/plans/instrument-provenance.ts`):

| code                            | meaning                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `instrument_undeclared`         | An `operational`/`manual` binding names no measuring instrument.                                   |
| `instrument_scratch_probe`      | The instrument is a scratch probe (for example under `.papercusp/scratch/`), not a committed test. |
| `instrument_outside_repo`       | The instrument path is outside the repository.                                                     |
| `instrument_not_committed`      | The instrument file is not committed.                                                              |
| `instrument_test_not_importing` | The instrument test does not import the code it claims to measure.                                 |
| `instrument_sibling_unpinned`   | The instrument lives in a sibling checkout whose commit is not pinned.                             |

From `BindSpecEvidenceRefusalCode` (`packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts`):

| code                                          | meaning                                                                                                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `derived_binding_invalid`                     | A binding derived from a test run is not valid for the clause.                                                                                                                                                                            |
| `mutation_target_rejected`                    | The mutation target named for the binding was rejected.                                                                                                                                                                                   |
| `declared_configuration_fingerprint_missing`  | The clause's source bar declares a `productionConfiguration`, but the bound test run has no valid configuration snapshot (no run, a NULL `test_runs.configuration_snapshot`, or a snapshot whose fingerprint does not recompute) (P-011). |
| `declared_configuration_fingerprint_mismatch` | The bound test run's configuration snapshot resolves a declared flag or env key differently from the bar's `productionConfiguration`; the refusal names the differing keys (P-011).                                                       |

From `WorkItemPlanItemRefusalStatus` (`packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts`):

| code                           | meaning                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_item_plan_item_mismatch` | The work-item was not promoted from the plan item that owns the clause revision, so the evidence is refused before any binding row is written. |

From `IndependentVerificationRefusalStatus` (`packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts`), returned as the result `status` (P-008, D-005):

| code                               | meaning                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified_binding_required`        | An `independent-verification` binding cites no implementer binding (`verifiesBindingId`).                                                                                                                                                                                                                                                                                          |
| `verified_binding_not_allowed`     | A binding of any other evidence kind carries `verifiesBindingId`.                                                                                                                                                                                                                                                                                                                  |
| `verified_binding_not_found`       | The cited binding does not exist, or is itself an independent-verification row.                                                                                                                                                                                                                                                                                                    |
| `independent_fingerprint_mismatch` | The re-observation's source or environment fingerprint differs from the cited binding's.                                                                                                                                                                                                                                                                                           |
| `fixture_absence_pairing_mismatch` | A review claiming fixture absence (`details.adequacy.fixtureFree=true`) does not pair with the cited binding on a key fixture-absence certification requires: author, spec revision, test run, source/test/environment/fixture fingerprints, or the cited `details.adequacy.testCases`. `mismatched` names each key, using the evaluator's own pairing rule (WI-6554700010018061). |

### `plans:set-plan-status`

Returned by `plans:set-plan-status { status:'shipped' }`. `bar_snapshot_*` codes arrive inside an `acceptance_bar_contract_not_ready` refusal.

From `PlanAcceptanceGateCode` (`packages/operator-core/lib/plan-acceptance-gate.ts`):

| code                                     | meaning                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance_rubric_missing`              | No acceptance rubric targets the plan. Author one with `rubrics:propose { kind:'acceptance', subjectPlan }`.                                                                                                                                                                                                        |
| `acceptance_rubric_ambiguous`            | More than one active acceptance rubric targets the plan. Retire all but one.                                                                                                                                                                                                                                        |
| `acceptance_rubric_unvetted`             | The rubric's current revision has no vetting attestation. Run `consult:get_feedback { policy:'rubric-vetting' }`, then attest with `scorecards:emit` against `meta-acceptance-rubric`.                                                                                                                              |
| `acceptance_rubric_revision_unreadable`  | The rubric's current revision could not be read, so vetting could not be checked. The gate refuses rather than pass.                                                                                                                                                                                                |
| `acceptance_rubric_vetted_after_grading` | The vetting attestation is newer than the independent grading it must precede. Re-grade the vetted revision.                                                                                                                                                                                                        |
| `acceptance_ungraded`                    | No independent grading of the current rubric revision. This call recruits a non-implementer grader.                                                                                                                                                                                                                 |
| `self_graded_only`                       | Every grading comes from the rubric author's spawn/rebind lineage. This call recruits a non-implementer grader.                                                                                                                                                                                                     |
| `acceptance_lineage_unreadable`          | The grader or author lineage could not be read, so independence could not be established.                                                                                                                                                                                                                           |
| `acceptance_bar_not_met`                 | The latest independent grading does not meet the rubric's passing bar.                                                                                                                                                                                                                                              |
| `acceptance_bar_contract_not_ready`      | The acceptance-bar contract snapshot has a blocking `bar_snapshot_*` code (table below). Repair those first. This refusal does not recruit a grader.                                                                                                                                                                |
| `acceptance_not_recorded`                | The implementer has not recorded an acceptance call. Re-emit the complete ratings with `acceptance:{ verdict, reasoning }`.                                                                                                                                                                                         |
| `acceptance_rejected`                    | The implementer's latest acceptance verdict is `reject`. Supersede it before shipping.                                                                                                                                                                                                                              |
| `acceptance_pending_delivery`            | Verdict `accept-pending-delivery` on a plan outside the acceptance-bar contract.                                                                                                                                                                                                                                    |
| `plan_items_unfinished`                  | Items are still `todo`, `blocked` or `needs-human`. Finish them, or drop them with `plans:set-status { status:'dropped', note }`.                                                                                                                                                                                   |
| `acceptance_unaudited`                   | No per-item code-truth audit. Run `plans:audit { slug, items }` with `code`/`test` citations.                                                                                                                                                                                                                       |
| `audit_coverage_stale`                   | The code-truth audit no longer covers the current items or the files it cited. Re-audit.                                                                                                                                                                                                                            |
| `audit_citations_unresolved`             | Audit citations do not resolve to repository paths. Only `code`/`test` citations with resolvable paths verify.                                                                                                                                                                                                      |
| `requirement_unrealized`                 | A requirement recorded `covered` at activation maps to an item audited with no verifying citation.                                                                                                                                                                                                                  |
| `code_deliverable_unverified`            | A code deliverable (declared, or the verification profile default) has no `code`/`test` audit citation that resolves against the tree. This holds in both profiles. Re-audit the item citing the files that implement it, or pass `force:{ reason }`, which waives it as a code-truth check and records the waiver. |
| `non_code_deliverable_code_evidence`     | A closed work item carries code-change evidence (a `filesChanged` list, or the `bug` kind) while its plan item now resolves to a non-code deliverable. `force` does not waive it.                                                                                                                                   |
| `non_code_deliverable_check_unavailable` | The ship-time read behind `non_code_deliverable_code_evidence` failed, so the check refuses instead of passing. Retry the ship; `force` does not waive it.                                                                                                                                                          |
| `ephemeral_deliverable_unbacked`         | The plan ships a report that exists only on a session- or account-local surface. Publish it durably first.                                                                                                                                                                                                          |
| `spec_proof_stale`                       | A spec clause's evidence was bound against an older clause revision or changed source. Re-bind.                                                                                                                                                                                                                     |
| `spec_clause_unproven`                   | A spec clause has no evidence binding at any revision. Bind evidence with `plans:bind-spec-evidence`.                                                                                                                                                                                                               |
| `design_evidence_unsatisfied`            | A ratified design reference lacks current passing `design-phase.compare_render` evidence.                                                                                                                                                                                                                           |
| `design_evidence_unavailable`            | Design evidence could not be read, so the design check could not run.                                                                                                                                                                                                                                               |
| `acceptance_authored_on_other_node`      | This node is a federated receiver of the plan's rubric. Ship and grade from the authoring node.                                                                                                                                                                                                                     |
| `independent_verification_missing`       | A mandatory `live`/`deployed` outcome bar has no `independent-verification` binding from outside the implementer lineage.                                                                                                                                                                                           |
| `independent_verification_unavailable`   | The gate could not read the scope, bindings or lineage for independent verification, and refused rather than guess.                                                                                                                                                                                                 |
| `spec_coverage_unavailable`              | The spec-coverage census could not run. Report-only: it never causes a refusal on its own.                                                                                                                                                                                                                          |

From `AcceptanceBarSnapshotCode` (`packages/operator-core/lib/acceptance-bar-contract-snapshot.ts`):

| code                                              | meaning                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bar_snapshot_source_unavailable`                 | A source the snapshot reads (plan, rubric, clauses, evidence or gradings) could not be read.                                                                                                                                                                                 |
| `bar_snapshot_source_truncated`                   | A source read hit its row cap, so the snapshot cannot claim to be complete.                                                                                                                                                                                                  |
| `bar_snapshot_plan_missing`                       | The subject plan was not found.                                                                                                                                                                                                                                              |
| `bar_snapshot_plan_ambiguous`                     | More than one plan matched the subject.                                                                                                                                                                                                                                      |
| `bar_snapshot_cohort_incomplete`                  | A plan adopted under the acceptance-bar contract epoch lacks a complete server-owned cohort or seed identity (cohort, seededAt, seededBy).                                                                                                                                   |
| `bar_snapshot_rubric_missing`                     | No acceptance rubric carries the plan's bars.                                                                                                                                                                                                                                |
| `bar_snapshot_rubric_unresolved`                  | The plan pins an acceptance rubric this read did not return. A failed lookup, not an absence: do not author a second rubric.                                                                                                                                                 |
| `bar_snapshot_rubric_ambiguous`                   | More than one rubric could carry the plan's bars.                                                                                                                                                                                                                            |
| `bar_snapshot_rubric_revision_mismatch`           | The plan's contract points at a different rubric revision than the current one.                                                                                                                                                                                              |
| `bar_snapshot_bar_set_empty`                      | The rubric has no acceptance bars.                                                                                                                                                                                                                                           |
| `bar_snapshot_bar_set_too_large`                  | The rubric has more bars than the contract allows.                                                                                                                                                                                                                           |
| `bar_snapshot_bar_key_duplicate`                  | Two bars share one key.                                                                                                                                                                                                                                                      |
| `bar_snapshot_bar_hash_missing`                   | A bar has no content hash.                                                                                                                                                                                                                                                   |
| `bar_snapshot_bar_hash_mismatch`                  | A bar's stored hash does not match its content.                                                                                                                                                                                                                              |
| `bar_snapshot_bar_set_hash_mismatch`              | The stored hash of the whole bar set does not match the bars.                                                                                                                                                                                                                |
| `bar_snapshot_bar_provenance_missing`             | A bar does not record where it came from.                                                                                                                                                                                                                                    |
| `bar_snapshot_mapping_missing`                    | A bar maps to no plan item.                                                                                                                                                                                                                                                  |
| `bar_snapshot_mapping_dropped_only`               | A bar maps only to dropped items, so nothing live delivers it.                                                                                                                                                                                                               |
| `bar_snapshot_projection_stale`                   | The bar's AUTO-BAR spec clause was seeded from an older version of that bar. Re-seed by amending the rubric.                                                                                                                                                                 |
| `bar_snapshot_clause_not_accepted`                | The bar's spec clause is still `draft` (or exempt, superseded, retired). AUTO-BAR clauses are seeded `draft`; certify them.                                                                                                                                                  |
| `bar_snapshot_method_missing`                     | A bar has no verification method.                                                                                                                                                                                                                                            |
| `bar_snapshot_work_contract_missing`              | No work-item is linked to the bar's clause revision.                                                                                                                                                                                                                         |
| `bar_snapshot_work_contract_stale`                | The linked work-item points at an older clause revision.                                                                                                                                                                                                                     |
| `bar_snapshot_proof_missing`                      | A bar has no evidence binding.                                                                                                                                                                                                                                               |
| `bar_snapshot_proof_stale`                        | A bar's evidence binding is for an older revision or changed source.                                                                                                                                                                                                         |
| `bar_snapshot_grading_missing`                    | No grading rates this bar.                                                                                                                                                                                                                                                   |
| `bar_snapshot_grading_stale`                      | The grading that rates this bar was made against an older rubric revision.                                                                                                                                                                                                   |
| `bar_snapshot_grading_not_pass`                   | The grading does not rate this bar as passing.                                                                                                                                                                                                                               |
| `bar_snapshot_vetting_missing`                    | The rubric revision carrying this bar is not vetted.                                                                                                                                                                                                                         |
| `bar_snapshot_vetting_stale`                      | The vetting attestation is for an older rubric revision.                                                                                                                                                                                                                     |
| `bar_snapshot_author_verdict_missing`             | The implementer has not recorded an acceptance verdict.                                                                                                                                                                                                                      |
| `bar_snapshot_author_verdict_stale`               | The implementer's verdict is for an older rubric revision or grading.                                                                                                                                                                                                        |
| `bar_snapshot_author_rejected`                    | The implementer's verdict is `reject`.                                                                                                                                                                                                                                       |
| `bar_snapshot_author_accepted_pending_delivery`   | The implementer's verdict is `accept-pending-delivery`: the contract has not been delivered yet.                                                                                                                                                                             |
| `bar_snapshot_falsifier_missing`                  | A bar's clause has no falsifier (what observation would show the bar is not met).                                                                                                                                                                                            |
| `bar_snapshot_role_invalid`                       | A bar's `role` value is not valid.                                                                                                                                                                                                                                           |
| `bar_snapshot_mandatory_invalid`                  | A bar's `mandatory` value is not valid.                                                                                                                                                                                                                                      |
| `bar_snapshot_scope_invalid`                      | A bar's `scope` value is not valid.                                                                                                                                                                                                                                          |
| `bar_snapshot_pending_delivery_selection_invalid` | The final accept's `pendingDeliveryBarKeys` names a BAR that is unknown or not eligible. Only existing deployed or live BARs whose check is `kind:"instrument"` with `instrumentKey:"none"` may be left pending delivery. Repair the request; no rubric amendment is needed. |
| `bar_snapshot_pass_ratings_invalid`               | A bar's `passRatings` value is not valid.                                                                                                                                                                                                                                    |
| `bar_snapshot_coverage_invalid`                   | A bar's coverage declaration is not valid.                                                                                                                                                                                                                                   |
| `bar_snapshot_check_missing`                      | A bar has no machine check.                                                                                                                                                                                                                                                  |
| `bar_snapshot_check_invalid`                      | A bar's machine check is malformed.                                                                                                                                                                                                                                          |
| `bar_snapshot_proof_uncertain`                    | The bar's evidence could not be judged adequate or inadequate.                                                                                                                                                                                                               |
| `bar_snapshot_proof_depth_missing`                | The clause declares no required test layers, so the evidence's depth cannot be judged.                                                                                                                                                                                       |
| `bar_snapshot_proof_inadequate`                   | The bar's evidence does not meet the clause's required test layers.                                                                                                                                                                                                          |
| `bar_snapshot_evidence_plane_unmet`               | A `deployed`/`live` bar has evidence only from the tree plane.                                                                                                                                                                                                               |
| `bar_snapshot_evidence_runtime_unmet`             | A `deployed`/`live` bar declares a runtime, and no current evidence was measured on it.                                                                                                                                                                                      |

### `plans:acceptance-disposition`

From `AcceptanceDispositionRefusalCode` (`packages/operator-core/lib/agent-tools/plans/acceptance-drain-disposition.ts`):

| code                                      | meaning                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `acceptance_disposition_kind_invalid`     | The disposition is not one of the allowed kinds. |
| `acceptance_disposition_evidence_missing` | The disposition has no evidence reference.       |
| `acceptance_disposition_reason_missing`   | The disposition has no reason.                   |
| `acceptance_disposition_no_filing`        | No acceptance-drain filing exists for the plan.  |

### `plans:set-status` (blind gap review)

From `BlindReviewGateCode` (`packages/operator-core/lib/blind-review-gate.ts`). Returned as `acceptanceBlocked` when an item flip drains a plan, as the drain sweep's skip reason, and by `plans:set-plan-status` at ship. Not waivable by `force`.

| code                               | meaning                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blind_review_missing`             | No blind gap review counts for the plan's latest activation audit: none was posted, or each poster read the plan's artifacts first, owns or implemented the plan, or shares an implementer's lineage. |
| `blind_review_gap_undispositioned` | A counted review has a gap with neither a non-dropped plan item nor an existing Decision recorded as an accepted risk.                                                                                |
| `blind_review_unavailable`         | The door could not read the plan, its activation audit, its reviews, the reviewer ledger or lineage, and refused rather than guess.                                                                   |

### `plans:promote`

From `ValRetirementRefusalCode` (`packages/operator-core/lib/agent-tools/plans/val-retirement.ts`):

| code                | meaning                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `val-block-retired` | The plan carries an inline VAL-\* assertion block. VAL-\* is retired: express it as a requirement-contract spec clause. |
| `val-write-retired` | A VAL-\* assertion write. VAL-\* assertions are retired.                                                                |
| `val-read-retired`  | A VAL-\* assertion read. VAL-\* assertions are retired.                                                                 |

## Tables

| table                                          | holds                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness_shared.harness_plans`                 | Plan content, status and decisions.                                                                                                                        |
| `harness_shared.plan_spec_clauses`             | One row per spec clause, with its current revision.                                                                                                        |
| `harness_shared.plan_spec_clause_revisions`    | Every clause revision: behavior, falsifier, required test layers, evidence plane, lifecycle, and the bar it was seeded from.                               |
| `harness_shared.spec_evidence_bindings`        | Evidence bound to a clause revision, with source and environment fingerprints.                                                                             |
| `harness_shared.work_item_spec_revision_edges` | Links between promoted work-items and the clause revisions they deliver.                                                                                   |
| `harness_shared.plan_audits`                   | Activation and per-item code-truth audits, with cited blob SHAs.                                                                                           |
| `harness_shared.rubric_amend_receipts`         | Receipts for acceptance-rubric amendments.                                                                                                                 |
| `harness_shared.work_items`                    | Work-items, scorecard cards, and acceptance-drain filings (a disposition is stored on the filing as `payload.acceptanceDisposition`).                      |
| `harness_shared.harness_plan_assertions`       | Retired VAL-\* assertions. No non-test source reads or writes it.                                                                                          |
| `harness_shared.plan_blind_reviews`            | Blind gap reviews (the gaps a reviewer who never read the plan found) and each gap's disposition to a plan item or an accepted-risk Decision. Append-only. |

Rubrics and scorecards are reached only through the `rubrics:*` and `scorecards:*` tools.

## Tools

| tool                                                   | use it to                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `plans:get-specs` / `plans:set-specs`                  | Read or write spec clauses.                                                                        |
| `plans:certify-spec-clauses`                           | Move draft clauses to accepted.                                                                    |
| `plans:evaluate-spec-quality`                          | Score the spec set (feeds the `plans:start` spec-quality gate).                                    |
| `plans:audit`                                          | Record the activation audit or the per-item code-truth audit.                                      |
| `plans:bind-spec-evidence` / `plans:get-spec-evidence` | Bind or read clause evidence.                                                                      |
| `plans:evaluate-spec-test-adequacy`                    | Judge whether bound tests meet the required layers.                                                |
| `plans:acceptance-bar-census`                          | See the acceptance-bar contract state across plans.                                                |
| `rubrics:propose` / `rubrics:amend`                    | Create the acceptance rubric, or amend its bars to as-built.                                       |
| `consult:get_feedback`                                 | Vet a rubric (`policy:'rubric-vetting'`) or critique bars (`policy:'bar-critique'`).               |
| `scorecards:emit`                                      | Attest vetting, grade a rubric, or record the implementer's acceptance verdict.                    |
| `plans:set-plan-status`                                | Ship; on `acceptance_ungraded` or `self_graded_only` it recruits a non-implementer grader for you. |
| `plans:acceptance-disposition`                         | Record a typed decision on a stale awaiting-acceptance plan.                                       |
| `plans:blind-review`                                   | Get the blind brief (the owner's turns only), post a blind review's gaps, or disposition each gap. |

## Evidence kinds

`SPEC_EVIDENCE_KINDS` in `packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts` is the source of truth.

| kind                       | what it is                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `test`                     | A committed test that exercises the clause.                                                                          |
| `fixture`                  | A committed fixture the clause's test relies on.                                                                     |
| `coverage-census`          | A census showing every member of a population is covered.                                                            |
| `mutation`                 | A mutation probe showing the guarding test fails when the behavior breaks.                                           |
| `counterexample`           | An executable bad case the guarding test must reject; like `mutation`, it shows the test can fail.                   |
| `check`                    | A machine check result.                                                                                              |
| `manual`                   | A recorded manual observation, with a committed instrument.                                                          |
| `operational`              | A measurement of a running system, with a committed instrument.                                                      |
| `independent-verification` | A non-implementer's re-observation of an implementer binding; it cites that binding and must match its fingerprints. |

## Keeping this page true

Add a new contract refusal code to an exported typed union, and register the union in `CONTRACT_GATE_CODE_TYPES`. Then add the code to the table above and a test that asserts on it. The doc-claims test fails until all three exist. A door module that returns a refusal literal outside every registered union also fails that test, unless the literal is classified in `OPERATIONAL_DOOR_CODES` as an operational (not contract) refusal.

## Retired VAL verification surfaces

The legacy `harness-test-gate`, `harness-test-rollup` and `done-without-test-detect` modules have been removed. Inline VAL-\* assertions and the `harness_tests` join no longer decide completion. SUCCESSOR SIGNAL: spec-test-adequacy — `specTestAdequacyCompletionGate` in `packages/operator-core/lib/agent-tools/work_items/spec-test-adequacy-gate.ts` enforces the requirement contract at `work_items:complete`. Plan-item provenance remains in `plan-item-provenance.ts`; cross-layer usage and stale acceptance are reported by `verification.health`. The surviving `agent-tools/plans/val-retirement.test.ts` suite checks that the removed surfaces remain absent, the old gate and collector are not registered, and the successor still runs at completion.
