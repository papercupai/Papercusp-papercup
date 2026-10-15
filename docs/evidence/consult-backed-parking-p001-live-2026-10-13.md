# Consult launch-attempt records: live census (P-001)

Plan: `consult-backed-parking-2026-10-12`, item P-001. Work item: `WI-6554700010009489`.
Clause: `SPEC-P-001` r1. When an agent consult selects at least one expert, the consult records a launch attempt for every selected expert.
Diagnosis and durable fix: `WI-6554700010009204` (done).

Measured 2026-10-13T00:34Z by su-a2d144e1 on the staging operator `:3170`, whose `/api/health` reported sha `8a48ea8e80`.
At the same time, `:3070` reported sha `d740fc3802`, which is stale main and does not carry the fix.

## Instrument

The committed program is `packages/operator-core/lib/consult/consult-routing-health.ts`.
It is exposed as the tool `consult:routing-health`, and its committed test is `consult-routing-health.test.ts`.
It was called with `{ since: "2026-10-12T00:00:00Z" }` through
`node scripts/mcp-call.mjs consult:routing-health --port 3170`.
The run scanned 322 consults (`bounded.truncatedByLimit: false`).

## Request cohort (request time, 2026-10-12T00:00Z to 2026-10-13T00:34Z)

| policy | requests | dispatch requested | retrieval-only | legacy intent unknown | received | unavailable | failed | pending | unmeasured |
|---|---|---|---|---|---|---|---|---|---|
| acceptance-bar-amendment-review | 39 | 13 | 0 | 26 | 2 | 9 | 2 | 0 | 0 |
| bar-critique | 5 | 5 | 0 | 0 | 4 | 1 | 0 | 0 | 0 |
| consult-default | 80 | 8 | 2 | 70 | 4 | 3 | 0 | 1 | 0 |
| totals | 124 | 26 | 2 | 96 | 10 | 13 | 2 | 1 | 0 |

All 26 dispatch-requested consults have a measured dispatch outcome, and none is `unmeasured`.
The 2 retrieval-only consults never dispatch, by design (`get-feedback-core.ts`, `retrievalOnly`).

## Where the remaining no-record consults come from

`harness_shared.consult_state` was joined to the `consult:get_feedback` row in `harness_shared.tool_invocations` for each consult, matching on requester and a ±2-minute window. The join shows the following:

- Since 2026-10-12T18:00Z, every consult with selected experts and an empty `dispatch_attempts` was served by `port-3070` at `d740fc3802`. That stale-main build stamps no `deliveryIntent`, and these consults make up the 96 legacy rows above.
- Over the 48 hours to 00:34Z, `port-3170` served 4 such consults. Three are `deliveryIntent: retrieval-only`, which is correct. The fourth is a `bar-critique` consult at 2026-10-11T17:34Z on build `c7ef831c06`, whose preparation lease expired before any dispatch was recorded.
- Since 2026-10-12T00:00Z, no consult served by `:3170` has selected experts and a dispatch intent but no attempt record.

## What this does not establish

`:3070` still serves stale main, so production consults are not yet covered. The behaviour reaches `:3070` only when the green checkpoint promotes main.
This census covers this workspace only. Launch failures (`launch-failed`, `kickoff-not-persisted`) are recorded attempts. Whether those launches succeed belongs to P-002 and P-003, not this clause.
