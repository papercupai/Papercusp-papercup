---
rel_path: "verification/WI-6554700010016963/2026-10-17-admission-types-185.log"
updated_at: 1792277332000
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/dream/dream-config.ts,packages/operator-core/lib/dream/dream-cycle-action.ts,packages/operator-core/lib/dream/dream-cycle-action.test.ts,packages/operator-core/lib/dream/dream-cycle-production.test.ts,packages/operator-core/lib/dream/dream-control-observations.ts,packages/operator-core/lib/dream/dream-control-observations.test.ts,packages/operator-core/lib/gym/autoloop-tick.ts,packages/operator-core/lib/gym/__tests__/autoloop-tick.test.ts,packages/operator-core/lib/harness/routines/gym-actions.ts,packages/operator-core/lib/autoloop.ts,packages/operator-core/lib/autoloop-state.integration.test.ts,packages/operator-core/lib/owner-steering.ts,packages/operator-core/lib/owner-steering.test.ts,packages/operator-core/lib/sync-resolver/index.ts,packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts,packages/operator-core/lib/dream/dream-admission-background.integration.test.ts,packages/operator-core/test/_dream-admission-background-child.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-10-17T22:39:48.486Z head=6d864c64eb scope=files files=17
  checked files : packages/operator-core/lib/dream/dream-config.ts
                 packages/operator-core/lib/dream/dream-cycle-action.ts
                 packages/operator-core/lib/dream/dream-cycle-action.test.ts
                 packages/operator-core/lib/dream/dream-cycle-production.test.ts
                 packages/operator-core/lib/dream/dream-control-observations.ts
                 packages/operator-core/lib/dream/dream-control-observations.test.ts
                 packages/operator-core/lib/gym/autoloop-tick.ts
                 packages/operator-core/lib/gym/__tests__/autoloop-tick.test.ts
                 packages/operator-core/lib/harness/routines/gym-actions.ts
                 packages/operator-core/lib/autoloop.ts
                 packages/operator-core/lib/autoloop-state.integration.test.ts
                 packages/operator-core/lib/owner-steering.ts
                 packages/operator-core/lib/owner-steering.test.ts
                 packages/operator-core/lib/sync-resolver/index.ts
                 packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts
                 packages/operator-core/lib/dream/dream-admission-background.integration.test.ts
                 packages/operator-core/test/_dream-admission-background-child.ts
LINT_TSC_CROSS_LEG checked=3 clean=lint:tsc:operator-vite,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:orchestrator
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
⚠ TSC_SERVICE declined (scope-too-wide: 10366 files (limit 1500); a full compile is cheaper) — running the full operator-core compile instead.
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2623792-1792276815244795553 retryHandle=psi-recovery:pc-heavy-2623792-1792276815244795553 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
⚠ 1 named file(s) were NOT typechecked: absent from the actual operator-core compiler program.
   - packages/operator-core/test/_dream-admission-background-child.ts
TSC operator-core: 225 type errors across 100 file(s) (baseline total 225) [--files]
   ⚠ 1 file(s) have hard-failing TS1xxx diagnostics but are NOT in the set you named — not gating this run, but tsc's counts for other files may be incomplete while these stay broken:
     - packages/operator-core/lib/agent-mcp-client.ts  ← COMMITTED: a standing red that WILL red the fleet at the next bare run
✓ Your changed files are tsc-clean. 0 file(s) already in the baseline regressed but are not in your changed set:
   (Not gated under --mine. Note the changed set comes from git status, and git-sync auto-commits this tree
    every few minutes — so a file you edited a while ago can appear here. Use --files= to scope precisely.
    A bare npm run of this gate will still catch these for whoever owns them.)
   ⚠ 28 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/agent-tools/capability/vm-copy-authority-bridge.integration.test.ts: 0 → 4  (+4)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts: 0 → 22  (+22)  ← UNCHANGED 3200min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/connected-apps/scope-enforcement.test.ts: 0 → 18  (+18)  ← UNCHANGED 7074min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/affected-tests-graph-suggestions.test.ts: 0 → 9  (+9)  ← UNCHANGED 442min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-mcp-client.ts: 0 → 8  (+8)  ← UNCHANGED 55115min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/agent-mcp/src/server.ts: 0 → 6  (+6)  ← UNCHANGED 8506min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/spec-evidence-store.integration.test.ts: 0 → 6  (+6)  ← UNCHANGED 1185min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-uds.ts: 0 → 6  (+6)  ← UNCHANGED 3605min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/__tests__/mcp-uds.test.ts: 0 → 5  (+5)  ← UNCHANGED 49068min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-mcp-client.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 15572min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-mcp-format-parity.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 55203min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/docs/__tests__/public-manual-mcp.e2e.test.ts: 0 → 4  (+4)  ← UNCHANGED 14395min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/su-session-stdio-peer.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 22776min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/connected-apps/mcp-oauth.integration.test.ts: 0 → 3  (+3)  ← UNCHANGED 24299min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/launch-cost/carry-cohort-driver.ts: 0 → 3  (+3)  ← UNCHANGED 30218min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts: 0 → 3  (+3)  ← UNCHANGED 1383min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/su-session-attached-live.integration.test.ts: 0 → 3  (+3)  ← UNCHANGED 8598min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/tooldef-mcp/src/uds-transport.ts: 0 → 3  (+3)  ← UNCHANGED 49068min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/fair-comparison-engines.ts: 0 → 2  (+2)  ← UNCHANGED 16659min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-initialize-enrich.test.ts: 0 → 2  (+2)  ← UNCHANGED 40850min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts: 0 → 2  (+2)  ← UNCHANGED 993min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/gitnexus-recovery.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 30179min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/gitnexus-relationship-readers.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 17079min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/omp-plugin/src/native-extension.ts: 0 → 1  (+1)  ← UNCHANGED 55216min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/pty.test.ts: 0 → 1  (+1)  ← UNCHANGED 11905min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts: 0 → 1  (+1)  ← UNCHANGED 1062min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/fleet/spawner-sidecar-spawn.test.ts: 0 → 1  (+1)  ← UNCHANGED 371min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/with-test-pg-cleanup.test.ts: 0 → 1  (+1)  ← UNCHANGED 30min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 27 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=1 at=2026-10-17T22:39:48.486Z head=6d864c64eb

