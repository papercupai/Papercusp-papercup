# Work-selection census — 2026-10-01

Plan `enterprise-data-sources-2026-10-01`, item P-007 (WI-10005043).

The authoritative row set is `packages/operator-core/lib/work-selection-census.ts`
(`WORK_SELECTION_CENSUS`, 19 rows, plus `WORK_SELECTION_SEED_ROWS` for P-012). Its test
(`work-selection-census.test.ts`) fails when a cited kind decider moves or disappears. This file
holds the measurements and the verdict, not a second copy of the rows.

## Live measurements (operator DB, workspace `papercusp-workspace`, 2026-10-01 ~20:12Z)

| measure | value |
|---|---|
| open `email-draft-proposal` rows | 129, all `admission` NULL, `lane` NULL, `payload.needsOwnerAction` NULL, unassigned |
| `chunk` rows not terminal | 12, status `passed` |
| non-observation open work by kind | change 2787, bug 1806, task 1128, feature 854 |
| open `lane='observation'` rows | change 130,142, bug 131 (scorecards are these rows) |
| `work_items_claimable` by kind | change 1292, task 765, bug 513, nothing else |
| generic-kind datatypes tagged `pot-placement` | 0 of 7 |

`work_items_claimable` (read with `pg_get_viewdef`): `item_kind = ANY(bug, change, task)`, payload
`lane` not `observation`, payload `needsOwnerAction` not `true`, and zero claim floors.

## Verdict on the plan's [inferred] claim

Claim: "No claim path currently admits `email-draft-proposal`." **Partly wrong.**

- True for every self-select path: `scheduler:get_next` (issue and feature paths),
  `work_items:claim_next`, `work_items:claimable`, frontier placement, fleet scope admission.
  On the feature path this holds only because no datatype carries the `pot-placement` tag. A
  single tag would make all 129 rows self-selectable.
- Not true for the by-id claim. `work_items:claim { id }` goes through `claimWorkItem` and
  `claimIssue`, which apply admission and auto-pickable floors but no `item_kind` predicate.
  The 129 rows carry none of the existing discriminators, so nothing refuses them. This is read
  from code and was not executed against a live row (that would have been a real claim). P-012
  must execute it in an isolated DB.
- Listing surfaces show them: `work_items:list`, `work_items:search` and the counts use
  `featureFamilyKindClause`, which admits every active generic-kind datatype without a tag gate.
  DRAIN mode has no enumerator of its own, so a drain that reads `work_items:list` sees the 129
  rows and can then claim one by id.

## Kind deciders today

Four independent deciders, which disagree:

1. `scheduler/get-next.ts`: `item_kind IN ('bug','change','task')`.
2. `agent-tools/work_items/claimable.ts`: a local `ISSUE_KINDS = bug, change, task`.
3. `issues-engineer.ts`: `ISSUE_KINDS = ['bug','change']`. It omits `task`, so it disagrees with 1 and 2.
4. `datatype-frontier-placement.ts`: `feature` plus tag-gated generic kinds, read from
   `datatype_registry` by a per-row subquery inside the claim path. D-008 retires this shape.

Existing non-kind discriminators: `lane` (a stored generated column from `payload->>'lane'`; the
claimable view reads the payload form), `payload.needsOwnerAction`, and the `admission` column.

## Not settled (marked `unverified` in the module)

`work_items:burn_down` kind handling, the unclaimed-work digest, the admission promoter's
per-kind behaviour, and the predicate of `work_items_design_created_keyset_idx` (mig 885). Grep
found no kind predicate in the first three. P-009 must read each one before it rewires the path.
