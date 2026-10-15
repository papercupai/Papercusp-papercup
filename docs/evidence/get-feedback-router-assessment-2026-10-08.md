# get_feedback adoption and shared relevance-router assessment — 2026-10-08

Adoption is growing quickly and the system produces useful advice, but end-to-end reliability is not yet good and the observed error rate is not low. Semantic availability has improved substantially. Ranking accuracy remains uncalibrated, and this assessment found a concrete above-floor expertise mismatch.

Assessment work: WI-10007395. Workspace: papercusp-workspace. Primary snapshot: 2026-10-08T04:50:26.967Z. Main window: [2026-10-01T04:50:26.967Z, 2026-10-08T04:50:26.967Z); comparison: the preceding seven days. Findings describe the served production population across recorded runtimes, not a certification of unshipped checkout changes.

## Adoption

| Measure | Last seven days | Previous seven days |
|---|---:|---:|
| Recorded consult:get_feedback invocations | 562 | 256 |
| Distinct recognised agent callers | 223 | 101 |
| Successful tool returns | 474 | 216 |
| Error/timeout returns | 55 | 18 |
| Invalid-input returns | 30 | 20 |
| Replayed returns | 3 | 1 |

Previous-week calls also include one role-not-allowed return. Every status therefore reconciles to the respective total.

Calls increased 119.5%, and distinct callers increased 120.8%. In the current week, 556 calls were classified call_origin=agent. Among 2,318 distinct recognised agents with model-origin tool activity in this window, 223 called get_feedback (9.6%). This is observed activity penetration, not a census of eligible agents or a target adoption rate. The identity predicate is the database's existing is_agent_coord_owner_id(coord_owner_id, role), which excludes non-agent principals.

Standard/default calls account for 342 invocations by 193 agents; rubric-vetting accounts for 220 by 78 agents. These caller sets overlap. Standard/default usage includes workflow-triggered consultations, so it is not a measured count of wholly discretionary requests.

The consult-state ledger contains 848 newly opened threads in this window: 343 ordinary/default, 199 rubric-vetting, 239 acceptance-BAR amendment reviews, and 67 acceptance-grading threads. These are not the same denominator as MCP calls: internal review callers also open consultations through the shared production binding. Conversation producer attribution puts 781 threads under consult:get_feedback and 67 under acceptance-gate:grading-cascade.

## Tool reliability and latency

| Invocation class | Valid execution calls (ok + error + timeout) | Errors/timeouts | Rate |
|---|---:|---:|---:|
| All get_feedback | 529 | 55 | 10.4% |
| Standard/default | 324 | 13 | 4.0% |
| Rubric-vetting | 205 | 42 | 20.5% |
| Previous week, all | 234 | 18 | 7.7% |

All 55 current-week execution failures have timeout status and the same recorded message: tool consult:get_feedback exceeded timeout of 60s (handler returned but signal had aborted). This establishes the dispatch deadline mechanism; it does not isolate the underlying slow stage or prove that consultation side effects were absent. Current dispatch code explicitly distinguishes a handler returning after an abort from a successful result.

The 55 timeouts are 9.8% of all 562 invocations. Separately, 30 invalid-input refusals are 5.3%; examples include unsupported context/conversation_id keys and questions beyond the served 2,000-character limit. Those are caller-contract failures, not router backend errors.

For valid execution calls, median handler duration was 22.7 seconds and p95 168.0 seconds, compared with 15.6 seconds and 69.2 seconds previously. duration_ms is the recorded handler/dispatch duration, not an independently measured user-visible response time. Long completions after the timeout signal account for why recorded durations can exceed the nominal 60-second limit. No resource-contention cause was inferred.

Served generations are mixed. For example, port-3070/d740fc3802 accounts for 261 calls and 36 timeouts; port-3070/f52b2457ba accounts for 73 calls and five timeouts. These are bounded leading groups, not a complete host census. Source changes and focused tests in staging cannot by themselves establish that these production failures are fixed.

## Shared router delivery across workflows

The purpose-built consult:routing-health reader was inspected before its numbers were used. Its main window is a launch-time cohort, and its failed count includes pre-launch attempts as well as launched sessions whose answer window failed. Failed MUST NOT be divided by launched and called an error percentage.

| Selection policy | Launched answering sessions | Answered | Declined | Recorded failures | Hung | Pending |
|---|---:|---:|---:|---:|---:|---:|
| Ordinary/default (including applicable plan/goal consults) | 238 | 182 | 42 | 277 | 8 | 3 |
| Rubric-vetting | 260 | 228 | 9 | 266 | 5 | 1 |
| Acceptance-BAR amendment review | 128 | 111 | 17 | 51 | 0 | 0 |
| Acceptance grading | 88 | 55 | 11 | 127 | 7 | 0 |
| Grading-integrity audit | 0 | 0 | 0 | 0 | 0 | 0 |
| Total | 714 | 576 | 79 | 721 | 20 | 4 |

576/714 launched sessions posted answers (80.7%). That is evidence of useful eventual delivery after launch, not an 80.7% request success rate: it excludes paths that never launched, and one request can launch several sessions.

Of the 721 recorded failures, 315 are kickoff-not-persisted and 320 launch-failed: together 88.1% of the failure records. The remainder are answer-window-expired 15, answer-window-converted 20, answer-pickup-stalled 35, and first-turn-rejected 16. Bounded attempt-detail reads show native kickoff-proof timeouts and agent commands dying during boot with exit 1 or 2. These locate the recorded failure stage at launch/native preparation; they do not prove one common root cause for all boot failures.

There were also 1,676 skipped ranks, including account-walled 274, evidence-span-unavailable 342, conversion-unavailable 320, fork-unsupported 320, source-session-untracked 134, and other source eligibility reasons. Skips are not automatically errors; some are correct safety/eligibility exclusions. They nevertheless contribute to routing cost and exhausted paths.

The seven-day health read was not census-truncated, scanned 903 consult rows, and reported no capped dispatch logs. 235 scanned rows had no dispatch records. The scan includes older threads eligible to launch within the window, so its 903 rows differ from the 848 request-time threads. Zero grading-integrity launches here is a measured window result, not evidence that that caller is healthy.

A separate health read for the last 24 hours returned 107 launches, 84 answers, 95 failure records, one hung session, and four pending sessions. Launch friction therefore persists in the recent window.

## Request receipts: do not trust lifecycle labels as delivery verdicts

I independently joined typed responder posts and structured/archive answers to request-time threads. A nonempty answer/new_fact from someone other than the requester counts as recorded feedback; an answer is not thereby graded correct or useful.

| New request population | Requests | At least one recorded answer |
|---|---:|---:|
| Ordinary/default, all intents | 343 | 133 |
| Rubric-vetting | 199 | 157 |
| Acceptance-BAR amendment review | 239 | 112 |
| Acceptance grading | 67 | 43 |

Ordinary/default includes 32 explicitly retrieval-only requests, only one of which has an answer receipt. Excluding those leaves 132/311 (42.4%) with recorded answers. However, 212 ordinary/default threads have legacy unknown intent. The clean explicit-dispatch subset is 64/99 (64.6%). Explicit-dispatch subsets for rubric vetting and BAR review are 20/25 and 9/27 respectively. These small, recent subsets are descriptive; do not substitute them for the older full cohort without disclosing the different population.

Across all policies, 320 threads had recorded answers despite a later expired or no_qualified_responder state: ordinary 89, rubric vetting 121, BAR review 89, acceptance grading 21. Such state labels cannot be treated as equivalent to never answered. Conversely, successful tool returns do not prove an answer was delivered.

The live routing-health endpoint returned launch metrics without the newer requestCohort object present in the inspected checkout. That is why this assessment calculated request receipt cohorts from the underlying records. The existing request-intent/health work WI-10005848 is recorded done, but that does not imply every served generation exposes it.

## Relevance and answer quality

Semantic availability improved: persisted embed-unavailable snapshots fell from 114/626 requests (18.2%) to 9/848 (1.1%). This measures the recorded embedding-degradation marker, not ranking correctness. Embedding failures can become lexical fallback rather than tool errors, so a low exception rate would not establish semantic health by itself.

For current-week requests, ordinary/default had candidates in 338/343 and selected responders in 324/343; rubric vetting in 198/199 for both; acceptance grading in 67/67 for both. BAR amendments had candidates/selection in 155/239 after their independence/eligibility screening. No selection in these stored snapshots used via:minimum. Above-floor qualification is therefore common, but it is not a measured precision score.

I inspected the first answer excerpts from the two latest answered threads in each of four policies (eight threads), read the two referenced BAR approval payloads, and read eight recent requester reconciliation notes. This is a bounded qualitative sample, not a random helpfulness study or an independent correctness audit.

Evidence of useful results:
- Rubric-vetting post1163591 identified current revision/Decision coverage and detector-binding defects and explicitly refused attestation rather than rubber-stamping the rubric.
- Rubric-vetting post1163506 separated method text from actually bound checks and identified missing inverse Decision traceability.
- Acceptance-grading posts1163082 and1163045 provided criterion-level conclusions, evidence boundaries, and owned residuals.
- Ordinary reconciliation notes confirmed concrete fixes such as converting a known rubrics:amend validation rejection in its narrow adapter while preserving genuine handler errors, and changed one storage:usage investigation's scope to the shared result-door writer.
- BAR feedback posts1163693 and1163535 are approval pointers, not prose answers; their referenced payloads1163644 and1163522 resolve to exact rubric/bar hash approval records. Those should be evaluated by their approval contract rather than answer length.

A concrete ranking defect:
- Request conv-muyxqsn4-0000-6d6a167746834bdb94ecdec2e0f9692f asked about desktop_sessions_live_display_uq, computer:provision_desktop, and soleOwner reconciliation.
- Its second selected expert was labelled via:floor with similarity0.695982, relevance0.585290, and floor0.411765.
- The exact indexed evidence turn01a116f9-b314-7c00-898d-5ef99d8e95aa#3 says only that the agent is the sole live gate lane and will not run/monitor a checkpoint. It contains neither the desktop constraint nor provisioning identifier.
- Typed reply1163634 explicitly recognised that the carried transcript was unrelated gate-ownership history. It still produced useful advice by reading current source and labelling first-principles reasoning.

This is an observed expertise-selection mismatch. Its global frequency is unknown, and the precise scoring correction has not been validated. It is filed and self-assigned as EI-25385908361333552; the capture warns that served code can lag staging, so reproduction on the containing current build remains necessary.

Usefulness remains undermeasured. 172 current-week threads have reconciliation records, and many delivered answers have no recorded requester follow-through. A recorded confirmed or rescoped disposition is useful evidence about caller action, not independent proof of correctness. No comprehensive labelled expert-ranking accuracy or downstream helpfulness rate was established.

## Other caller coverage and remaining limits

Current source uses routeConsult directly in the get_feedback production binding, plan-start consultation, activation readiness, acceptance-grader discovery, and scout goal consultation. Other review paths reuse getFeedbackProd. The source inspection confirms shared mechanism reuse; it does not create runtime coverage.

The plan-start metadata writer records checkpointConsult/checkpointVerdict. A bounded seven-day query found 70 recorded nudge outcomes, all with successful tool returns. A nudge establishes that candidates were presented; it does not establish that a consultation happened, helped, or that every plans:start call executed the router.

There is no complete per-router-invocation population in the evidence inspected that separates route computation failures/latency from embedding, dispatch and caller workflow failures across all these entrypoints. I therefore cannot honestly give one global error rate for the shared router, or claim that unobserved scout/activation/grading-integrity paths work well.

The existing remediation plan get-feedback-reliability-usefulness-adoption-2026-10-03 already covers native reachability, request intent, reconciliation, guidance, and live usefulness proof. Its source/backend reachability item WI-10005889 is open; usefulness/matrix item WI-10005891 and final acceptance item WI-10005892 are blocked. This assessment does not substitute for their native matrix or final shipment proof.

Recommended priorities: finish the existing native kickoff/boot reachability work and measure timeout stages; make request-time delivery and utility visible on the served health surface; add the evidenced soleOwner/gate-ownership collision to a labelled router regression set; measure ranking and downstream utility per caller. Reuse the existing router, dispatch ledger, requestCohort and reconciliation surfaces.

## Evidence and verification

Source readers/writers inspected:
- packages/operator-core/lib/consult/consult-routing-health.ts: launch cohorts, request receipts and follow-through semantics.
- packages/operator-core/lib/consult/relevance-router.ts: embedding fallback, score/floor qualification, persisted evidence.
- packages/operator-core/lib/consult/get-feedback-prod.ts: production binding and conversation producer.
- packages/operator-core/lib/consult/consult-expiry-core.ts: cascade-flavor classification.
- packages/operator-core/lib/consult/selection-policies.ts: policy identities and bounds.
- packages/operator-core/lib/agent-tools/plans/start.ts: checkpoint metadata writer.
- libs/generic/tooldef/src/dispatch-stack.ts: invocation status and timeout-after-handler semantics.
- apps/operator-docs/src/content/docs/agent-insights/consult-spawn-runtime-mcp-pin.mdx: existing native/runtime boundary work.

Live reads: consult:routing-health(168h), consult:routing-health(24h), bounded dev:pg_query aggregations and exact-record joins over tool_invocations, consult_state, consult_post_meta, coord_conversations, coord_thread_posts and selected session_turns. Schema reads preceded interpretation. All published census tables were checked for truncation and exact status/policy partitions; bounded samples are explicitly marked. The runtime group listing and attempt error examples are samples, not censuses.

No product source edits, new consultation launches, live gate operations or deployment actions were performed. This was an observational assessment; no test suite was run or claimed as implementation verification. Follow-up precision defect EI-25385908361333552 remains owned and open.

Published report ID: `rpt_80682b92-1dd0-47c1-8a2d-a63030bb39f3`. Publisher-returned path: `/reports/rpt_80682b92-1dd0-47c1-8a2d-a63030bb39f3`. The report was independently read back through `reports:get`; native UI delivery was not asserted. Current checkout UI selects a report at `/reports?sel=rpt_80682b92-1dd0-47c1-8a2d-a63030bb39f3`.

