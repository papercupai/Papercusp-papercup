# First-party dependency snapshot vs the gitnexus snapshot — evidence (2026-10-06)

Plan `gitnexus-deterministic-integration-2026-10-05`, follow-up promised by D-026; work item
WI-10006809. Machine-readable companion (every number below is derived from it, not transcribed):
`docs/evidence/gitnexus-first-party-snapshot-2026-10-06.json`. It was generated from the scratch
measurement outputs `.papercusp/scratch/wi809-compare.json`, `wi809-uncorr.json` and
`wi809-cli.log` (probes `wi809-compare.mts`, `wi809-uncorr.mts`, `wi809-diag.mts`).

## What was built

`node scripts/gen-graph-dependency-snapshot.mjs --first-party` derives the import graph that
P-001's test selector reads straight from tracked source (`git ls-files --recurse-submodules`).
It needs no graph backend, server or on-disk index. Specifiers are read with the selector's own
extractor and resolved in TypeScript's order:

1. relative paths;
2. the nearest tsconfig `paths`, where an EXACT key matches by equality and otherwise the
   LONGEST wildcard prefix wins;
3. tracked workspace packages; a name two tracked dirs claim resolves only where Node's own
   `node_modules` lookup from that importer lands, and only onto one of the claimants.

Every edge then goes through the same fail-closed `buildSnapshot` source corroboration the
gitnexus producer uses, bound to its importer's content hash. The default output is a sibling
file (`dependency-snapshot.first-party.json`), so it cannot displace the gitnexus snapshot the
selector reads. **The routine was not switched;** P-012 decides whether it should be.

## Outcome

Measured against the live gitnexus snapshot (index `aa838009bd`, 52,623 edges), first-party at
HEAD `88409fd94d`:

| | first-party | gitnexus |
|---|---|---|
| corroborated edges | 61,358 | 52,623 |
| covers gitnexus edges | 52,513 of 52,623 (99.79%) | — |
| cross-workspace edges (live) | 2,617 | 1,583 |
| covers gitnexus live cross edges | 1,582 of 1,583 (99.94%) | — |
| cross edges gitnexus lacks | 1,035 | — |
| import-only producer wall time / peak RSS | 25.4 s / 926 MiB | not measured in this snapshot comparison |

The producer cost above is the import-only measurement recorded in the companion JSON.
The separate P-017 bake-off measured the whole-tree TypeScript arm at 177 s / 13.9 GiB
and GitNexus 1.6.9 at 2,948 s / 11.8 GiB (D-026). Those setup workloads are different
from this import-only producer. An earlier version of this table mislabeled the
whole-tree TypeScript costs as GitNexus; WI-10007660 corrects that attribution.

Cross-workspace edges are the reason the snapshot exists: they are the undeclared dependencies
the workspace-level baseline cannot see. The one gitnexus-only live cross edge is
`packages/coordination/src/adapter-wiring.test.ts → packages/operator-core/lib/agent-tools/coordination/presence.ts`.

## How the coverage was reached (what was wrong on the way)

Cross coverage of gitnexus live cross edges per stage: v1 relative-only 40%; v2 + aliases +
unique packages 54%; v3 TypeScript-faithful alias match 97.73%; v4 ambiguous names through
Node's lookup 99.94%.

- **v2 → v3, measured cause:** apps/operator's tsconfig declares an EXACT key
  `"@papercusp/operator-core": [".../lib/index.ts"]` beside its wildcard
  `"@papercusp/operator-core/*"`. A first-match prefix scan let the exact key capture
  `@papercusp/operator-core/lib/x` and resolve it to `.../lib/index.ts/lib/x`, which matched
  nothing. That dropped 692 of the 693 missing apps/operator → operator-core edges. The shared
  tsconfig parser (`tsconfigAliasesFor`, `scripts/lib/related-tests.mjs`) flattens exact keys
  into prefixes, so it now also exposes `tsconfigPathEntriesFor`, which keeps the distinction:
  one parser, two views.
  The earlier hypothesis (package-name ambiguity) was tested and was not the cause.
- **v3 → v4:** `@papercusp/harness` is claimed by two tracked dirs: the real package and a
  staged sidecar copy (`papercusp-desktop/src-tauri/env-sidecars/staging/harness`). Dropping
  the ambiguous name lost 35 edges. Node's lookup resolves every one of them
  (`packageAmbiguous=0`).

## What the selector still refuses (follow-up, not a regression)

Of 70,939 derived edges, 9,580 are real resolutions that the selector's corroboration rule
cannot verify: 8,244 resolve to a package or directory `index`, 1,243 resolve through a `src/`
mapping, and 93 are other shapes. A non-relative specifier is accepted only when its last two
segments equal the imported path's last two, so `@scope/pkg` → `pkg/src/index.ts` can never
match. This limits both backends equally: gitnexus edges of those shapes are dropped the same way.
It is filed as a separate work item rather than widening the selector here.

## Tests

`packages/operator-core/lib/__tests__/gen-graph-dependency-snapshot.test.ts`, describe
`first-party snapshot producer` (43 tests in the file pass), covers:

- exact-vs-wildcard and longest-prefix matching, with a permanent CONTROL proving the pre-fix
  first-match scan fails the same fixture;
- both tsconfig views;
- nearest-ancestor tsconfig and dropping a target that escapes the root;
- relative, alias and package resolution, and the ambiguous-name rule;
- corroboration of emitted edges;
- Node's lookup through real symlinks;
- `--first-party` flag exclusivity;
- the real CLI on a temporary git repo.

Also green: `related-tests-selection` + `e2e-fixture-specs-selection` (51), and
`affected-tests-graph-suggestions` (detached run, pass). The behavioural-strand check against
the pre-change base reports no downstream assertions, and `lint:tsc --files` is clean on both
routed legs.
