---
rel_path: "security/security-p006-candidate-types-20261103T0437Z.log"
updated_at: 1793680996232
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-03T04:34:40.542Z head=716bbb36bf scope=files files=1
  checked files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=e4487f53-723d-4bed-a405-8d8c1ae7d508 resultOrigin=pending
⚠ TSC_SERVICE request failed at /run/user/1000/papercusp-tsc-service.sock (no answer within 30000 ms requestId=e4487f53-723d-4bed-a405-8d8c1ae7d508) — running the full operator-core compile instead. state=timed-out resultOrigin=full-compile-required
[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 374053, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 374053, slots=1)
[pc-heavy] still queued (30s elapsed, pid 374053, slots=1)
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=17 admittedCgroupMiB=45586 admissionId=pc-heavy-374053-1793680651797009475 retryHandle=psi-recovery:pc-heavy-374053-1793680651797009475 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-374053-1793680651797009475 retryHandle=psi-recovery:pc-heavy-374053-1793680651797009475 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 304 type errors across 138 file(s) (baseline total 224) [--files]
✓ The current --mine dirty set is tsc-clean. 0 baseline-regressed file(s) are outside that set:
   (Not gated under --mine. The shared git-status set can include other sessions' dirty edits;
    use --files= for explicit attribution.)
    A bare npm run of this gate will still catch these for whoever owns them.
   ⚠ 64 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/source-preview-export.test.ts: 0 → 2  (+2)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/agent-tools/capability/launch-agent.ts: 0 → 76  (+76)  ← UNCHANGED 366min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)  ← UNCHANGED 1007min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)  ← UNCHANGED 493min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/spec-evidence-store.test.ts: 0 → 8  (+8)  ← UNCHANGED 408min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/git_sync/run.ts: 0 → 7  (+7)  ← UNCHANGED 511min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/managed-test-process.test.ts: 0 → 5  (+5)  ← UNCHANGED 191min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)  ← UNCHANGED 1479min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/rubric-rescore-schedule.test.ts: 0 → 4  (+4)  ← UNCHANGED 511min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)  ← UNCHANGED 683min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/launch-agent.test.ts: 0 → 3  (+3)  ← UNCHANGED 366min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/__tests__/run.integration.test.ts: 0 → 3  (+3)  ← UNCHANGED 802min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)  ← UNCHANGED 898min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)  ← UNCHANGED 407min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/compaction-compliance-watchdog.test.ts: 0 → 3  (+3)  ← UNCHANGED 71min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-get.test.ts: 0 → 2  (+2)  ← UNCHANGED 1188min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 2  (+2)  ← UNCHANGED 220min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts: 0 → 2  (+2)  ← UNCHANGED 191min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)  ← UNCHANGED 1431min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)  ← UNCHANGED 7955min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)  ← UNCHANGED 366min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 172min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 81min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)  ← UNCHANGED 1193min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 1  (+1)  ← UNCHANGED 129min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.test.ts: 0 → 1  (+1)  ← UNCHANGED 408min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/acceptance-bar-seed.ts: 0 → 1  (+1)  ← UNCHANGED 1329min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-facts/owner-identity.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 3121min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)  ← UNCHANGED 85630min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)  ← UNCHANGED 920min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 1329min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet_registry/status.test.ts: 0 → 1  (+1)  ← UNCHANGED 1298min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)  ← UNCHANGED 1329min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts: 0 → 1  (+1)  ← UNCHANGED 726min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)  ← UNCHANGED 314min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 562min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 1432min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)  ← UNCHANGED 1052min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)  ← UNCHANGED 2388min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/sessions/digest.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 128min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/checkpoint.test.ts: 0 → 1  (+1)  ← UNCHANGED 38min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 8787min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-discovery-source.test.ts: 0 → 1  (+1)  ← UNCHANGED 3121min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-brief.test.ts: 0 → 1  (+1)  ← UNCHANGED 683min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)  ← UNCHANGED 918min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/consult/acceptance-bar-amendment-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 254min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/consult/consult-dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 38min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/consult/consult-verbs-core.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 2373min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)  ← UNCHANGED 172min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 576min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)  ← UNCHANGED 576min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/git-pipeline-position.test.ts: 0 → 1  (+1)  ← UNCHANGED 1193min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/session-interruption-runtime.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 919min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)  ← UNCHANGED 111min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/result-door.test.ts: 0 → 1  (+1)  ← CLEAN ERROR SITE; causal origin unresolved while 67 other path(s) are uncommitted
   packages/operator-core/lib/rubrics-legacy-probe-amend.test.ts: 0 → 1  (+1)  ← UNCHANGED 731min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)  ← UNCHANGED 448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)  ← UNCHANGED 407min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 453min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)  ← UNCHANGED 906min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/testing-run-store.ts: 0 → 1  (+1)  ← UNCHANGED 1061min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-admission/lifecycle.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 1483min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-items-events.test.ts: 0 → 1  (+1)  ← UNCHANGED 731min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 61 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
   ⚠ 1 of them was/were COMMITTED IN THE LAST 20 MINUTES — this may be a LANDING
   RACE rather than a standing red. git-sync commits this whole shared tree on a schedule, so ONE
   logical multi-file change routinely lands across TWO ticks; in between, the tree holds a
   half-landed change that fails to typecheck and belongs to nobody.
   BEFORE FILING A BUG: re-run this check in a few minutes and see if it clears itself.
   If the message above names a symbol defined in ANOTHER file, that is the signature — check when
   that file landed:  git log -1 --format=%ci -- <the file defining that symbol>
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-03T04:34:40.542Z head=716bbb36bf

