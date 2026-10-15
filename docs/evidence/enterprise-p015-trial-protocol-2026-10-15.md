# P-015 synthetic corpus and measurement protocol

15 October 2026 · WI-6554700010014498 · preparation for WI-10007910

The fixture `packages/operator-core/lib/blueprint/fixtures/support-workflow-trial-cases.ts` supplies 30 varied, labelled synthetic support cases using the existing P-012 operation contract. This is preparation for D-010/A-9 internal simulation. It records no executed model output, reviewer decision, timing, accepted outcome, cost, customer evidence or trial success. ENT-P-015-OUTCOME revision 2 remains a manual, attributable trial disposition; passing the fixture tests cannot satisfy it.

## Before starting the trial

Verify P-010 and P-012 readiness by reference and pin the current-build runtime, approved operation revision and fixture file hash. Record a trial start/end window, named operator, employee principal and a distinct authorized internal reviewer principal. Record the finite funded allocation and its enforced reservation/outcome path. The assumed maximum window is 14 days and setup/incident investigation is bounded to four staff-hours (pilot contract A-9); record consumed effort as it occurs.

Preregister A-8 from `enterprise-assumed-profile-2026-10-13.md`: at least 30 comparable cases; at least 80% accepted outputs; median review time at least 30% below the comparable baseline; access closure within 60 seconds of accepted revocation; finite funded spend; passing restore exercise. These thresholds precede the trial. A measured failure produces continue/narrow/stop with reasons; it cannot be omitted from the denominator or relabelled passed.

Call `supportWorkflowTrialCases(actualApprovedRevision)`. Import only its two permitted documents per case through the maintained corpus fixture path in the private trial workspace. Put `deniedDocument` in a separate scope denied to the employee/worker and retain its canary for hostile checks. Keep `reviewerOnlyOracle` with the reviewer; do not inject it as an answer or send the denied source to the model. Documents are synthetic input. The oracle is an expected diagnostic fact, not evidence of a successful workflow.

## Execute and retain actual evidence

Measure a comparable manual baseline on these cases before assisted results can bias the reviewer. Record the same timing boundary and task definition for baseline and assisted review, the actual actor, start/end timestamps and clock/unit. Counterbalance case order where feasible and disclose learning/order effects. If a baseline cannot be measured, record unknown and do not assert the 30% threshold.

Use the authenticated employee's actual Workflows/blueprint entry path and current ACL adapter. Retain operation handle, approved revision, selected document ids, result fingerprint, actual cited output, policy decision, reservation and known/unknown settlement references. Then use the distinct authorized reviewer to accept/reject/rework the exact fingerprint, recording reasons, review time and subsequent rework time. Repeated use must be observed as a later dated submission, never inferred from corpus size.

Keep per-case receipts in existing operation/business-review, audit and outcome-cost surfaces. An export may index those references with the case id and `internal-simulation` label; do not introduce a second approval, outcome or billing store. Unknown final provider bills or absent human measurements remain unknown. Record setup effort, support incidents and measured failure/recovery receipts separately. Preserve legitimate and hostile controls: self-review/foreign workspace, revoked source and restricted canary, stale revision/fingerprint, denied action, finite budget, stop/restart, promotion/rollback and restore.

Stop immediately for unauthorized action, ACL breach, restricted-canary disclosure or a time/effort/spend boundary. Register and assign any concrete defect before repair. Resume only with a verified fix and its guard; retain failed cases and the original receipts. Produce the P-015 disposition from actual comparable receipts and preregistered A-8 thresholds, with missing/failed prerequisites explicit. P-023 separately needs an attributable owner acceptance record; P-024 verifies the final exact artifact.

## Fixture verification boundary

`support-workflow-trial-cases.test.ts` runs in the canonical Vitest suite. It checks 30 unique cases, disjoint source ids, explicit synthetic labels, compatibility with existing public/private input schemas, revision/action refusals, citation-boundary counterexamples and independence between fixture instances. It does not exercise server ACLs, model execution, budget enforcement, real review authorization or trial thresholds. Those are P-012/P-015/P-022 operational obligations.
