# P-017 permissive-backend bake-off — evidence (2026-10-06)

Plan `gitnexus-deterministic-integration-2026-10-05`, item P-017, work item WI-10006297.
Machine-readable companion (every number below is derived from it, not transcribed):
`docs/evidence/gitnexus-p017-backend-bakeoff-2026-10-06.json`, generated from the bench run
`~/.papercusp/bench/fair-comparison-2026-10/runs/2026-10-06` (prereg hash
`aa8ea6aa5a78…`, corpus commit `90e6465ad21b`, 3 repetitions, seed 20261006).

## Outcome

The preregistered rule (`decideBackend`, `packages/operator-core/lib/code-intelligence/fair-comparison.ts`)
returns **drop-third-party, choosing the first-party `no-third-party` arm** (our static import index
plus TypeScript call hierarchy), in every honest treatment of the one arm that never produced an index:

| treatment | decision |
|---|---|
| A. preregistration as written | `inconclusive`: codegraphcontext has 0 of 3 repetitions |
| B. codegraphcontext excluded (it never indexed) | `drop-third-party` → no-third-party |
| C. codegraphcontext counted as a total failure (failure rate 1) | `drop-third-party` → no-third-party |
| D. B with the two defective key seeds removed (below) | `drop-third-party` → no-third-party |

A is inconclusive only because the rule treats "ran zero repetitions" like "has not run yet".
codegraphcontext (0.6.13) failed to finish `cgc index` in all three attempts; the last hit the
4-hour deadline (exit 124). Under the rule's own failure bar (≤ 0.05) such an arm is ineligible,
which is treatment C.

## Graph-backend results (fully adjudicated, 0 pending sites)

Median over 3 repetitions. gF1 = graph effective-F1 (callers, callees, impact). gCFE = rate of
confident empty answers where the key is non-empty.

| arm | licence | gF1 | gCFE | failure | eligible |
|---|---|---|---|---|---|
| no-third-party | first-party | 0.846 | 0.077 | 0.000 | yes |
| gitnexus 1.6.9 | PolyForm-NC | 0.796 | 0.115 | 0.000 | yes |
| codegraph 1.6.2 | permissive | 0.752 | 0.000 | 0.000 | yes |
| codebase-memory | permissive | 0.633 | 0.231 | 0.059 | no (failure > 0.05) |
| trace-mcp 3.34.6 | permissive | 0.309 | 0.654 | 0.000 | yes |
| codegraphcontext 0.6.13 | permissive | — | — | never indexed | no |

rg and lsp-query do not declare all graph intents, so they are baselines, not candidates.

**How close the call was.** gitnexus misses the F1 tie window by about 0.001 (0.7956 against a
threshold of 0.7964; 0.8010 against 0.8013 with the corrected key). On the confident-false-empty
bar it is clearly out (0.115 against ≤ 0.097). The CFE bar decides it: gitnexus answers "nothing
depends on this" more often when something does. codegraph has the best CFE (0.000) but is 0.094
below on F1.

## Cost (cold index of the frozen tree, under fleet load)

Every arm was indexed with the 1-minute load average between 143 and 209 on 128 cores, so wall times
are comparable with each other, not with an idle machine.

| arm | cold index | peak RSS | on-disk index | median query latency |
|---|---|---|---|---|
| no-third-party | 177 s | 13.9 GiB | ~0 (in memory) | 12.0 s |
| gitnexus | 2,948 s | 11.8 GiB | 8.0 GiB tree delta | 0.4 s |
| codegraph | 4,091 s | 8.8 GiB | 2.4 GiB tree delta | 1.8 s |
| codebase-memory | 979 s | 19.2 GiB | 3.5 GiB home | 0.6 s |
| trace-mcp | 156 s | 1.1 GiB | 0.3 GiB home | 0.7 s |
| codegraphcontext | did not finish (4 h) | — | 0.27 GiB partial | — |

The first-party arm indexes 17× faster than gitnexus and needs no on-disk index. In exchange, a
cold query takes about 12 s and the language service holds ~14 GiB while warm. That suits batch
consumers like P-001's test-selection snapshot. An interactive `graph:query` would need a warm
long-lived language service.

## Licence and telemetry

Source of truth: `packages/operator-core/lib/code-intelligence/fair-comparison-admission.ts`. It
verified each candidate's LICENSE file and telemetry default before anything ran. gitnexus is
PolyForm-Noncommercial-1.0.0 (D-004, D-005); its telemetry default was not verified, so it ran
offline-only. The four candidates are MIT. codegraph and trace-mcp ship telemetry ON by default;
`admitArm` runs every arm under its recorded opt-out environment (`CODEGRAPH_TELEMETRY=0`,
`DO_NOT_TRACK=1`, `TRACE_MCP_TELEMETRY=off`).

## Edges P-004 would have needed (context only; P-004 was dropped by D-021)

- **Symbol calls** (callers, callees, impact): every graph candidate above. Quality is as in the table.
- **File imports:** the no-third-party arm's static import index. P-001 does not use it today: its
  suggestions come from a snapshot that `gen-graph-dependency-snapshot.mjs` builds from the
  gitnexus graph (`scripts/lib/graph-dependency-suggestions.mjs`).
- **Test-to-symbol:** no candidate answers it directly. It is callers restricted to test files, so
  its quality tracks the callers rows of the companion JSON.

## Hand adjudication

The automatic adjudicator rules on callers, callees, definition, references and text-search. It
leaves impact and symbol-search to hand review. After its second pass 61 sites were undecided.
All 61 were ruled by hand, adding 66 verdicts (5 canonical unit sites). Each verdict carries its
evidence note in the companion JSON.

Rule applied to every impact site: the adjudicator's own scope model (`isNamedFunctionLike`,
`scopeForLine`; D-012/D-013), applied to the frozen tree. A unit is either a named function-like
scope or the module top level; anonymous callbacks such as `it(() => …)` belong to the module top level.

- **Hop 1:** units that call or pass the subject.
- **Hop 2:** units that call a hop-1 named unit. A module top level cannot be called, so it does not propagate.
- **Canonical site of a unit:** its key site if one exists; otherwise the declaration line for a
  named scope, or the first call line for a module top level. Line 1 and other lines of the same
  unit alias the canonical site.
- **Neutral:** the subject's own declaration, as for callers.
- **Invalid:** a generated bundle (`papercusp-desktop/.../serve.mjs`), and a whole-file `:1`
  answer whose module top level makes no qualifying call. That is the "depth must be honoured,
  not flattened to the whole file" condition stated in the cases.

Two judgment calls, both recorded on their verdicts:

- `run-now.test.ts:40` counts as hop 2. It passes `runScheduledPlanFire` to `vi.mocked`, which is
  a callback-argument edge under the call model. It is a mock, so it is a static edge, not an
  executed path.
- `register-system-actions.ts:1` is invalid. Its side-effect `import './hive-git-gc-action'`
  neither calls nor passes `potGitGcTick`, and the case names the registration as the only static
  upstream edge.

## Defects in the preregistered key (disclosed, not silently changed)

Two seed sites are not in their case's upstream set:

- `acceptance-bar-amendment.ts:484` (`barKeyOf`) in impact-is-provenance-only: a local helper
  inside `synchronizeAcceptanceBarRevision`; the subject is called only at line 719.
- `compile-packages.ts:172` (`only`) in impact-resolve-installed-event: a local helper called on the
  same line as the subject (`resolveInstalledEvent(request.ref, only('event'))`). It is a callee.

No arm reported either site, so every arm lost the same recall on these two cases. The key stays
as preregistered: verdicts may not flip a ruled site, and changing a frozen seed after seeing
results is what preregistration forbids. Treatment D shows that removing both seeds leaves the
decision unchanged.

## What the Decision does and does not change

- It makes the first-party arm the backend of record for any graph intent behind the P-004 seam
  ("no backend change ships without that Decision"). It also names the target for WI-10006543
  (widening `graph:query` callers).
- It does not by itself retire gitnexus. P-001's test-selection suggestions still read the
  gitnexus-produced snapshot. Whether to keep, narrow or scale back gitnexus (stop the hourly
  reindex, reclaim the ~8 GiB index) is P-012's measured Decision, with this result as an input.
  Re-sourcing P-001's snapshot from first-party edges is a separate, filed follow-up.
