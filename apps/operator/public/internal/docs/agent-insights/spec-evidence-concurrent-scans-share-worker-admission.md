# Concurrent evidence reads must share the AST worker admission budget
URL: /internal/docs/agent-insights/spec-evidence-concurrent-scans-share-worker-admission

A per-invocation row mapper cannot enforce a process-wide AST worker budget. Schedule before reading source text, and test overlapping positive and negative cohorts.

## Failure and cause

Evidence reads can fail with `tree-scan worker admission limit reached` even when one isolated evidence cohort passes. `listSpecEvidence` bounds rows within each invocation, while `cpu-task-worker.ts` reserves its tree-scan requests across the process before its first await. Overlapping invocations therefore exceed a budget that neither local mapper can see. This is an admission-scope mismatch; the error alone is not evidence of host resource pressure.

## Repair

`broadRepoTreeScanGuard` uses one module-wide limiter from the already-installed `p-limit` package, with the existing `TREE_SCAN_MAX_REQUESTS` safety bound. Acquire its slot before reading source text. Waiting closures retain root, commit and path rather than full source strings. Preserve the raw worker's source bound, request refusal, deadline, error propagation and prohibition on inline fallback.

Committed scan reuse within one evidence read remains useful, but does not replace coordination between separate reads. An isolated successful retry is a positive control, not proof that concurrent callers are repaired.

## Recurrence guard

The conventional `spec-evidence-store.test.ts` suite runs two simultaneous seven-binding cohorts for both ordinary tests and broad repository census tests. Ordinary rows must be measured. Census rows must retain the specific `repo_measurement_broad_tree_scan_requires_source_globs` refusal. Neither case may fail through incidental worker admission. The CPU-worker suite separately preserves raw worker safety, including refusal of an excess raw request.

WI-6554700010021444 records the causal before/after evidence: both concurrent cases failed before the shared scheduler; isolated committed verification at `d314d294adc6a84c94bb63878e2c1a046be78e35` passed 349 store, 33 certifier and 36 CPU-worker tests, with zero skips. Exact ledger rows are 21801653, 21801654 and 21801652 respectively. Logs: `/tmp/identity-21444-concurrent-before.log` and `/tmp/identity-21444-global-committed-d314.log`.

## Runtime verification boundary

A committed test pass does not prove a serving API loaded the repair. Select the maintained `operator-api` route using `dev:pipeline_position`, establish exact store-blob containment in that API runtime, and then issue overlapping evidence reads through it. Record runtime identity and measured responses. A background host containing the blob does not qualify the API route. Runtime acceptance remains open on WI-6554700010021444 until those checks are recorded.
