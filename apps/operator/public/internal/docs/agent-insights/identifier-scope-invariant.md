# The identifier-scope invariant: an id that leaves its scope must be unique or carry its scope
URL: /internal/docs/agent-insights/identifier-scope-invariant

Normative rule: any id that appears in prose, coord messages, carry notes, or an API that accepts it bare MUST be globally unique or carry its scope; a lookup that cannot tell must refuse, never pick. Incidents EI-8805, EI-6843, WI-10006010; how each id scheme complies.

# The identifier-scope invariant

> **Rule.** An identifier that appears in prose, a coord message, a carry note, a checkpoint, or an API that accepts it without its scope MUST be globally unique, or it MUST carry its scope. A lookup that is handed an id it cannot resolve to exactly one thing MUST refuse and name the candidates. It must never pick one.

"Scope" is the narrowest scope inside which the database guarantees the id names one thing. The per-scheme census is [identifier schemes and their true uniqueness scope](/internal/docs/agent-insights/identifier-uniqueness-scopes).

Every `P-NNN` on this page is an item of plan `scope-unique-identifiers-2026-07-26`.

## Why: three incidents with the same shape

Each of these is an id that was unique only inside a scope, used where that scope was not known.

* **EI-8805, silent checkpoint loss.** `work_items:checkpoint` on a work item reported ok, with a length, and the checkpoint then read back null. Continuity state was lost with no error. Plan item P-005 added the regression: a checkpoint for an id held by two harnesses of one workspace now stays on the row it was written to.
* **EI-6843, migration collision.** Agents picked the next migration number by listing `sql/` by eye, and concurrent agents picked the same number. Fixed by the atomic allocator `scripts/next-migration.mjs`. See [migration number collisions](/internal/docs/agent-insights/migration-number-collisions-and-reservation-dx).
* **WI-10006010, twin rows rewritten.** `work_items:complete { harness }` wrote every physical row that shared the `feature_id`. Closing `operator:<ws>` slug twins as dropped flipped 3 `papercusp` twins from done to dropped and overwrote their terminal fields.

In every case the writer and the reader each resolved the id correctly inside a scope, but not the same scope, and nothing reported the mismatch.

## Two ways to comply

**1. Make the id globally unique.** Then it can travel bare.

| Scheme                                           | How it is unique                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EI-` + snowflake                                | Unique by construction.                                                                                                                                                                                                            |
| Owner and session ids (`su-` + uuid), memory ids | UUIDs.                                                                                                                                                                                                                             |
| New `F-FIX` / `F-IDEA` ids                       | Time-plus-random tail from `packages/operator-core/lib/collision-resistant-id.ts` (P-005).                                                                                                                                         |
| `WI-` + number                                   | Minted from per-database disjoint ranges (P-010); same-workspace twins removed by migration 1443 (P-011); the database enforces `UNIQUE (workspace_id, feature_id)` on `harness_shared.work_items` through migration 1444 (P-012). |

**2. Carry the scope.** When the id is only unique inside a scope, write the scope with it.

| Scheme                                   | Write it as                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan item                                | slug + `#P-NNN` (or the linked work-item id, which `plans:items` / `plans:get` now return, P-003). A declared `plan:` + slug + `#P-NNN` ref hydrates with that work item (P-004). |
| Plan decision                            | slug + `#D-NNN`, the form `plans:add-decision` returns.                                                                                                                           |
| Routine                                  | name plus `installSlug`.                                                                                                                                                          |
| Owner directive, coord message, test run | Only meaningful on the database that issued it; say which host when it leaves that host.                                                                                          |

A bare `P-NNN`, `D-NNN` or `#1636` in a message to another plan, harness or host is a violation even when the reader happens to guess right.

## When neither is possible: refuse, never pick

Some lookups must accept a scoped id bare: plan slugs and rubric refs are only unique per harness, and most tools take them without one. Those lookups must refuse when more than one row matches and name the candidates.

* Plan slugs: a slug-only lookup that matches more than one plan refuses and names the candidates (P-006).
* Rubric refs: a ref held by more than one harness of the workspace is refused with `rubric_ref_ambiguous` (`RubricRefAmbiguousError` in `packages/operator-core/lib/rubrics.ts`, WI-6554700010008395).
* By-id work-item tools (`work_items:get`, the issue-family state writer, `resolveIssuePhysicalSlug`) address the one row in the workspace without a harness and report any remaining ambiguity (P-013).
* Across workspaces: when the ambient workspace lacks an id, `getIssue` falls back only to the single other workspace that holds it (deliberate, EI-15486). If several other workspaces hold it, it refuses and names them (`assertWorkspaceChoice` in `packages/operator-core/lib/work-items-physical-row.ts`, WI-6554700010008365).

The two gaps the inventory found (the rubric `LIMIT 1` read and the cross-workspace freshest-row fallback) are both closed by the refusals above.

## Designing a new id

Before you add a table or tool whose text id is unique only together with `harness_slug` (or any other scope), ask whether the id will ever cross that scope: a citation in prose, an event key, a coord ref, a cross-harness tool. If it will, key it on `workspace_id` or make it globally unique. The recurrence guard `packages/operator-core/lib/db-schema-reference/harness-scoped-id-uniqueness.ts` (P-007) fails on a new `harness_shared` unique index that makes an id unique only together with `harness_slug`, unless it is allowlisted with a reason.

## Checking a citation

To check whether a cited work item exists, use `work_items:get { id }` without a harness, or query `harness_shared.work_items` by `workspace_id` and `feature_id`. Adding a guessed `harness_slug` predicate turns a real citation into a false zero.

## This page is pinned

`packages/operator-core/lib/doc-claims/identifier-scope-invariant.test.ts` derives this page's enforcement claims from the code (the armed migration, the refusals, the recurrence guard) and fails when the page drifts from them.
