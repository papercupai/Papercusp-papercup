# Benchmark suite portfolio: readiness and capability coverage (2026-10-11)

> **Status:** evidence input, research only. No benchmark was run and no upstream code was executed.
> **Author:** su-b7657, 2026-10-11, for plan `benchmark-coverage-frontierswe-v2-2026-10-10` item P-008.
> **Consumer:** `current-benchmark-modernization-2026-10-09` P-007, which cross-checks runtime and official-grader
> readiness before calling a suite runnable (boundary: `benchmark-coverage-frontierswe-v2-2026-10-10#D-004`).
> **Refreshes:** [`external-bench-grader-feasibility-2026-06-15.md`](./external-bench-grader-feasibility-2026-06-15.md).
> **Scope:** the nine suites P-008 names, surveyed in full. `metr-hcast`, `agentsnet` and `swarmbench` are also in
> `REPORT_ON_SUITES` (`packages/operator-core/lib/gym/report-set-firewall.ts`); section 2a gives them a shorter
> pin-and-adapter review so that every registry entry has a disposition (section 2b).

Every fact below is tagged. **[measured]** means read on 2026-10-11 between 03:15Z and 03:35Z from the GitHub
API, the Hugging Face Hub API, the Harbor registry, or this repository and host. **[upstream claim]** means
stated by the upstream project (release notes, README, paper) and not independently checked here.
**[inferred]** is my reading and should be challenged.

## 1. What changed since June

1. **Harbor became the common task format.** Terminal-Bench 2.x, SWE-bench Pro v2, FrontierSWE v2,
   RoadmapBench and the July 2026 SWE-rebench split all ship as Harbor tasks or run through Harbor
   [measured: Harbor registry, Harbor Hub listing, each repo's layout]. The Harbor registry also carries
   SWE-Lancer Diamond [measured]. We already implemented Harbor's separate-verifier grading semantics for
   FrontierSWE v2 (D-003, `external-bench/grader/frontier-swe.ts`). [inferred] Generalising that grader
   into one Harbor-task runner would cover six of the nine suites, and would be cheaper than the per-suite
   "M2 in-container" graders the June plan called for, which were never built.
2. **SWE-bench Pro v2.0.0 (2026-09-22) changed the population under our adapter.** Upstream dropped 89 of
   731 tasks after review and revised 529 instructions, 214 test patches and 38 gold patches
   [upstream claim: v2.0.0 release notes]. The Hugging Face `default` config is now the 642-task v2 set,
   `hard` is HARD-51, and the original 731 moved to config `v1` [measured: HF datasets-server]. Our adapter
   still drives the v1 path (`swe_bench_pro_eval.py`, `jefzda/sweap-images`, the 731-row CSV), and
   `external-bench/estimate.ts:31` hard-codes 731 for `swe-bench-pro-full` [measured]. Our June trials
   (7 runs, 23 trials) are on the v1 population and are not comparable with v2 results.
3. **Terminal-Bench 2.1 supersedes 2.0.** Upstream reports that 2.1 fixes 28 of 2.0's 89 tasks
   [upstream claim: tbench.ai news]. Our seam still pins `terminal-bench@2.0`
   (`external-bench/native-harness-terminal-bench.ts:126`) [measured].
4. **Two upstream homes moved, and Harness-Bench's upstream was misidentified in June.** SWE-Lancer now
   lives in `openai/frontier-evals/project/swelancer`. The old `openai/SWELancer-Benchmark` repo is
   archived, and `openai/preparedness` redirects to `frontier-evals` [measured]. The June doc treated
   Harness-Bench as "clawbench_v2". The paper's (arXiv 2605.27922) code is `Qihoo360/harness-bench`
   [measured: repo exists; upstream claim: paper].
5. **Harness-Bench has no license** [measured: no LICENSE file, GitHub license API 404, no license text in
   README]. Its grading also includes an LLM-weighted quality rubric (`grading/default_rubric.py`,
   `outcome_llm_weight`) [measured: file present; README describes the weight]. Both matter for a
   published, oracle-graded claim.
6. **Four suites have no adapter code at all:** SWE-rebench, SWE-bench-Live, SWE-EVO and RoadmapBench appear
   only in `report-set-firewall.ts` and `libs/generic/bench-metrics/src/schema.ts` [measured: `git grep`].
7. **Cost per trial is almost entirely unmeasured.** `harness_shared.bench_runs`/`bench_run_tasks` contain only
   June data: swe-bench-pro with 23 trials and no recorded cost, plus 22 trials labelled suite `unknown`
   (18 costed: p50 $4.29, p90 $10.78) [measured: SQL]. `estimate.ts` uses a flat $3.50/task prior.
   The first real FrontierSWE number will come from the P-012 smoke test.

## 2. Readiness matrix

Pins are the default-branch head commit (12 hex) and its committer date unless a release is named.
"Adapter today" describes this tree at 2026-10-11. "Verdict" is what modernization P-007 should check
next, not a decision.

| Suite | Upstream pin | License | Tasks (source) | Official grader | Our adapter today | Cost / trial | Verdict |
|---|---|---|---|---|---|---|---|
| **swe-bench-pro** | `scaleapi/SWE-bench_Pro-os@66f92766bba6` (2026-09-22), release **v2.0.0**; HF `ScaleAI/SWE-bench_Pro@2d52cb3df914` | MIT (GitHub); HF card has no license field | v2 `default` **642**, `hard` 51, `v1` 731 [measured: HF] | v2: Harbor task dirs with verifier + `ghcr.io/scaleapi/swe-bench_pro-v2:<id>`; upstream gate oracle 642/642, empty 0/642 [upstream claim]. v1 eval script still in tree | v1 M1 path built and used June 16–19 (`grader/swe-bench-pro.ts`, `swe-pro-arm.ts`); local checkout `~/.papercusp/bench-harnesses/SWE-bench_Pro-os` is already at v2.0.0 but the adapter is not migrated | Unmeasured (23 June trials, cost not recorded); prior $3.50 | Runnable on the **deprecated v1** population only. Migrate to v2 and pin the HF config and revision before any new claim |
| **terminal-bench** | `harbor-framework/terminal-bench-2-1@7131e4375048` (2026-08-11); 2.0 at `harbor-framework/terminal-bench-2@2fd12b88aafd`; runner `harbor-framework/harbor` v0.24.0 (2026-10-05), head `09f5b964f8e5` | Apache-2.0 | 2.1: **89** task dirs [measured] | Harbor per-task verifier (`tests/test.sh`) | `native-harness-terminal-bench.ts` has a `runHarbor` seam pinned to `terminal-bench@2.0`; `getOfficialGrader` throws "M2 … not built yet"; Harbor is **not installed** on this host | Unmeasured | Not runnable today. Small lift: install Harbor, pin `@2.1`, grade with the Harbor verifier |
| **swe-rebench** | HF `nebius/SWE-rebench-leaderboard@34d5a58864ac` (2026-07-28); July 2026 split only on Harbor Hub (`ibragim-badertdinov/swe-rebench-07-2026`); no GitHub repo found | CC-BY-4.0 | leaderboard `test` **860**; monthly splits, latest on HF `2026_03` = 110; full corpus 21,336 (filtered 6,542); V2 32,079 multi-language (2026-10-01) [measured: HF] | Prebuilt per-task Docker images (`docker_image` column) [upstream claim]; Harbor Hub dataset `swe-rebench/swe-rebench-leaderboard` | None (schema + firewall only) | Unmeasured | Not runnable. Cheap through a Harbor runner. The contamination-resistant headline candidate |
| **swe-bench-live** | `microsoft/SWE-bench-Live@62d02936a072` (2026-09-25), release `v1.0-multi-language-multi-os-benchmarking` (2026-03-08); HF `SWE-bench-Live/SWE-bench-Live@b51a86422e10` | MIT | Python: full **1,888**, test 1,000, verified 500, lite 300; MultiLang **1,077** over 8 languages; Windows 66 [measured: HF; MultiLang sum matches upstream README] | Official evaluation script over per-instance Docker sandboxes [upstream claim: README] | None | Unmeasured | Not runnable. M1 diff-batch shaped, so the SWE-bench Pro v1 grader structure is the reuse candidate |
| **swe-evo** | `SWE-EVO/SWE-EVO@9b83d5af943b` (2026-05-03; `bdqnghi/SWE-EVO` redirects); HF `Fsoft-AIC/SWE-EVO@77310c70d364` | MIT on GitHub, **apache-2.0 on HF** (mismatch) | **48** [measured: HF] | Bundled SWE-bench fork; Fix Rate partial metric; OpenHands / SWE-agent scaffolds [upstream claim: README, arXiv 2512.18470] | None | Unmeasured | Not runnable. M1 shaped. Resolve the license mismatch before publishing |
| **roadmapbench** | `UniPat-AI/RoadmapBench@9bbc3432d9cd` (2026-05-19); Harbor Hub `unipat/roadmapbench` | MIT | **115** tasks, 17 repos, 5 languages [upstream claim: README, arXiv 2605.15846] | Per-subtask test suites, weighted continuous score; `evaluation/run_task.sh`, `run_oracle.sh`, `collect_harbor_results.py`, `compute_metrics.py` [measured: file list] | None | Unmeasured | Not runnable. Harbor-native, images pulled from Docker Hub |
| **swe-lancer** | `openai/frontier-evals@51052cede8cc` (2026-04-21), `project/swelancer`; old `openai/SWELancer-Benchmark` archived (last push 2025-07-18) | MIT | Harbor registry `swe-lancer-diamond@ic` **198**, `@manager` 265, `@all` 463 [measured]; upstream task list `all_swelancer_tasks.csv` | Playwright E2E inside a per-task image; each image takes 10–20 min to build and is ~14 GB [upstream claim: README] | `grader/swe-lancer.ts` structure built; its `buildEvalCommand` was never wired; no arm | Unmeasured | Not runnable. Disk is the binding constraint (`/` is 96% used, 82 GB free [measured]). The Harbor `swe-lancer-diamond@ic` route avoids local image builds |
| **harness-bench** | `Qihoo360/harness-bench@1025086a4466` (2026-06-23) | **None** | **106** task dirs [measured] | Oracle validators plus an LLM-weighted quality rubric (`grading/default_rubric.py`) [measured: file; upstream claim: README] | `getOfficialGrader` throws "M2 … not built yet"; June design targeted the wrong upstream | Unmeasured | **Blocked on license** for any published claim. The LLM-judged component conflicts with oracle-only grading. Keep at most as an internal diagnostic |
| **frontier-swe** | `Proximal-Labs/frontier-swe-v2@da83f84f8fbc` (commit 2026-09-19), release v2.0.0 (2026-09-21); v1 `Proximal-Labs/frontier-swe` (17 tasks) | No license file; README: "provided for evaluation purposes" | **34** [measured: ingested corpus `~/.papercusp/bench-results/frontier-swe-v2/tasks.jsonl`, 25 categories; upstream CHANGELOG agrees] | Harbor `task.toml` 1.3, separate verifier image, digest-pinned (D-002, D-003) | Corpus ingested and grader built (P-002, P-003 done); arm default still v1 (WI-6554700010008374); gold/empty controls pending (P-007, owner placement question on WI-10008254) | Unmeasured; P-012 smoke test is the first source | Closest to runnable. Waits on the P-007 control placement and P-012 spend approval |

### 2a. The three report-on suites outside the nine

Added 2026-10-11 ~03:45Z for the registry dispositions below. All three already have adapters in
`packages/operator-core/lib/external-bench/` [measured: file list]. Their runtime readiness was not measured.

| Suite | Upstream pin | License | Our adapter today | Verdict |
|---|---|---|---|---|
| **metr-hcast** | Tasks `METR/public-tasks@5418666a1b02` (2026-06-10); `METR/task-standard` and `METR/vivaria` both **archived**, last push 2026-10-07 [measured] | NOASSERTION on GitHub for `public-tasks`; MIT for `task-standard` [measured] | `metr-hcast-live.ts` vendors Task-Standard `drivers/taskhelper.py` from `~/.papercusp/bench-harnesses/metr/task-standard`, which is **absent on this host** [measured] | Migrate. The `task-standard` README says METR no longer maintains it and uses Inspect, and the `public-tasks` README points to the METR Inspect Task Bridge (`metr/inspect-metr-task-bridge`) [measured: READMEs] |
| **agentsnet** | `floriangroetschla/AgentsNet@269f576e966f` (2025-07-16), not archived [measured] | MIT [measured] | `agentsnet-ingest.ts` keys its grader version to the arXiv id (`agentsnet@arxiv-2507.08616`), not a commit [measured] | Verify. Pin the commit, then re-verify the adapter |
| **swarmbench** | `RUC-GSAI/YuLan-SwarmIntell@c164678ff851` (2025-05-21), not archived [measured] | MIT [measured] | `swarmbench-live.ts` runs `swarmbench_run.py` from `~/.papercusp/bench-harnesses/swarmbench`, which is **absent on this host** [measured]; no commit pin | Verify. Pin, install and re-verify |

### 2b. Registry dispositions

Each `REPORT_ON_SUITES` entry in `packages/operator-core/lib/gym/report-set-firewall.ts` carries one of these as its
`portfolio.disposition`, with `reviewedAt: 2026-10-11` and this file as its evidence. The unit test
`report-set-firewall.test.ts` fails if a row here and the registry disagree.

| Suite | Disposition |
|---|---|
| `swe-bench-pro` | `migrate-upstream` |
| `terminal-bench` | `build-adapter` |
| `swe-rebench` | `build-adapter` |
| `swe-bench-live` | `build-adapter` |
| `swe-evo` | `build-adapter` |
| `roadmapbench` | `build-adapter` |
| `swe-lancer` | `build-adapter` |
| `harness-bench` | `blocked` |
| `metr-hcast` | `migrate-upstream` |
| `agentsnet` | `verify-adapter` |
| `swarmbench` | `verify-adapter` |
| `frontier-swe` | `awaiting-gate` |

`migrate-upstream`: an adapter exists but targets a superseded upstream population or framework.
`build-adapter`: no adapter, and a viable official-grader route exists. `verify-adapter`: an adapter exists but
its runtime readiness is unmeasured. `awaiting-gate`: an adapter exists and waits on a named gate. `blocked`: a
named blocker prevents any published claim.

## 3. Capability coverage matrix

● = a primary design goal of the suite; ○ = partly exercised; blank = not targeted. Every cell rests on the
upstream description cited in section 2 [upstream claim]. Cells marked † are my reading [inferred].

| Capability | Pro | TB 2.1 | rebench | Live | EVO | Roadmap | Lancer | H-Bench | FSWE v2 |
|---|---|---|---|---|---|---|---|---|---|
| Long horizon (hours of agent time) | ○† | ○ | | | ● | ● | | | ● |
| Repo-scale, multi-file change | ○ | | | | ● (avg 21 files) | ● (median 51 files) | | | ● |
| Unordered multi-target work (fan-out headroom) | | | | | ○† | ● (median 5 subtasks) | | | ○† |
| Multi-language | ●† | ○† | ○ (V2 only) | ● (8 langs) | | ● (5 langs) | ○† (JS) | | ○† |
| Terminal, ops and environment work | | ● | | | | | | ● | ○ |
| Continuous / partial-credit score | | | | | ○ (Fix Rate) | ● | | ○ | ● |
| Contamination resistance (post-cutoff refresh) | ○ (held-out split) | | ● (monthly) | ● (monthly) | | | | | |
| Economic value weighting | | | | | | | ● ($ payout) | | |
| Harness sensitivity (harness varied, model fixed) | | ○† | | | | | | ● | |
| Performance engineering / ML research | | ○ | | | | | | | ● |
| UI / end-to-end behaviour | | | | | | | ● (Playwright) | | |
| Multi-OS | | | | ● (Windows) | | | | | |

How this maps to the Papercusp capabilities P-011 will ablate [inferred]:

- **Coordination and fan-out:** RoadmapBench is the only suite in these nine whose tasks have unordered,
  independently verified subtargets, so it is where parallel work can show headroom. FrontierSWE and
  SWE-EVO add long single threads. Coordination-native measurement still lives outside these nine
  (`agentsnet`, `swarmbench`).
- **Memory recall and carry across compaction:** FrontierSWE, SWE-EVO and RoadmapBench are long enough to
  force compaction. The short-horizon suites will not exercise it.
- **Harness quality:** Harness-Bench was designed for exactly this, but it is license-blocked. Terminal-Bench
  is the practical fallback, because published harness comparisons on it are common.
- **Clean headline numbers:** SWE-rebench and SWE-bench-Live, because both refresh monthly after model
  cutoffs.

## 4. Recommendations for modernization P-007

These are verdict inputs. Ownership of what to build stays with that plan (D-004).

1. Generalise the FrontierSWE v2 Harbor-verifier grader into a Harbor-task runner before building any more
   per-suite graders. Ordered by value per lift [inferred]: Terminal-Bench 2.1, SWE-bench Pro v2,
   SWE-rebench (Harbor Hub split), RoadmapBench, then SWE-Lancer Diamond IC (needs disk planning).
2. Re-pin SWE-bench Pro explicitly. The current HF load path changes population silently when unpinned.
   Treat v1 and v2 results as separate suites in reporting.
   *Correction, 2026-10-11 06:25Z (su-b7657, WI-6554700010008394):* the adapter does not load from HF at
   run time. It reads a local, untracked `swe_bench_pro_full.csv` (731 rows, still v1 on this host after the
   checkout moved to v2.0.0) [measured]; the silent-swap risk is a CSV re-exported from the HF `default`
   config. Done: `external-bench/swe-bench-pro-pin.ts` pins the v1 population (731, CSV sha256), the
   grader preflight refuses any other CSV, and the catalog and estimate read the count from the pin.
3. Move the Terminal-Bench pin to `@2.1` and install Harbor (pinned version) as a declared prerequisite.
   *Correction, 2026-10-11 06:25Z (su-b7657):* Harbor's `registry.json` on `harbor-framework/harbor` main
   lists `terminal-bench` 2.0 (89 tasks), `terminal-bench-pro` 1.0 and `terminal-bench-sample` 2.0, and no
   2.1 entry [measured]. So `terminal-bench@2.1` is not a resolvable registry id there; confirm the 2.1
   dataset id (Harbor Hub or a local-path dataset of `harbor-framework/terminal-bench-2-1`) with Harbor
   installed before changing the pin.
4. Do not publish Harness-Bench numbers until upstream licenses it. Ask upstream, or drop it from
   `REPORT_ON_SUITES`. That is a scope call for the modernization implementer and the owner.
5. SWE-bench-Live and SWE-EVO fit the existing M1 diff-batch grader shape. Resolve SWE-EVO's license
   mismatch first.
6. Cost columns stay "unmeasured" until real trials exist. P-012 provides the first FrontierSWE figure.
   Record per-trial cost on every run, since the June swe-bench-pro rows have none.

## 5. Reproduce

All reads are metadata-only. The scratch outputs from this survey (not committed) were
`.papercusp/scratch/p008/{gh-pins.tsv,hf.tsv,harbor-registry.json}`.

```bash
# GitHub pin, license and latest release per repo
gh api repos/<owner>/<repo> --jq '[.full_name,.license.spdx_id,.default_branch]|@tsv'
gh api repos/<owner>/<repo>/commits/<branch> --jq '.sha[0:12]+" "+.commit.committer.date'
gh api repos/<owner>/<repo>/releases/latest --jq '.tag_name+"@"+.published_at'
# Hugging Face revision and split row counts
curl -s https://huggingface.co/api/datasets/<id> | jq '{sha,lastModified,license:.cardData.license}'
curl -s "https://datasets-server.huggingface.co/size?dataset=<id>" | jq '.size.splits[]|{config,split,num_rows}'
# Harbor registry at the pinned runner commit
curl -s https://raw.githubusercontent.com/harbor-framework/harbor/09f5b964f8e5/registry.json \
  | jq -r '.[] | "\(.name)@\(.version)\t\(.tasks|length)"'
```

Local measurements: `git grep -l "'<suite-id>'"` for adapter presence;
`harness_shared.bench_runs` joined to `harness_shared.bench_run_tasks` on `run_id`, grouped by `suite`, for
cost and trial counts.
