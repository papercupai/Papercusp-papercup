# Green-main acceptance proposal: original producers and remaining proof gaps

Status: **proposal, unapproved**. This is review input, not an amended rubric or acceptance result.

Work: WI-6554700010010682. Subject: `green-main-cycle-time-2026-10-08`. Author: su-c05233eb-d1be-4e44-b16e-51d9d3532894. Baseline read: subject revision 126 and acceptance rubric `acceptance-green-main-cycle-time-2026-10-08` revision 5. Read both revisions again before any compare-and-swap mutation. The old v6 payload is invalid and must not be applied.

## Outcome and preserved requirements

Avi's plan requires main to recover within 4h typical, p90 at most 8h; repair rounds at most 45min; no idle repair queue beyond 60min without an actuator; and an alarm within one tick when a shipped gate mechanism stops working. P-018 requires seven consecutive days of live passes. P-006 separately requires the same full gate file set to finish in at most 50% of its baseline wall time. P-005 also requires at least five consecutive repair rounds with median at most 45min. No requirement is waived by this proposal.

The audience is the independent acceptance reviewer and the agents implementing this plan. The problem is that a unit pass, a reconstructed history, or a recent generic operational pass cannot prove these runtime outcomes. The proposed outcome is acceptance bound to the original populations, original clocks, and measured serving runtimes. Non-goals: current gate control, deployment, new infrastructure, or changing the execution route.

## Reused producers

All producers below reuse `executeOperationalRun` in `packages/operator-core/lib/agent-tools/testing/record-run.ts` and `harness_shared.test_runs`. They query original `pipeline_events`; they do not fire a checkpoint or operate the live repair queue.

| Outcome | Existing source and native executor | Required passing assertion identities |
| --- | --- | --- |
| Red-to-green recovery | `release/green-main-slo.ts`, `executeGreenMainRecoveryWindow` | `bounded-recovery-window`, `complete-recovery-population`, `qualified-recovery-verdicts`, `recovery-left-boundary-known`, `all-red-episodes-closed`, `nonempty-recovery-sample`, `recovery-median-at-most-4h`, `recovery-p90-at-most-8h` |
| Original admitted work, including pending work | `release/green-main-slo.ts`, `executeGreenMainAdmissionWindow` | `bounded-admission-window`, `complete-admission-snapshot-population`, `original-complete-admission-chains`, `admission-lifetimes-cover-window-end`, `nonempty-admission-round-population`, `admission-rounds-at-most-45min`, `all-admission-rounds-have-verdicts`, `at-least-five-consecutive-admission-rounds`, `admission-round-median-at-most-45min` |
| Completed round clocks | `release/green-main-slo.ts`, `executeGreenMainRepairRoundWindow` | Preserve its complete original-round assertions as additional evidence; it cannot replace admission/pending-work coverage. |
| Idle actuator | `release/idle-repair-queue-actuator.ts`, `executeIdleQueueActuatorWindow` | `bounded-idle-actuator-window`, `complete-idle-actuator-population`, `original-idle-actuator-receipts`, `continuous-idle-actuator-observations`, `nonempty-idle-actuator-episodes`, `idle-actuator-action-at-most-60min` |
| Seven-day invariants | `release/gate-live-invariants.ts`, `executeGateInvariantWindow` | `seven-day-invariant-window`, `complete-invariant-population`, `exact-seven-invariant-identities`, `pass-only-invariant-history`, `hourly-invariant-history-coverage` |
| Original breach filing | `release/gate-live-invariants.ts`, `executeGateInvariantAlarmWindow` | Require the executor's complete original-filing assertion set. This proves filing after the first observed breach; it does not prove malfunction onset, human delivery, or pickup. |

All source paths in the table are relative to `packages/operator-core/lib/`.

The admission producer preserves exact original head chains and timestamps, rejects reconstructed or conflicting histories, and keeps retirement distinct from a verdict. Multiple admissions consumed by one descendant verdict count as one round. Five consecutive rounds mean five distinct consecutive verdict ordinals in one queue chain, not five admissions or five panel samples.

The invariant producer requires all seven named invariant identities, pass-only results, an exact seven-day interval, a complete scoped population, and bounded hourly gaps. Missing, unknown, trimmed, gapped, or conflicting history fails. Historical observations cannot be manufactured from the current queue.

## Receipt binding to specify before amendment

An operational criterion must require all of the following, not merely `status='pass'`:

1. Exact workspace `papercusp-workspace`, harness `papercusp`, and intended install scope.
2. The committed producer definition path, `framework='operational'`, `source='local'`, and `run_group_id` beginning `operational-native:`. Archived caller-authored receipts cannot substitute.
3. The native execution detail's complete passing assertion identities for that producer, zero failed/skipped cases, no collection failure, and no truncation of those identities.
4. A clean, stable source snapshot and an exact commit identity. Keep saved local tests as local tests when their provenance is unknown.
5. Measured runtime observations before and after execution with the same fingerprint and the exact required runtime units. Missing or changed runtime observations are unproven.
6. The same explicit original window, complete population identity, and source/runtime scope across the Goal's history components. A six-hour fresh receipt is not six hours of operational history.
7. Native original-event identities and population hash. Read and compare the original input when reviewing coverage; an asserted hash alone does not certify completeness.

The existing structured `check:{kind:'probe',all:[...]}` form can require multiple SQL checks without adding an instrument, table, tool, service, or routine. Final SQL must be validated against the current ledger writer and native execution serializer. Do not bind to the v6 draft's future `docs/evidence/*.json` paths: they are not actual producers.

## Decisions required in the single outside-lineage review

**Typical recovery.** The native recovery evaluator uses the median for “typical” and nearest-rank p90. The thresholds remain 4h and 8h. This statistical interpretation requires an explicit ruling; it is not yet approved by this document.

**Strict idle deadline.** The Goal says no idle time beyond 60min without actuation; R-1's trigger fires after 60min on the next tick. The original-history evaluator currently measures a successfully completed action by the strict 60min deadline. Adding one tick of grace would weaken the Goal and is not approved. The reviewer must identify whether the implementation needs an earlier trigger or the source requirements need an owner decision. Keep the strict deadline until resolved.

**Alarm onset and proof windows.** An original filing clock measured from the first observed breach does not establish when the underlying mechanism stopped working. A healthy, pass-only seven-day invariant window may contain no breach episodes, while the filing evaluator requires a nonempty breach population. Specify separate, genuine alarm exercise evidence and its onset/cadence clocks rather than forcing a fabricated breach into the pass-only soak or silently accepting an empty alarm population.

**Open rounds.** Preserve original admitted and unfinished work in the Goal's round population. A completed-round-only population can hide work that never reaches a verdict. The reviewer must certify boundary coverage and pending-retirement behavior, not only the median of finished rounds.

## Other mandatory acceptance work

- **R-12 / P-006:** the current canonical item WI-10007629 is blocked and unassigned. Its saved comparison covers a limited file set and does not prove the full-gate 50% target. Its checkpoint retains a typed runtime prerequisite `runtime:/tmp/pcv/fs-mutex-locks`. Do not replay historical jobs or run a full benchmark until the actual prerequisite and readiness are established. A real paired full-population producer and its immutable inputs, repeated timings, original run identities, child/cgroup containment, longest-first scheduling, headroom, memory-refusal and exact no-skip accounting still need verification. Do not replace the criterion with a generic passing row or a unit test.
- **P-028:** the private natural-exit fixture's saved pass proves its one integration. A queued wake with `pickupConfirmed:false` is not pickup. Keep actual pickup and the required cadence as separate acceptance evidence.
- **R-11 / P-007:** preserve the compound admission safety contract atomically, including within-cap precheck and over-cap attribution. Verify current clause coverage rather than splitting away a difficult branch.
- **P-028 through P-034:** current first-class behavioral clauses and required evidence must cover each active item. Do not infer coverage from implementation prose.
- **D-045 / P-030:** final shipment requires real primary and capacity-fallback fixer first requests against the exact shipped artifact, with spawn/request/account identity and measured serving-runtime fingerprint. A current-build fixer pass does not establish shipment or every blueprint role.
- **D-045 / P-031:** preserve the exact resource UUID and caller build, distinguishing historical cause evidence, durable class guard and real-suite recurrence proof. Existing cleanup code or old passing tests alone do not settle the historical claim.
- **Activation audit:** re-read the complete original source ranges and newer owner-backed requirements; carry M-001 through M-011 forward with their exact references; repair shaping, requirement and provenance omissions before recording a new audit. Existing audit revision 51 is not current revision 126.

The live gate remains with its registered owner. P-005/P-018 and P-030/P-031 retain their separately staffed implementation lanes. This proposal does not change claims, route, thresholds, or plan state.

## Verification and delivery state

The latest admission/pending-round local unit/real-PG verification is 112 passes (93 unit and 19 PostgreSQL), exact 3/3 files, zero skips/substitutions, plus a clean focused five-file typecheck. Those saved tests are local evidence only; source provenance was unknown after HEAD moved during the run. Earlier local histories and their saved checks remain on the umbrella checkpoint. No fresh test rerun, live operational pass, whole-Goal acceptance, or shipment is claimed here.

Next: validate this proposal's source identities and receipt contract, recover the complete activation source conversation, resolve the actual P-006 prerequisite and producer gap, then submit one complete amended criterion set for independent outside-lineage review. Only an approved, current-revision amendment may be applied, vetted, bound to proof and graded.
