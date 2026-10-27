---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/memory-handler-source-20261026/final-r4/scoped-tsc.log"
updated_at: 1793039437682
_body: "content"
---

LINT_TSC_RUN_STAMP label=operator-core at=2026-10-26T18:26:43.349Z head=0c72d7862b scope=files files=1
  checked files : packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=6270 checkMs=7716 snapshotAgeMs=7716
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-26T18:26:43.349Z head=0c72d7862b

