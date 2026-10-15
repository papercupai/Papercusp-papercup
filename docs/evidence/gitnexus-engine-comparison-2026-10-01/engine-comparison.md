# Engine comparison — run engine-comparison-2026-10-02

created 2026-10-02T16:37:34.722Z · seed 0 · prereg 7ff941b3e5366038

## Summary (one row per arm)

| arm | version | correct | recall | cold index s | peak RSS MB | index MB | warm med ms | resp KB | fixtures | fault |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline-lsp-rg | rg rg | 1/5 | 0.30 | 0.0 | 0 | 0 | 55 | 40.9 | 2/3 | surfaced |
| gitnexus-installed | 1.6.9 | 2/5 | 0.50 | 436.0 | 9903 | 2756 | 4412 | 75.2 | 1/3 | SILENT |
| gitnexus-candidate | 1.6.12 | 1/5 | 0.43 | 1179.7 | 9458 | 3875 | 3910 | 464.6 | 3/3 | SILENT |
| codebase-memory | dev@339b3f40 | 1/5 | 0.20 | 228.5 | 9368 | 941 | 14595 | 16.4 | 3/3 | surfaced |

## Per-case measurements

| arm | case | intent | correct | recall | cold ms | warm ms | resp bytes | error |
|---|---|---|---|---|---|---|---|---|
| baseline-lsp-rg | selective-scheduler-edge | callees | NO | 0.00 | 815 | 91 | 1303 | n/a |
| baseline-lsp-rg | selective-fingerprint-chain | callees | NO | 0.50 | 96 | 102 | 38477 | n/a |
| baseline-lsp-rg | selective-external-consumer | callers | NO | 0.00 | 785 | 55 | 1677 | n/a |
| baseline-lsp-rg | selective-route-boundary | text-search | NO | 0.00 | 52 | 54 | 290 | n/a |
| baseline-lsp-rg | selective-exact-index-symbol | symbol-search | yes | 1.00 | 49 | 43 | 94 | n/a |
| gitnexus-installed | selective-scheduler-edge | callees | yes | 1.00 | 5312 | 4967 | 33871 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. |
| gitnexus-installed | selective-fingerprint-chain | callees | NO | 0.50 | 6819 | 7187 | 29029 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. |
| gitnexus-installed | selective-external-consumer | callers | yes | 1.00 | 4451 | 4412 | 14042 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. gitnexus callers returned 4 edge(s): 3 resolved call site(s) and 1 FILE-level edge(s) carrying no line. The file rows are listed last, with kind:"file". Do not count them as callers — the same file can appear both as a resolved site and as a file edge, so counting rows overstates the real total. |
| gitnexus-installed | selective-route-boundary | text-search | NO | 0.00 | 0 | 0 | 0 | declined: gitnexus facade does not route intent 'text-search' |
| gitnexus-installed | selective-exact-index-symbol | symbol-search | NO | 0.00 | 2104 | 2242 | 59 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. gitnexus context failed or returned an unrecognized status (missing): Symbol 'claimNextIssueWorkItem' not found. Use scoped rg or official LSP. |
| gitnexus-candidate | selective-scheduler-edge | callees | yes | 1.00 | 6521 | 5529 | 56079 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. |
| gitnexus-candidate | selective-fingerprint-chain | callees | NO | 0.50 | 8260 | 6690 | 370181 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. |
| gitnexus-candidate | selective-external-consumer | callers | NO | 0.67 | 3750 | 3910 | 49448 | gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. gitnexus callers returned 5 edge(s): 4 resolved call site(s) and 1 FILE-level edge(s) carrying no line. The file rows are listed last, with kind:"file". Do not count them as callers — the same file can appear both as a resolved site and as a file edge, so counting rows overstates the real total. |
| gitnexus-candidate | selective-route-boundary | text-search | NO | 0.00 | 0 | 0 | 0 | declined: gitnexus facade does not route intent 'text-search' |
| gitnexus-candidate | selective-exact-index-symbol | symbol-search | NO | 0.00 | 1091 | 996 | 0 | gitnexus dispatch threw: gitnexus context exit 1: GitNexus Context (1.6.12) |
| codebase-memory | selective-scheduler-edge | callees | NO | 0.00 | 44282 | 16554 | 9243 | n/a |
| codebase-memory | selective-fingerprint-chain | callees | NO | 0.00 | 15355 | 14595 | 3229 | n/a |
| codebase-memory | selective-external-consumer | callers | NO | 0.00 | 14910 | 16284 | 2077 | n/a |
| codebase-memory | selective-route-boundary | text-search | NO | 0.00 | 12397 | 6861 | 1429 | n/a |
| codebase-memory | selective-exact-index-symbol | symbol-search | yes | 1.00 | 5591 | 8888 | 769 | n/a |

## Update fixtures (edit · delete · refresh-failure)

| arm | fixture | pass | fault surfaced | refresh s | detail |
|---|---|---|---|---|---|
| baseline-lsp-rg | edit | yes | n/a | 0.0 | all 1 expected site(s) present |
| baseline-lsp-rg | delete | yes | n/a | 0.0 | no site from the deleted file is returned |
| baseline-lsp-rg | refresh-failure | NO | yes | 0.0 | fault SURFACED; correct cold=1 while-broken=0 after-restore=1; recovery refresh ok=true |
| gitnexus-installed | edit | NO | n/a | 1800.9 | missing packages/operator-core/lib/scheduler/get-next.ts:3108 [engine note: gitnexus dispatch threw: gitnexus context exit 139: GitNexus: found 90371 byte lbug.wal without lbug.shadow before read-only open; will rely on LadybugDB replay/recovery instead of deleting pending WAL data.] |
| gitnexus-installed | delete | NO | n/a | 1811.9 | query FAILED (error and no sites) [engine note: gitnexus dispatch threw: gitnexus context exit 139: ] |
| gitnexus-installed | refresh-failure | yes | NO | 0.8 | fault SILENT; correct cold=2 while-broken=2 after-restore=2; recovery refresh ok=true |
| gitnexus-candidate | edit | yes | n/a | 519.0 | all 1 expected site(s) present [engine note: gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current.] |
| gitnexus-candidate | delete | yes | n/a | 720.9 | no site from the deleted file is returned [engine note: gitnexus list_repos health probe threw: bench gitnexus CLI dispatch does not support tool 'list_repos'. Index health is UNMEASURED; do not treat graph results as current. gitnexus callers returned 5 edge(s): 4 resolved call site(s) and 1 FILE-level edge(s) carrying no line. The file rows are listed last, with kind:"file". Do not count them as callers — the same file can appear both as a resolved site and as a file edge, so counting rows overstates the real total.] |
| gitnexus-candidate | refresh-failure | yes | NO | 3.7 | fault SILENT; correct cold=1 while-broken=1 after-restore=1; recovery refresh ok=true |
| codebase-memory | edit | yes | n/a | 164.1 | all 1 expected site(s) present |
| codebase-memory | delete | yes | n/a | 330.5 | no site from the deleted file is returned |
| codebase-memory | refresh-failure | yes | yes | 77.5 | fault SURFACED; correct cold=1 while-broken=1 after-restore=1; recovery refresh ok=true |

## Source parity

identical tree fingerprint across arms: **YES**

```json
{
  "baseline-lsp-rg": "08104b5503ccf9a3b0cf486a81bbc06fc94329f5",
  "gitnexus-installed": "08104b5503ccf9a3b0cf486a81bbc06fc94329f5",
  "gitnexus-candidate": "08104b5503ccf9a3b0cf486a81bbc06fc94329f5",
  "codebase-memory": "08104b5503ccf9a3b0cf486a81bbc06fc94329f5"
}
```

## Disposition (decideDisposition — measured, never self-graded)

decision: **keep**

- Codebase-Memory does not replace: correct 1/5 < installed 2/5; recall 0.20 < 0.50; warmMedianMs 3.31x installed
- candidate does not upgrade: correct 1/5 < installed 2/5; recall 0.43 < 0.50; coldIndexMs 2.71x installed; indexBytes 1.41x installed

## Disclosures

- GitNexus cold-index wall/RSS are ONE real `/usr/bin/time -v` run each (not repeated), taken under heavy shared-host load; load averages before/after are in arms/<arm>/load-{before,after}.txt. Read them as upper bounds comparable within load noise, never as precise ratios.
- CBM cold index ran LIVE on an emptied cache with the detached daemon's VmHWM sampled; the earlier `time -v` of its client alone (3:49.74 wall, 17 MB RSS) is kept only as a wall-time cross-check.
- Bench mappings are disclosed adapters fixed before the run, not tuned after results: GitNexus `symbol-search` → native `context`, `text-search` declined (its `query` is concept search); CBM routes via `search_graph` / `trace_path` / `search_code`. A declined or missed case is scored incorrect for that arm, same grader for every arm.
- Run order and attempt history (disclosed, not hidden): baseline, then codebase-memory, then an ATTEMPT 1 that ran the two GitNexus arms concurrently. Attempt 1 of gitnexus-installed was aborted: an execFile timeout killed the direct child only, and the wrapped grandchild kept running and corrupted the installed `.gitnexus` index (fixed with a `timeout -k` wrapper in `execTimed`, guarded by engine-comparison-exec.test.ts; the installed index was rebuilt cold before its final run). The FINAL gitnexus-installed and gitnexus-candidate reports are SEQUENTIAL SOLO reruns; attempt-1 files are kept beside them as `*.attempt1*`. The box (shared with the whole fleet) carried load average 100–260 throughout, so every wall time is a loaded-host figure. ATTEMPT 2 of gitnexus-installed (solo) was also lost: it was frozen mid-refresh (`gitnexus analyze --skip-agents-md .`, under its 1_800_000ms `timeout -k` wall-clock deadline) by a fleet-wide pause, and the thaw would have tripped that deadline and killed the analyzer mid-write, so it was killed deliberately and the installed index was restored by a cold forced `gitnexus analyze --force` (restore logs kept as `restore-analyze*.{out,err}` beside the arm; node/edge counts within 12 of the original index). The reported gitnexus-installed numbers are the ATTEMPT 3 run on that restored index, started from a pristine snapshot of it; only that attempt's measurements are reported, and the only things carried across attempts are the harness and the fixture files, never an index state.
- Two grading defects in this harness were found AFTER attempt 1 and fixed for ALL arms by one rule — post-hoc, disclosed; the preregistered case ids, warm samples and disposition bars are untouched (preregHash unchanged). (1) `error` is a caveat channel, not a failure flag: graded as one, it zeroed both GitNexus arms on the edit/delete fixtures by construction, because the bench CLI dispatch has no `list_repos` and so EVERY GitNexus answer carries an "index health UNMEASURED" note. A query now counts as failed only when `error` is set AND no site came back (`answered()`); the note is kept in the fixture detail. (2) The refresh-failure fixture passed VACUOUSLY for an arm with no cold-correct case (`>= 0` holds for any engine); it now reports NOT MEASURABLE and is not a pass. The baseline and codebase-memory reports are invariant under both fixes (every case `error` is null and each has 1 cold-correct case), checked from their report JSON, so they were not rerun.
- GitNexus `analyze` skipped files above its default 512 KB cap in BOTH GitNexus arms (packages/operator-core/lib/inference-gateway/gateway.ts and packages/operator-core/lib/work-items.ts); `selective-exact-index-symbol` expects a site in work-items.ts. `GITNEXUS_MAX_FILE_SIZE` was NOT raised (as-installed defaults), so whether raising it changes that case is untested residue, not a finding. `gitnexus analyze` also wrote AGENTS.md/CLAUDE.md/.claude into both GitNexus trees (untracked; symmetric across the two arms, absent in the baseline and CBM trees).
- CANDIDATE LINE-BASE CORRECTION (post-hoc, disclosed, applied by engine VERSION not by arm preference): candidate ATTEMPT 2 graded 0/5 / recall 0.00 because GitNexus 1.6.12 reports a 1-based `startLine` while 1.6.9 reports 0-based and the production facade adds +1 unconditionally, so every 1.6.12 site was one line late. Measured, not assumed: `getLongLivedAdminPool` is declared on 1-based line 145 and the raw `startLine` is 144 on 1.6.9 vs 145 on 1.6.12 (same source tree). The bench adapter now skips the +1 for a 1-based engine; the installed arm's grades are unchanged by it (its report predates and is invariant under the change). The attempt-2 report is kept as `report-gitnexus-candidate.attempt2-facade-line-base.json`. The reported candidate numbers are ATTEMPT 3, a SOLO rerun on the restored index. The production facade's own +1 on a 1.6.12 upgrade is a separate finding for the upgrade work, not fixed here.
- INSTALLED-ARM TREE PARITY — RESOLVED BY A CLEAN RERUN (disclosed history): an earlier installed run (ATTEMPT 3) was graded on `arms/gitnexus-installed/tree` carrying a leftover +4-line `engineBenchEditProbe` edit to packages/operator-core/lib/scheduler/get-next.ts from the killed ATTEMPT 2, so its `sourceParity.same` was false (`+dirty`) and its EDIT fixture was confounded; those artifacts are kept as `*.attempt3-dirty-tree.*`. The leftover was reverted (`git diff --quiet HEAD` clean), the installed index was rebuilt cold from the clean tree, and the installed arm was rerun SOLO; `sourceParity.same` is now true for all four arms. The clean rerun does not change the graded outcome (installed correct 2/5 in both runs) or the disposition. It DOES settle one question: the installed edit and delete fixture failures are ENGINE faults of GitNexus 1.6.9, not tree confounds — delete exited 139 (segfault) in both runs, and the edit fixture, which died with a node stack trace on the dirty tree, died with exit 139 on the clean tree (engine note: a lbug.wal was found without lbug.shadow before the read-only open). The refresh-failure fixture reported its fault SILENT on the clean rerun where the dirty-tree run reported it SURFACED; its answers were unchanged (cold=2, while-broken=2, after-restore=2). Latency and RSS from the rerun were taken on a shared, loaded host, so they remain upper bounds comparable only within load noise, as stated above.
- The baseline arm is a scripted `rg` pass, not an LSP session (the arm id is historical). `rg` exits 2 on an unreadable directory and the arm reports that as a query error, which is what drives its refresh-failure fixture result.
- The tool-level comparison spends ZERO LLM tokens; `estTokens` is bytes/4 for every arm. This measures the engines, not agent task outcomes.
- gitnexus-installed graph size from its cold analyze: 161,974 nodes / 357,816 edges.
- gitnexus-candidate graph size from its cold analyze: 370,204 nodes / 1,207,016 edges.
