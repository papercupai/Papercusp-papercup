---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/doc-source-20261025-a/typecheck.log"
updated_at: 1792966078142
_body: "content"
---


[capability:bash] JOB PHASE: phase=unit-runner-started at=1792965874935

[capability:bash] JOB PHASE: phase=payload-spawn-requested at=1792965874937

[capability:bash] JOB PHASE: phase=payload-spawned at=1792965874944

[capability:bash] JOB PHASE: phase=payload-first-byte at=1792965905566
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts --all-errors
LINT_TSC_RUN_STAMP label=operator-core at=2026-10-25T22:04:35.578Z head=17cf04f31c scope=files files=1
  checked files : packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=3051 checkMs=6369 snapshotAgeMs=6369
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-25T22:04:35.578Z head=17cf04f31c
TSC_SERVICE state=accepted requestId=079861f9-21d2-4c33-9f31-8cdd4732d718 resultOrigin=pending

[capability:bash] JOB PHASE: phase=payload-closed at=1792965905938

[capability:bash] JOB END: status=completed exit=0 at 2026-10-25T22:05:05.938Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.

[capability:bash] JOB TIMING: spawn_requested_at=1792965874805 spawn_returned_at=1792965874858 client_spawned_at=1792965874861 first_pipe_byte_at=1792965905575 ended_at=1792965906033

[capability:bash] JOB END: status=completed exit=0 at 2026-10-25T22:05:06.033Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death.

