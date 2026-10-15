# Recommended improvements to get_feedback and the shared relevance router

Owner correction (2026-10-08): `session_turn:codex:01a11971-3adc-7420-be12-467f04fe8c82:22` removes `consult:reconcile` entirely. The historical recommendation in section 4 is superseded: remove the tool and mandatory reporting obligations, preserve existing records, and assess quality from existing project evidence without an extra reporting call. The approved implementation plan records this as D-008.

I would prioritise reliable delivery, trustworthy measurement, and evidence-backed expertise selection. Adoption already doubled; increasing invocation volume is not the immediate bottleneck.

This is a proposal, not an implementation or deployment claim. It builds on the seven-day assessment in docs/evidence/get-feedback-router-assessment-2026-10-08.md (assessment WI-10007395; report rpt_80682b92-1dd0-47c1-8a2d-a63030bb39f3). Current source and existing remediation items were read again for this recommendation.

## 1. Repair answering-session launch and make requests recoverable

88% of recorded failure events concern native kickoff or launch preparation. Complete the existing reachability work (WI-10005889) and its native/source/backend matrix before treating a spawn registration as delivery.

Record concrete boot refusal causes and stage durations. Preflight known source/backend incompatibility, account walls, evidence availability, and the exact serving runtime before launching; use the existing dispatcher eligibility checks and cooldowns. Preserve exact-source evidence and isolation guarantees.

Keep the interactive request bounded: once a consultation is durably accepted, return its conversation identity and explicit pending status while a managed, recoverable dispatch step continues. Reuse existing consultation/task infrastructure after checking its fit. Define ownership, restart recovery, cancellation and duplicate-prevention together. Returning pending is not the same as delivering an answer.

Current source already has get_feedback abort-completion receipts that recover the persisted conversation identity after a late handler completion. Verify those on the served build and test caller retry behaviour. Prevent duplicate requests when the first call persisted but its response timed out.

Acceptance: conventional native launch tests across supported source/backend combinations; timeout-after-persistence and process-restart tests; one request remains one conversation; each accepted dispatch reaches an answer, explicit unavailability/decline, or recorded terminal failure. Increasing timeouts alone would leave the defect class intact.

## 2. Instrument every shared-router caller and report request-level outcomes

Instrument the shared routeConsult seam, including routes that throw before any consult row exists. Attribute caller/workflow and selection policy separately, and correlate route, conversation, attempt, source evidence, serving build and result.

Measure embedding, retrieval/ranking, eligibility/preflight, launch, native kickoff, first answer and total time separately. Include cancellation/deadline stage. This is how we identify the slow stage behind the 10.4% execution timeout rate without guessing.

Extend the existing routing snapshots, dispatch records and telemetry rather than creating a parallel analytics system. Verify the existing requestCohort implementation is served, then expose distinct denominators for request receipts, launch attempts, declines, pending, unavailability, retrieval-only and unmeasured legacy intent. Receipt must survive a later lifecycle transition. Show missing records and bounded scans.

Acceptance: a route-only caller, a dispatch caller, an embedding fallback, a thrown route, and a multi-attempt request each produce correctly attributed evidence. One request with three failed attempts and a final answer is one delivered request, not three failed requests.

## 3. Make expert selection depend on problem-specific evidence

The confirmed soleOwner/sole-live-gate mismatch cleared the relevance floor despite unrelated indexed evidence. Raising a global similarity threshold would not be a justified fix from one example.

Extend existing subjectRef and authorship signals for explicitly identified files, symbols and durable subjects. Check whether candidate evidence covers the actual problem and operation; distinguish directly demonstrated expertise from adjacent history or a generalist fallback. Avoid universally requiring exact token overlap, which would discard useful conceptual and cross-domain matches.

Use a bounded reranking/evidence-validation step where the existing retrieval/evaluation surfaces fit. Treat this as a tested hypothesis, with cost and latency limits. Preserve lineage/exclusion rules and honest below-floor labelling.

Add the observed collision (EI-25385908361333552), additional lookalike terminology, genuine conceptual matches, older experts and no-expert cases to a labelled dataset. Reuse search-core relevance metrics and conventional router tests. Track top-choice precision, top-three recall and unsupported expertise claims per workflow, not just similarity scores. Tune using a training set and verify on held-out cases.

Acceptance: the gate-ownership evidence no longer qualifies as demonstrated desktop-registry expertise, while genuine desktop and conceptual positives still route. Reproduce against the containing build before declaring the historical production mismatch fixed.

## 4. Measure whether advice helped, with little caller overhead

Extend existing consult:reconcile rather than inventing another feedback system. When the requester next consumes a reply or finishes the associated work, make confirmed/rescoped/reversed/moot plus one concrete sentence easy to record. Unknown remains unknown; silence must not be inferred as agreement.

Keep direct expertise relevance, answer correctness, actionability and requester decision impact separate. Use a stratified sample including declines and unanswered requests, not only successful threads. Some advice merely confirms a good decision; that can still be useful.

Report request-to-useful-answer rate, time to first useful answer, and cost per useful answer alongside delivery. Define useful from recorded requester impact plus independently checked samples; no proxy based solely on answer length, nonempty posts or successful tool returns.

Acceptance: feedback evidence persists through reply/close/expiry, genuine reversals can be recorded, and missing follow-through is explicit. This builds on WI-10005886 and the blocked native/usefulness acceptance work WI-10005891.

## 5. Reduce caller-contract mistakes and verify served generations

5.3% of recorded invocations were invalid input. Render concise call examples from the live schema, using current tried/observed/decision_at_stake fields. Make creation versus conversation reading clear. Supply exact field-specific remedies for unsupported keys and text-length limits.

Verify consumers and generated guidance against the served contract, not only checkout source. Keep build attribution in reliability reports, and test completion-receipt/requestCohort behaviour on the exact containing runtime. Source items being done does not establish shipment.

Acceptance: conventional guidance/contract tests cover the observed mistakes and supported fields; useful context can be supplied within the contract; no silent truncation or schema-guessing aliases.

## Proposed bar and sequence

Suggested initial reliability target: under 1% technical request failures, reported separately for every caller/policy with sample sizes and a consistent observation window. This is a proposed target, not an achieved result. Track median and p95 acknowledgement and useful-answer latency separately. Every accepted request should have a recoverable identity and explicit disposition; no duplicate consultation after a timeout.

Implement launch repair and measurement together; verify the served request/receipt fixes; then run the labelled ranking evaluation and utility sample. Integrate these extensions into get-feedback-reliability-usefulness-adoption-2026-10-03 and its existing work rather than starting an overlapping program. Only expand adoption prompts once reliability and measured usefulness improve.

Verification for this proposal: inspected saved assessment, current get_feedback binding and abort-completion receipt, shared router subject/score paths, dispatcher failure handling, routing-health request/launch schemas, existing relevance-evaluation module and live remediation item states. No implementation tests were run and no product source changes were made.

Published report: `rpt_49133c8e-ca0c-42bd-acc9-6239058ded28`. Publisher-returned path: `/reports/rpt_49133c8e-ca0c-42bd-acc9-6239058ded28`. Independently read back with reports:get; native UI delivery was not asserted.
