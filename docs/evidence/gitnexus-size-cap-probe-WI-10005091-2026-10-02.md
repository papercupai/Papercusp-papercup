# GitNexus `GITNEXUS_MAX_FILE_SIZE` raise — isolated probe (WI-10005091, residue 1)

Residue of plan `gitnexus-selective-hardening-and-comparison-2026-09-13` D-002 (KEEP installed GitNexus 1.6.9).
The bench arms ran as-installed defaults, so `packages/operator-core/lib/work-items.ts` (563,608 B) and
`inference-gateway/gateway.ts` (629,780 B) were skipped at the 512 KB walker cap and
`selective-exact-index-symbol` (`claimNextIssueWorkItem`) failed for GitNexus *by construction*.
Whether raising the cap changes that case was untested. It is now measured.

## Method (isolated — never the live index)

- Installed `gitnexus` 1.6.9 (`~/.papercusp/vendor/gitnexus`), throwaway `HOME` per arm.
- Tree = `git init` of exactly the two skipped files, copied from the canonical checkout.
- Arm `default` vs arm `raised` (`GITNEXUS_MAX_FILE_SIZE=1024`; **the unit is KB**, per
  `core/ingestion/utils/max-file-size.js`: default 512 KB, hard-clamped at tree-sitter's 32 MB).
- `analyze --skip-agents-md --force .` under `/usr/bin/time -v`, then `gitnexus context claimNextIssueWorkItem`.
- Host load average during the run: 81–109 (single sample each — wall times are indicative, not benchmarked).

## Result

| arm | skipped | nodes / edges | wall | peak RSS | `.gitnexus` | `context claimNextIssueWorkItem` |
|---|---|---|---|---|---|---|
| default (512 KB) | 2 large files | 0 / 0 | 20.6 s | 2.78 GB | 2.8 MB | `Symbol not found` |
| `GITNEXUS_MAX_FILE_SIZE=1024` | none | 883 / 2,496 | 35.3 s | 3.50 GB | 50 MB | found, `work-items.ts` startLine 8430 |

Conclusion: raising the cap **does** fix the case. Marginal cost of admitting the two files at this scale is
+14.7 s wall, +0.72 GB peak RSS (peak, so not additive to the full-repo run), +47 MB index. Full-repo analyze
baseline from the bench (`restore-analyze.err`): 14:58 wall, 8.13 GB RSS — the delta at repo scale was NOT
measured here and must not be read off this table.

## Production already raises it

`packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts` `selectiveSourceLimitKb(root)` derives
the cap from the live sizes of the selective-corpus sources and `analyzeEnv(..., sourceLimitKb)` sets
`GITNEXUS_MAX_FILE_SIZE` for the production reindex (and refuses an operator value below it). So the 512 KB skip
was an artifact of the bench arms running as-installed defaults, not of production. It does not change the D-002
KEEP disposition; it bounds what the bench's `selective-exact-index-symbol` miss means for GitNexus.

## Residues 2 and 3

- Residue 3 (facade 1-based `startLine` guard): done — `GITNEXUS_START_LINE_BASE_BY_VERSION` /
  `gitnexusStartLineBase()` in `code-intelligence/contracts.ts`, the engine-comparison CLI now derives the base from the
  binary's version (refusing an unmeasured one), and `contracts.test.ts` pins `PINNED_GITNEXUS_VERSION` to a measured
  base. Falsifiability: with the table's `1.6.9` flipped to base 1 the pin-coupling guard fails (14 pass / 2 fail) against
  16/16 for the unmutated copy.
- Residue 2 (pristine installed full-repo rerun + re-aggregate): NOT done — needs a quiet window (prior solo installed
  run took hours at load 100–260; a rerun at the current load average of ~100 would be confounded). Tracked on a
  separate follow-up work item.
