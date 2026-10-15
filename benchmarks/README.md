# Papercusp impartial benchmark suite — reproducer

> **What this is.** The clone-and-run reproducer for the Papercusp impartial benchmark
> suite: how to re-execute every result we publish, from public task set to official
> grader to scored report. The *why* — the fairness protocol, the layer model, the
> baselines, contamination handling — is the
> **[methodology doc](../apps/operator-docs/src/content/docs/benchmarks/methodology.mdx)**
> (served at `/internal/docs/benchmarks/methodology`). This README is the *how*.

> **Current pilot pending.** Historical results retain their original execution
> identity and protocol. They do not measure today's maintained runtime. Current
> pilot results require a committed protocol, verified execution and complete
> measurement; a small pilot validates measurement and does not establish superiority.

> **Historical scope (D-010).** The Pot/Mug/cup comparisons and earlier plan-item
> references below describe the historical protocol. Current comparisons use the
> maintained su execution path and the stock native CLI under matched controls.
> Keep historical, synthetic, incomplete and current evidence explicitly labeled.

## Current matched runs

The existing preregistration config carries the current protocol defined in
`packages/operator-core/lib/external-bench/reproducibility/schema.ts`. Freeze the
task roster, seeds, arm/client/model/effort/account controls, equal generation
caps, aggregate and in-flight caps, source and loaded runtime revisions, native
client version, prompt and tool identities, prices and official grader identity
before generation. Each assignment restores the same permitted corpus and memory
bytes into a fresh isolated context; other arms' solutions and hidden grader
answers remain forbidden. Runtime observations must match the frozen controls;
requested settings alone do not establish execution identity.

Current SWE-bench Pro grading also freezes `grader.version` as the official
checkout commit, `grader.datasetSha256` as the canonical CSV hash, and
`grader.images` as a task-to-immutable-image-URI map. `grader.imageDigest` hashes
that map with the maintained canonical JSON serializer. The existing grade
entry point verifies the committed protocol before dispatch; the Python wrapper
checks the checkout and CSV and makes the official scorer resolve images by
digest. It records a `grader-receipt.json` beside the grade outputs. Missing
per-task test output, drift or a failed grader process leaves the run ungraded.
Configure the existing `PAPERCUSP_SWEBENCH_EVAL_DIR`,
`PAPERCUSP_SWEBENCH_CSV` and `PAPERCUSP_SWEBENCH_PYTHON` paths on the grading host.

The approved measurement pilot is three tasks × three seeds × two arms with equal
$3 generation caps and a $60 aggregate inference ceiling. Admission records a cap
outcome when an attempt cannot fit. Retries, recovery and every participating role
count toward spend. Keep actual provider billing and normalized cost at frozen
prices distinct; unknown usage or billing remains unknown. Grader outages require
repair/regrade or an inconclusive result. A withheld, power-planned confirmation
study is required for a superiority claim and has no implied authorization to spend.

Freeze `sampling` before a current launch: `unit: "repository"`, a
`taskRepositories` map covering every pilot and withheld confirmation task exactly,
`ci` (0.90, 0.95 or 0.99), `bootstrapSeed` and `bootstrapIterations` (at least 1000).
Use the tasks' actual repository identities. The maintained report collapses each
task's assigned seeds, then draws whole paired repositories with replacement while
retaining task weighting. It records the assigned seed/task denominators and the
number of independent repositories; repeated seeds do not add independent tasks.
Absent assignments and generation failures remain zero outcomes. Missing grades,
fewer than two independent repositories or an older protocol without this policy
produce no primary interval. Such an older protocol remains readable but cannot
start a new current launch. Per-arm interval overlap is not a paired effect test;
read `deltas[].accuracyDeltaCi` and `deltas[].uncertainty`. A comparison with absent
attempts or incomplete usage retains its outcome difference while withholding cost
efficiency. The pooled Wilson interval is a Bernoulli diagnostic, separate from
repository inference.

For a conservative withheld confirmation design, set the existing
`confirmation.method` to `paired-repository-hoeffding-v1`, select the exact
disjoint withheld task roster (`plannedPairedTasks` equals its length), and call
`planCurrentBenchmarkConfirmation(protocol)` from the reproducibility schema
module. It derives repository task weights, a two-sided rejection threshold and
a finite-sample power lower bound from the frozen effect, alpha and target power.
It assumes independent repositories and permits arbitrary dependence within each
repository. Scores are seed-collapsed candidate-minus-control in [-1,1]. Reject
the zero-mean null only when the absolute task-weighted difference exceeds
`nullCriticalValue`; the power guarantee belongs to this rule, not the reporting
bootstrap. An imbalanced roster reduces effective repositories; extra seeds do
not increase them. `meetsTarget:false` explicitly means the roster does not meet
this sufficient planning bound, not that an observed null proves equivalence.
This bound can be demanding: preserve the insufficiency if the suite lacks enough
independent repositories. The helper never authorizes confirmation inference.

Current workload trials reuse the canonical `evaluation-trial` evidence seal and
`verifyEvidence` / `replayTrialEvidence`. Freeze `completionRequirements` with the
workload configuration: required artifact IDs and minimum bytes, durable state
transitions, exact context hashes and consuming actor, and a downstream graded
outcome. Resolve artifact content and receipt authority before constructing the
preserved evidence. Input steps carry the consumed bytes and `contextId`;
tool-result metadata carries the observed `durableTransition` or `workloadOutcome`.
Each observation binds `trialBindingHash`, `runId` and a resolved `receiptRef`.
The validator requires context before transitions and the downstream result after
them, rejects missing/duplicated/foreign observations, and returns the declaration
hash as `completionRequirementsHash`. A receipt reference alone does not prove its
authenticity; the workload resolver must read its authoritative record. A sealed
exit-zero trajectory does not satisfy workload completion. Synthetic validator
tests establish these checks, while actual workload artifacts remain separately
required for measured acceptance.

Evaluation labels imported snapshots as historical archive evidence and explicitly
marked fixtures as synthetic evidence. A current configuration alone is incomplete
evidence: the view requires the complete assigned outcome roster and recorded
matching execution identity with committed preregistration receipts before labeling
it current measured evidence. Missing grades and absent attempts stay visible.
This label does not certify complete provider accounting or establish superiority;
those require their separate measured records and withheld confirmation.

### Current launch prerequisites and verification

Current generation uses `run-launcher.ts` and the authenticated
`POST /api/external-bench/runs/launch` route. The Evaluation launch form selects
the committed protocol ID, isolated workspace, current arm and registered seed.
Its existing estimate read checks the committed protocol, the payer-matched Codex
account and loaded host, then derives the exact launch controls. A historical launch or a successful
refusal fixture does not establish current measured generation or provider billing.

1. Select the `operator-api` current-build route with
   `dev:pipeline_position { path: "packages/operator-core/lib/external-bench/current-su.ts", testClass: "operator-api" }`.
   Verify that its serving runtime contains the tested source. Ordinary acceptance
   uses that current build; final shipment requires separate green-release proof.
2. Register a Codex account **in the isolated benchmark workspace** that matches
   each arm's frozen payer basis (`arm.payer`; omitted means `api-key`). A
   production account pool entry does not populate the benchmark workspace.
   Never disable admission or substitute an ambient login to make a run start.
   - `payer: "subscription"` (the default route for this workspace per
     `benchmark-coverage-frontierswe-v2-2026-10-10#D-023`): register a ChatGPT
     subscription as `accounts:register { workspace: "benchmarks", provider: "codex",
     credentialRef: "codex-cli:<CODEX_HOME>" }`. Requests go `oauth-http` to the
     ChatGPT Codex backend, which rejects `max_output_tokens` and has no input-count
     endpoint, so every request reserves the provider's own limits: the frozen rate
     needs `inputTokenCeiling` (model context window), `outputTokenCeiling` (model
     maximum output) and `inputTokenCeilingSourceSha256 =
     currentBenchCodexSubscriptionContract(model, input, output)`. Budgets and
     reports are **list-price-equivalent** USD (provider-reported usage at frozen
     list prices), not money spent; the estimate read returns
     `costBasis: "list-price-equivalent"`. Prefer an account the fleet gateway is
     not routing heavily during the run: both read and refresh the same `auth.json`.
   - `payer: "api-key"`: register an OpenAI API bearer account. The budget
     authenticator sends `bearer-http` to the official Responses API with a
     measured input count per request and reports metered spend.
   An account whose credential does not match the arm's payer is refused at the
   estimate and at send time.
3. Before freezing the study, calibrate each arm's actual native client, served
   model, effort, loaded source/runtime, instructions and tools on separate
   non-study work. Native template mode must be explicitly pinned as
   `codex-native-template-v1`; retain the exact request hash and host-home binding
   alongside its template hash. Offline fixtures and configured aliases cannot
   supply these measurements. Record calibration spend within the authorized
   aggregate ceiling.
4. Use the existing `preregister()` function to write the canonical protocol and
   its database row. Git-sync owns the commit. `requireCommittedPreregistration()`
   must verify the introducing commit before study generation. Store the same
   permitted corpus/memory bytes at the protocol's repository-relative references.
   Current-study task IDs and the official grader must be selected before new
   study outcomes are observed; calibration tasks stay outside that roster.
5. Launch one registered arm/seed at a time. The request is derived from the
   committed protocol, with this shape (replace the descriptive placeholders):

   ```json
   {
     "arm": "papercusp",
     "taskSetId": "custom",
     "current": {
       "workspaceId": "benchmarks",
       "protocolRunId": "registered-study-id",
       "preregHash": "64-character-canonical-config-sha256",
       "seed": 1,
       "observation": {
         "runtimeWorkspaceId": "workspace-of-the-execution-host-boot-ledger",
         "workerUnit": "execution-host-boot-unit",
         "gatewayUnit": "execution-host-boot-unit"
       }
     }
   }
   ```

   `baseline` selects the stock Codex arm; `papercusp` selects current su. The
   seed must be registered. The host-issued private gateway runs in the worker
   process, so both observation unit fields identify that actual boot unit.
   The observation reader checks the process/kernel identity; these fields do
   not create a runtime receipt. Optional model, task IDs, concurrency and caps
   must equal the frozen protocol. The route supplies authenticated host authority;
   JSON cannot supply a principal. A successful response returns a managed run ID,
   not a completed or graded result. A second attempt of the same arm/seed is
   refused; create a new preregistration for a different protocol.
6. Reconcile the complete task/session/request reservation population at terminal
   state. Inspect `currentExecution.protocolIdentity`, native transcript source
   hashes, provider response IDs, per-event billing evidence, and governor
   settlements. Missing measurement keeps efficiency claims closed. Verify
   cancellation/restart retires the run-owned task subtree, including descendants.
7. Configure the official grading host paths listed above and call
   `POST /api/external-bench/runs/<runId>/grade` in that run's workspace. Retain the
   official source/CSV/image receipt, actual image-use trace and per-task test
   output. A grader error is missing measurement; repair/regrade it or publish an
   inconclusive measurement. Export with
   `GET /api/external-bench/runs/<runId>/export` and compare its frozen assignments,
   outcome denominator and source hashes with the stored run.

The regression checks use the project's real test runner:

```bash
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/external-bench/run-launcher.test.ts \
  packages/operator-core/lib/external-bench/current-su.test.ts \
  packages/operator-core/lib/external-bench/current-su.integration.test.ts \
  packages/operator-core/lib/external-bench/native-stock-harness.integration.test.ts \
  packages/operator-core/lib/external-bench/reproducibility/prereg.integration.test.ts \
  packages/operator-core/lib/external-bench/reproducibility/context.test.ts \
  packages/operator-core/lib/external-bench/xbench-grade-current.test.ts
```

These tests cover protocol drift, host identity, isolation, native lifecycle,
context and grader receipt checks. Their private/no-forwarding fixtures are
regression evidence only. The paid calibration, all eighteen study assignments,
official Docker grading, current workload outcomes, independent certification and
exact shipped-artifact observation need separate measured evidence. Retain test
ledger IDs and source/test/fixture fingerprints; never convert skipped tests or
unmeasured provider bills into passes.

---

## The one invariant

**Generation is arm-specific; grading is byte-for-byte identical across arms.** Every
arm reduces its per-task work to the *same* submission shape and is graded by the
*same* official grader at the *same* pinned version. Change the grader for one arm and
the comparison is void. Preserve this when you re-run.

---

## What gets measured — five layers, two pilots

| Layer | Metric | Headline comparison | Pilot |
|---|---|---|---|
| **L1 competence** | pass@1 (≥3 seeds, CIs) | papercusp spine vs native / ablation / best-of-N | `P-009` |
| **L2 throughput** | tasks/\$, wall-clock speedup, drain time, autonomy | Pot vs Mug-ablated fleet | `P-032` |
| **L3 value-capture** | \$ captured under fixed budget | Pot vs Mug-ablated fleet | `P-032` |
| **L4 coordination** | MAST duplication / breakdown / misalignment rates | Pot vs published MAS baseline + competitors | `P-032` |
| **L5 long-horizon** | multi-step sequencing | Pot vs Mug-ablated fleet | follow-on |

---

## Prerequisites

- **Docker** (≥ 29.x) — for M1 (SWE-bench Pro / SWE-Lancer) and M2 (Terminal-Bench / Harbor).
- **Disk** — per-instance grader images are GB-scale (~50 images for a 50-task pilot).
  Use a **dedicated scratch volume**, prune between families, and grade on a **dedicated
  host/volume**, never inline with the fleet dev box.
- **`uv`** — for Terminal-Bench / Harbor (M2).
- **A model credential** — the *same* model id for every arm (the controlled variable).
- **The Papercusp tree on `staging`**, operator running. Generation runs on normal
  fleet infra; grading is decoupled.

---

## Layout (canonical — owned by `P-010`, migration `291`)

PG is canonical; the files below are the **publication export**.

```
benchmarks/
├── README.md                      ← this file
├── preregistrations/<run_id>.json ← run config committed to git BEFORE the run (tune-to-test firewall)
├── rollouts/<run_id>/<arm>/<suite>__<task_id>__seed-<n>.json   ← Rollout Cards (the published repro unit)
└── runs/<run_id>/manifest.json    ← per-run manifest
```

Three PG tables back this (`benchmark_run_result`, `benchmark_rollout`,
`benchmark_prereg`). `verifyPreregistration()` checks that each run-result row's
`prereg_hash` matches a prereg row whose git commit **predates** the rollouts.

---

## Reproduce a result in five steps

1. **Check out the pre-registered config** (`benchmarks/preregistrations/<run_id>.json`).
   It pins the suite + split, the arm, the model id + sampling params, the budget, the
   seed list, and the exact `grader_family` + `grader_version`. **Do not edit it** —
   pre-registration is what makes "we did not tune to the test" checkable.

2. **Generate** — run each arm (L1 per-task, or the fleet driver for L2–L5) under the
   budget. Each per-task unit emits the same submission record (M1: `{ instance_id,
   patch, prefix }`, `prefix` = seed). See [the arms](#the-arms).

3. **Grade** — hand every arm's submissions to the *same* `OfficialGrader`. See
   [grading](#grading).

4. **Emit + score** — every runner calls the single emit entry point
   `emitRollout(input)` (writes the run-result row + Rollout Card in one tx, derives
   `cost_usd`); then `buildSuiteReport(rows)` from `@papercusp/bench-metrics` computes
   pass@1 + CIs + the cost/accuracy Pareto (and, at L2–L5, throughput / value / MAST
   rates).

5. **Compare against the published Rollout Cards.** A faithful re-run reproduces
   `resolved` per `(task, seed, arm)`; small cost/turn variance is expected, `resolved`
   should not drift for a deterministic grader.

---

## The arms

Both vocabularies are **LOCKED** in `@papercusp/bench-metrics`. L1 (on `TaskRunResult`):
`papercusp` · `baseline-a-ablation` · `baseline-b-native` · `baseline-c-bestofn`. Fleet
(on `FleetRunSummary`): `pot` · `mug-ablated` · `native-serial` · `openhands-async` ·
`crewai` · `langgraph`.

### L1 per-task arms

| Arm | What it is | Generation |
|---|---|---|
| `papercusp` | Full `coding` spine as a throwaway harness | `external-bench` blueprint (**`extends: coding`, overrides nothing**) |
| `baseline-a-ablation` | Spine collapsed to a single worker | `coding-solo` blueprint (**`extends: single-agent`**) |
| `baseline-b-native` | Provider's own harness (Claude Code), elicited to best | Standalone native runner — spawns the `claude` CLI's own loop |
| `baseline-c-bestofn` | N samples + a **visible-only** test-verifier, matched budget | Best verifier-selected diff |

> **D-009 — there is NO `external-bench:run` op.** `papercusp` and `baseline-a-ablation`
> are spun by **one shared `instantiateBenchHarness` port** (`external-bench/run-loop.ts`)
> and differ **only by `blueprintId`** (`external-bench` | `coding-solo`) — so any L1
> delta is attributable to coordination itself. The clone→instantiate→extract-diff→
> grade→emit loop is `arm-generation.ts` (`P-005`), not a blueprint op. The live harness
> driver is bound at the pilot via `setBenchHarnessDriver`. `baseline-b-native` is its
> own primitive (`native-harness-runner.ts`), **not** the single-worker arm — that
> "we didn't nerf the baseline" property is the whole point.

### Fleet-layer arms (Phase 5)

| Arm | What it is | Owner |
|---|---|---|
| `pot` (treatment) | A **fleet driver** hands the whole task SET to a Pot (Mug places/ranks/evicts; cups run the L1 unit), bound at the pilot via `setBenchHarnessDriver` | `P-022` |
| `mug-ablated` (**headline baseline**) | Same fleet + same per-task unit, **naive FIFO/round-robin** in place of the Mug | `P-023` |
| `native-serial` (floor) | One Claude Code session draining the whole backlog serially — the speedup denominator | `P-024` |
| `openhands-async` / `crewai` / `langgraph` | Competitor orchestrators over the same backlog + grader | `P-028` |

The **`pot` − `mug-ablated`** delta is the Mug's value, measured apples-to-apples.
Each fleet arm emits one **`FleetRunSummary`** per backlog run (`runId`, `suite`, `arm`,
`tasks`, `resolved`, `wallClockMs`, `costUsd`, `tokensTotal`, `tasksZeroHumanGate`,
`peakConcurrency?`); the per-task unit it places still emits the locked `TaskRunResult`.
`buildHiveReport(HiveArmInput[]) → HiveBacklogReport` produces per-arm
`{ throughput, value, mast }` + `queenDelta`.

**Submission shape (M1, every per-task unit):**

```json
[ { "instance_id": "instance_astropy__astropy-12345", "patch": "diff --git ...", "prefix": "seed1" } ]
```

`prefix` carries the seed (≥3 per task). The diff is `git diff` of the harness worktree
against `base_commit`, excluding the grader's test files.

---

## Grading

### M1 — SWE-bench Pro (offline diff-batch) — the pilot backbone

Source of truth: `scaleapi/SWE-bench_Pro-os`; dataset `ScaleAI/SWE-bench_Pro`
(`split='test'`); images `jefzda/sweap-images`. Arm-agnostic Docker batch over the
predictions JSON:

```bash
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=<patches>.json \
    --output_dir=<out> \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda
```

`resolved` = **all `FAIL_TO_PASS` pass AND all `PASS_TO_PASS` still pass.**

> ⚠️ "Bash runs by default in these images; do not manually invoke bash." Drive grading
> **only** through `swe_bench_pro_eval.py` — never `docker exec bash` into a sweap image.

Grading is a pure function of the predictions JSON — run it long after generation,
re-run freely, identical for every arm. Same path for SWE-rebench / SWE-bench-Live.

### M1 — SWE-Lancer (L3 value-capture)

SWE-Lancer (arXiv 2502.12115) — \$1M of real freelance SWE tasks, **automated E2E
test grading**, reuses the M1 diff→grader path. Run the \$-weighted backlog under a
**fixed budget** and report \$ captured (`P-027`). **[provisional — runner is `P-027`]**

### M2 — Terminal-Bench 2.0 / Harbor (online in-container)

```bash
uv run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 4   # sanity check
harbor run -d "terminal-bench@2.0" --agent claude-code                            # baseline-b-native (built in)
harbor run -d "terminal-bench@2.0" --agent-import-path papercusp_harbor:PapercuspAgent  # [provisional — P-005]
```

Competitor orchestrators (`P-028`) likewise plug in via Harbor's adapters. `resolved` =
Harbor's pass/fail; no `FAIL_TO_PASS`/`PASS_TO_PASS` split.

### L4 — MAST coordination-quality (re-implemented, license-clean)

The MAST repo has **no declared license**, so we **do not run their judge code**.
Instead we **re-implement the published 14-mode / 3-category rubric** (system-design ·
inter-agent-misalignment · task-verification) and score it with our own judge. Two legs
(`scoreMast({ arm, tasks, trace, verdicts }) → MastReport`):

- **Objective substrate-signal rates (no judge):** every fleet arm emits a raw
  `CoordEvent[]` trace (`{ ts?, kind, agent?, taskId?, detail? }`); `substrateSignalRates()`
  counts the mechanical failure signals `duplicate_completion` / `orphaned_claim` /
  `stranded_item` / `lost_handoff` / `claim_conflict` / `superseded_work` / `rework`.
- **LLM-judge per-category rates:** our judge emits `MastVerdict[]` → `MastReport.byCategory`.

Report both against the **published MAST baseline** (`MastReport.masBaselineBand` =
`[0.41, 0.86]` — re-confirm the exact figures verbatim against arXiv 2503.13657 before
publishing) + the `mug-ablated` fleet + competitors. `P-010` captures the
`CoordEvent[]` into the rollout; `P-026` scores it.

### M2-local — Harness-Bench (`clawbench_v2`)

28/106 tasks public + no license ⇒ **methodology citation + a labeled 28-task
cross-check only**, never a headline. Full 106-task run deferred (`P-014`).

---

## The run-result schema (LOCKED v1)

One row per `(run_id, suite, task_id, arm, seed)` — `UNIQUE` on that tuple (idempotent
re-emit). **All arms emit through one function:**

```
emitRollout(input) → { rollout_id, run_id }
// packages/operator-core/lib/external-bench/reproducibility/emit.ts
```

It writes the `benchmark_run_result` row **and** the `benchmark_rollout` card in one
transaction, derives `cost_usd` via `priceRun()`, and fires
`notifySyncInvalidate('evals.runs', …)`. Key fields:

| field | source | notes |
|---|---|---|
| `run_id` / `prereg_hash` / `suite` / `task_id` / `arm` / `seed` / `modality` | runner | identity; `prereg_hash` must match a `benchmark_prereg` row |
| `generation_status` | runner | `completed` \| `error` \| `timeout` \| `budget_exhausted` |
| `resolved` (**nullable**) | grader | per-submission verdict; `NULL` retains unavailable grading; the primary denominator is assigned work |
| `grader_status` / `grader_family` / `grader_version` / `grader_error` | grader | `grader_error` is **distinct** from `resolved=false` |
| `tokens_in` / `tokens_out` / `tokens_total` | runner | `tokens_total` = **SUM over ALL roles / candidates + verifier** |
| `tokens_cache_read` / `tokens_cache_write` | runner | material to \$ on Opus |
| `cost_usd` / `price_table_version` | derived | `priceRun()` at emit; tokens canonical, \$ re-derivable |
| `wall_clock_ms` / `turns` / `budget_tokens` / `capped` | runner | `budget_tokens` caps **generation only**; `capped` ≠ infra fail |
| `model_id` / `harness_version` / `arm_meta` (jsonb) | runner | best-of-N puts `{n, candidates, verifier_tokens}` in `arm_meta`; fleet/coordination events for MAST |

**Primary assigned-task outcome:** verified successes divided by the frozen assigned
population. Generation errors, timeouts, cap outcomes and non-attempts remain in
that denominator. A submission whose grade is missing makes the primary result
unavailable until repaired; a grader outage is not evidence of agent failure.

**Secondary conditional graded quality:** verified successes divided by genuinely
graded submissions. Its label and denominator must accompany the value. For
example, one success among five assignments, with one generation error and three
non-attempts, is **20% primary assigned outcome** and **100% conditional quality
(1/1 graded)**. Report attempted, absent, generation-failure and missing-grade
counts alongside both. Historical row-level `resolved=NULL` values stay intact;
they are not a license to drop failed or absent assignments from the primary
denominator. Seed counts are matched across arms; repeated seeds are not independent
task observations for a confirmation claim.

**Type source of truth:** `TaskRunResult` → `@papercusp/bench-metrics` (`P-011` —
defined in `libs/generic/bench-metrics/src/schema.ts`, imported from the package root,
*not* a `/schema` subpath); `RolloutRecord` + `PreregConfig` + `emitRollout` →
`packages/operator-core/lib/external-bench/reproducibility/` (`P-010`); migration
`291-benchmark-reproducibility.sql`. The **L2 fleet layer** adds `emitFleetRun` /
`emitCoordEvents` / `fleetRunIdFor` (`reproducibility/fleet.ts`, migration
`292-benchmark-pot-layer.sql`); fleet runs read via `evals.fleet` / `evals.coordTrace`.
**Do not redefine.**

---

## Cost accounting (don't cheat this)

Each arm's `tokens_total` (and so `cost_usd`) includes **every** token the system
spends — every Mug decision, every cup, every hand-off, every coordination message
(and for best-of-N, all N candidates + the verifier). Under-counting coordination
overhead is the single easiest way to fake a win; the suite counts it all and reports
*"net of all coordination overhead, better per dollar."* `cost_usd` is **derived** from
raw tokens at a pinned `price_table_version`.

---

## Pre-registration & the gym firewall (the anti-tuning guarantees)

- **Pre-registration:** each run config is committed to git
  (`benchmarks/preregistrations/<run_id>.json`) **before** the run, keyed by
  `prereg_hash` (sha256 of the canonical config). A re-runner diffs the published config
  against the live run to confirm nothing was tuned after results were seen.
- **Gym ↔ report firewall** (`packages/operator-core/lib/gym/report-set-firewall.ts`):
  the gym's optimize-on sets (`gym-synthetic`, `gym-real-anchor`) and the report-on
  suites (`REPORT_ON_SUITES`, which *is* the `suite` vocabulary) are **statically proven
  disjoint in CI**, and the gym's task-ingestion choke point refuses any task that
  fingerprints to a report-on benchmark.

---

## Provenance & links

- **Methodology:** `/internal/docs/benchmarks/methodology`.
- **Overview:** `/internal/docs/benchmarks/`.
- **Feasibility spikes:** L1 grader interface — D-008 /
  `apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md`; fleet instruments
  — D-011 / `apps/operator/docs/pot-instrument-feasibility-2026-06-15.md`.
- **Plan:** `impartial-benchmark-suite-2026-06-15` (decisions D-001 … D-011).
- **Ownership:** `external-bench` blueprint (`P-019`), grader adapter (`P-005`),
  Baseline A (`P-006`), Baseline B (`P-007`), Baseline C (`P-008`), cost/scoring +
  schema (`P-011`), reproducibility + pre-registration (`P-010`), gym firewall (`P-012`),
  pot-backlog runner (`P-022`), Mug-ablation (`P-023`), native serial floor (`P-024`),
  fleet metrics (`P-025`), MAST (`P-026`), SWE-Lancer value (`P-027`), competitors
  (`P-028`), eval views (`P-030`).
