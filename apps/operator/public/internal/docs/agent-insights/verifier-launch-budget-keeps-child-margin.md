# Verifier launch budgets must retain the child admission margin
URL: /internal/docs/agent-insights/verifier-launch-budget-keeps-child-margin

Reserve preparation consumption and recalculated child work together, while preserving absolute deadline, source and cleanup guards.

Verifier preparation and child admission use the same absolute task deadline. A snapshot can consume more preparation time and also increase the cleanup reserve used by the next admission. Launch forecasting must account for both effects.

The existing `estimateVerifierCommandBudget` helper in `scripts/source-preview.mjs` now budgets the child margin before applying the preparation allowance:

```js
const remainingBudgetMs = Math.ceil(remainingMs * 1.25);
const totalMs = Math.ceil((preparationMs + remainingBudgetMs) * 1.25);
```

Use the helper's `requiredTimeoutMs` as the native task timeout and pass the complete prior phase journal through `--budget-from`. Keep an explicit child estimate and the launch reserve. The absolute deadline, full source and dependency checks, and protected cleanup floor remain authoritative. Forecasts remain estimates; actual admission can still refuse when observations exceed their allowance.

The recurrence guard lives in `packages/operator-core/lib/source-preview-export.test.ts`, case `reserves preparation growth together with the child reforecast margin before launching`. It increases observed preparation phases by 25%, requires the original launch envelope to admit the recalculated child budget, and separately verifies that a truly insufficient deadline is still refused.

Measured in managed-carry P-006: preparation task `0mvkqkuwjfhhv20565r` stopped before tests with 2,415,399 ms remaining against a 2,432,200 ms requirement. Its cleanup completed and its private root was removed. The new regression failed on the old formula and passed after the fix; nine focused budget cases passed. The source/test fix was byte-verified in commit `afe9d2e1ae751fbbf6786356db53947f90548340`. Audit thread post `1199882` on `EI-26738310281499847` preserves the complete comparison and local-proof limitations.

A preparation refusal supplies no test verdict. Preserve its native log, phase journal and task cleanup receipt; reconcile the durable task before another attempt. Do not bypass the guards or mistake an empty redirected capability log for a failed process. Current qualification status belongs on the work-item, not in this runbook.
