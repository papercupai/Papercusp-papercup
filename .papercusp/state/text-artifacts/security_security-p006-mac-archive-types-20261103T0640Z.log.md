---
rel_path: "security/security-p006-mac-archive-types-20261103T0640Z.log"
updated_at: 1793688420543
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-03T06:34:38.835Z head=99b719f4dd scope=files files=1
  checked files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=0859f890-f5ea-4371-9ef2-1a49f0c90506 resultOrigin=pending
⚠ TSC_SERVICE request failed at /run/user/1000/papercusp-tsc-service.sock (no answer within 30000 ms requestId=0859f890-f5ea-4371-9ef2-1a49f0c90506) — running the full operator-core compile instead. state=timed-out resultOrigin=full-compile-required
[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 2705439, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 2705439, slots=1)
[pc-heavy] still queued (30s elapsed, pid 2705439, slots=1)
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=5 admittedCgroupMiB=22348 admissionId=pc-heavy-2705439-1793687776165089239 retryHandle=psi-recovery:pc-heavy-2705439-1793687776165089239 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2705439-1793687776165089239 retryHandle=psi-recovery:pc-heavy-2705439-1793687776165089239 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 306 type errors across 139 file(s) (baseline total 224) [--files]
✓ The current --mine dirty set is tsc-clean. 0 baseline-regressed file(s) are outside that set:
   (Not gated under --mine. The shared git-status set can include other sessions' dirty edits;
    use --files= for explicit attribution.)
    A bare npm run of this gate will still catch these for whoever owns them.
   ⚠ 65 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/agent-tools/testing/managed-test-process.test.ts: 0 → 5  (+5)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/verification-attempts/attempt-ledger.integration.test.ts: 0 → 1  (+1)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/agent-tools/capability/launch-agent.ts: 0 → 76  (+76)  ← UNCHANGED 484min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)  ← UNCHANGED 1125min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)  ← UNCHANGED 612min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/spec-evidence-store.test.ts: 0 → 8  (+8)  ← UNCHANGED 527min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/git_sync/run.ts: 0 → 7  (+7)  ← UNCHANGED 629min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)  ← UNCHANGED 1598min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/rubric-rescore-schedule.test.ts: 0 → 4  (+4)  ← UNCHANGED 629min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/service-memory-attribution.integration.test.ts: 0 → 4  (+4)  ← CLEAN ERROR SITE; causal origin unresolved while 41 other path(s) are uncommitted
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)  ← UNCHANGED 802min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/launch-agent.test.ts: 0 → 3  (+3)  ← UNCHANGED 484min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/__tests__/run.integration.test.ts: 0 → 3  (+3)  ← UNCHANGED 921min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)  ← UNCHANGED 1016min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)  ← UNCHANGED 525min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-get.test.ts: 0 → 2  (+2)  ← UNCHANGED 1306min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 2  (+2)  ← UNCHANGED 339min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts: 0 → 2  (+2)  ← UNCHANGED 309min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)  ← UNCHANGED 1549min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)  ← UNCHANGED 8073min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)  ← UNCHANGED 484min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 291min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 200min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)  ← UNCHANGED 1311min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/source-preview-export.test.ts: 0 → 2  (+2)  ← CLEAN ERROR SITE; causal origin unresolved while 41 other path(s) are uncommitted
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 1  (+1)  ← CLEAN ERROR SITE; causal origin unresolved while 41 other path(s) are uncommitted
   packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.test.ts: 0 → 1  (+1)  ← UNCHANGED 527min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/acceptance-bar-seed.ts: 0 → 1  (+1)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-facts/owner-identity.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 3240min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)  ← UNCHANGED 85748min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)  ← UNCHANGED 1038min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet_registry/status.test.ts: 0 → 1  (+1)  ← UNCHANGED 1417min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts: 0 → 1  (+1)  ← UNCHANGED 844min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)  ← UNCHANGED 432min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 681min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 1550min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)  ← UNCHANGED 1171min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)  ← UNCHANGED 2506min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/sessions/digest.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 246min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/checkpoint.test.ts: 0 → 1  (+1)  ← CLEAN ERROR SITE; causal origin unresolved while 41 other path(s) are uncommitted
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 8905min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-discovery-source.test.ts: 0 → 1  (+1)  ← UNCHANGED 3240min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-brief.test.ts: 0 → 1  (+1)  ← UNCHANGED 802min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)  ← UNCHANGED 1036min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/consult/acceptance-bar-amendment-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 372min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/consult/consult-dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 156min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts: 0 → 1  (+1)  ← UNCHANGED 58min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)  ← UNCHANGED 291min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 695min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)  ← UNCHANGED 695min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)  ← UNCHANGED 112min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/git-pipeline-position.test.ts: 0 → 1  (+1)  ← UNCHANGED 1311min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/session-interruption-runtime.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 1037min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)  ← UNCHANGED 229min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/result-door.test.ts: 0 → 1  (+1)  ← UNCHANGED 119min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/rubrics-legacy-probe-amend.test.ts: 0 → 1  (+1)  ← UNCHANGED 849min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)  ← UNCHANGED 567min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)  ← UNCHANGED 525min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 571min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)  ← UNCHANGED 1025min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/testing-run-store.ts: 0 → 1  (+1)  ← UNCHANGED 1179min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-admission/lifecycle.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 1602min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-items-events.test.ts: 0 → 1  (+1)  ← UNCHANGED 849min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 59 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
   ⚠ 4 of them was/were COMMITTED IN THE LAST 20 MINUTES — this may be a LANDING
   RACE rather than a standing red. git-sync commits this whole shared tree on a schedule, so ONE
   logical multi-file change routinely lands across TWO ticks; in between, the tree holds a
   half-landed change that fails to typecheck and belongs to nobody.
   BEFORE FILING A BUG: re-run this check in a few minutes and see if it clears itself.
   If the message above names a symbol defined in ANOTHER file, that is the signature — check when
   that file landed:  git log -1 --format=%ci -- <the file defining that symbol>
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-03T06:34:38.835Z head=99b719f4dd

