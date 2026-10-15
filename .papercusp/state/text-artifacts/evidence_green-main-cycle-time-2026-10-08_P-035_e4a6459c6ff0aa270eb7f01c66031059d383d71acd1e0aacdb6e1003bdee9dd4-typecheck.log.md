---
rel_path: "evidence/green-main-cycle-time-2026-10-08/P-035/e4a6459c6ff0aa270eb7f01c66031059d383d71acd1e0aacdb6e1003bdee9dd4-typecheck.log"
updated_at: 1792018285279
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=apps/operator/lib/release/green-checkpoint.ts,apps/operator/lib/release/green-checkpoint.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-10-14T22:32:11.697Z head=497e7b9ded scope=files files=2
  checked files : apps/operator/lib/release/green-checkpoint.ts
                 apps/operator/lib/release/green-checkpoint.test.ts
LINT_TSC_CROSS_LEG checked=1 clean=lint:tsc red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).

→ 2 of the file(s) you named are outside `operator-core` — ROUTING them to the gate that owns them.
   `--files=` scopes this gate's VERDICT; it does not widen what tsc compiles.

   AUTO-ROUTING to check them:  npm run lint:tsc:operator -- --files=apps/operator/lib/release/green-checkpoint.ts,apps/operator/lib/release/green-checkpoint.test.ts
     - apps/operator/lib/release/green-checkpoint.ts
     - apps/operator/lib/release/green-checkpoint.test.ts


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc:operator
> node scripts/lint-tsc-operator.mjs --files=apps/operator/lib/release/green-checkpoint.ts,apps/operator/lib/release/green-checkpoint.test.ts

LINT_TSC_RUN_STAMP label=operator at=2026-10-14T22:37:45.460Z head=497e7b9ded scope=files files=2
  checked files : apps/operator/lib/release/green-checkpoint.ts
                 apps/operator/lib/release/green-checkpoint.test.ts
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=41 named=2 typeReferencing=0 importers=39 errors=4 queuedMs=23637 checkMs=6564 snapshotAgeMs=6564
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator: 4 type errors across 2 file(s) (baseline total 28) [--files]
✓ 3 file(s) below baseline — NOT locked in. Re-run with --update on a quiet tree to lower them deliberately:
   apps/operator/lib/release/green-checkpoint.test.ts: 18 → 3  (-15)
   apps/operator/lib/release/release-profile.test.ts: 9 → 1  (-8)
   apps/operator/lib/release/green-checkpoint-real-deps.test.ts: 1 → 0  (-1)
LINT_TSC_RESULT label=operator scope=files exit=0 status=clean at=2026-10-14T22:37:45.460Z head=497e7b9ded
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=routed at=2026-10-14T22:32:11.697Z head=497e7b9ded

