---
rel_path: "security/security-p006-mac-archive-types-final-20261103T0642Z.log"
updated_at: 1793688420543
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/release/tauri-update-authorization-native.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-03T06:41:49.175Z head=4b3b39bc9c scope=files files=1
  checked files : packages/operator-core/lib/release/tauri-update-authorization-native.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=039fcfb0-47f4-4dc4-a083-9ba78c5c258b resultOrigin=pending
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=0 refreshMs=8146 checkMs=10065 snapshotAgeMs=10065
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-03T06:41:49.175Z head=4b3b39bc9c

