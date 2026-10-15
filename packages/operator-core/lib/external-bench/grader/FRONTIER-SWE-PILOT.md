# FrontierSWE grader — v2 controls and pilot runbook

Operational "how to actually run it + what it costs" for the **FrontierSWE** suite
(`frontier-swe.ts` + `frontier-swe-live.ts` + the `task-sets.ts` loaders). Methodology
narrative: `apps/operator-docs/.../benchmarks/frontier-swe.mdx`. Current plan:
`benchmark-coverage-frontierswe-v2-2026-10-10`. The v1 sections below preserve the
2026-06-18 integration as history; they do not launch a current v2 treatment.

> Paid execution is **owner-gated**. D-001 authorizes only the bounded P-012 smoke under
> an owner-set hard USD cap; inference cannot start until that cap is recorded. P-013
> calibration and P-014 headline need fresh approval; P-015 canary was declined for now.
> D-014 records the **exact model / reasoning effort max for every initial setup**. Resolve
> that pin from `benchmark-coverage-frontierswe-v2-2026-10-10#D-014`. This document
> describes preparation and no-LLM controls, not approval or proof that a runtime is ready.

## What was confirmed against the v1 harness (history)

Every task is a self-contained Docker env with a uniform contract:

- `tasks/<task>/task.toml` — `[metadata]` (category, difficulty, tags), `[agent].timeout_sec`
  (4–20 h), `[verifier].timeout_sec`, `[environment]` (`docker_image` = `ghcr.io/proximal-labs/
  frontier-swe/<task>:vN`, cpus/memory_mb/storage_mb, **gpus + gpu_types**, allow_internet).
- `tasks/<task>/instruction.md` — the agent brief (workspace layout + build/test commands).
- `tasks/<task>/tests/test.sh` — the **verifier entrypoint**; runs `compute_reward.py` →
  writes **`/logs/verifier/reward.txt`** (the bare `[0,1]` scalar — the uniform primary) +
  **`/logs/verifier/reward.json`** (structured per-task breakdown). `HARBOR_ORACLE_MODE=1`
  skips anti-cheat (the gold/oracle path).
- `tasks/<task>/solution/solve.sh` — the **gold** reference (the C9 positive control). **6
  tasks ship no solution** (`frogsgame-rl`, `lua-native-compiler`, `modular-stack-wan21`,
  `notebook-compression`, `postgres-sqlite-wire-adapter`, `pyright-type-checking-optimization`).
- `tasks/<task>/oracle.yaml` / `job.yaml` — the Harbor run configs (the `job.yaml` `agents:`
  list IS the public competitor pool at the pinned upstream commit — read it from there, never from a
  copy here: a pool written into this runbook goes stale the moment the leaderboard moves on).

**v1 rows only:** our TS grader reads **`reward.txt`** (falls back to `reward.json` `reward`/`score`). A
present-and-numeric reward (incl. `0`) is SCORED; an absent reward is a `graderError`. v2 rows use Harbor
precedence instead (see the v2 section below).

## FrontierSWE v2 (plan benchmark-coverage-frontierswe-v2-2026-10-10, D-002)

> ⚠ **v2 supersedes the v1 material below.** v2 is a SEPARATE repository, `Proximal-Labs/frontier-swe-v2`,
> pinned at `da83f84f8fbcec3cbf0f2b17c98ebc811355c2df` (2026-09-19): 34 tasks, Harbor `task.toml` schema 1.3,
> every agent AND verifier image digest-pinned at `us-west1-docker.pkg.dev/proximal-core-0/proximal-evals-public`,
> the verifier in a SEPARATE fresh container (`environment_mode = "separate"`), offline verifiers spelled
> `network_mode = "no-network"`, and five tasks needing a `job.yaml` runtime profile (Modal VM runtime and/or a
> `px-evals-gcr-secret` registry secret). No LICENSE (research/eval only). The smoke, envelope table and
> `ghcr.io/...:vN` images further down are **v1 history**.
>
> **v2 grading (P-003 / D-003).** A v2 row is graded in a fresh container started from the task's digest-pinned
> verifier image (as root): every `task.toml` `artifacts` entry is copied out of the agent container and
> re-materialized at its original source path, then `/tests/test.sh` runs with `[verifier.env]`. Reward precedence
> is Harbor's: `reward.json` is primary whenever it exists; `reward.txt` is read only when it is absent; an empty,
> non-numeric or non-finite file (or neither file) is a `graderError` — a malformed `reward.json` never falls back
> to `reward.txt`. Each row is pinned `frontier-swe@v2+<commit12> verifier=<image@sha256:…>`. Use the v2 task sets
> `frontier-swe-v2` · `frontier-swe-v2-pilot` (one distinct task per README suite category) · `frontier-swe-v2-cpu`
> (no GPU, no external service) · `frontier-swe-v2-custom`; the v1 ids (`frontier-swe-pilot`, …) read only the v1
> corpus, and the report refuses to mix the two. GPU passthrough for v2 GPU verifiers is not wired yet.

**Vendor (data only — nothing from the checkout is ever executed).** A sparse, shallow fetch of just the task
definitions (~2 MB); the GB-scale images are a separate, later step:

```bash
D=~/.papercusp/bench-harnesses/frontier-swe-v2
mkdir -p "$D" && cd "$D" || exit 1
git init -q && git remote add origin https://github.com/Proximal-Labs/frontier-swe-v2
git config core.hooksPath /dev/null
git sparse-checkout set --no-cone '/tasks/*/task.toml' '/tasks/*/instruction.md' \
  '/tasks/*/solution/solve.sh' '/tasks/*/oracle.yaml' '/tasks/*/job.yaml' '/LICENSE*' '/README.md' '/CHANGELOG.md'
git fetch -q --depth 1 --filter=blob:none origin da83f84f8fbcec3cbf0f2b17c98ebc811355c2df
git -c advice.detachedHead=false checkout -q FETCH_HEAD
```

**Ingest (committed + tested: `frontier-swe-ingest.ts`, `scripts/frontier-swe-ingest.ts`).** Run from the repo
root; the commit is read from the checkout's own `.git/HEAD`, never typed:

```bash
npx tsx scripts/frontier-swe-ingest.ts --root ~/.papercusp/bench-harnesses/frontier-swe-v2 \
  --v1-corpus ~/.papercusp/bench-results/frontier-swe/tasks.jsonl
# → FRONTIER_SWE_INGEST ok commit=da83f84f… tasks=34 license=none out=~/.papercusp/bench-results/frontier-swe-v2 v1History=17 retiredInV2=11
```

It writes, under `~/.papercusp/bench-results/frontier-swe-v2/` (`--out` to override):

- `tasks.jsonl` — one row per task: category, tier, `corpusVersion: 'v2'`, `upstreamCommit`, agent + verifier
  images, agent/verifier timeouts, CPU/memory/storage, GPU count + types, `networkMode` / `verifierNetworkMode` /
  `allowInternet`, `externalNeeds` (from `job.yaml`), and gold availability (`solutionCmd`).
- `manifest.json` — upstream repo, commit, license status, and for EVERY task its commit plus agent and verifier
  image digests.
- `v1-history.jsonl` — the old 17-row corpus labelled `corpusVersion: 'v1'` with `retiredInV2` (exact-id match:
  a renamed v2 successor counts as a different task). Its own file, so it can never aggregate with v2.

The ingest REFUSES (exit 1, every problem listed) a non-40-hex commit, an empty checkout, an unparseable
`task.toml` or `job.yaml`, and any task whose agent or verifier image is not digest-pinned.

## V2 controls and scored-task admission (no LLM spend)

D-013 places grading on the dedicated **750 GB `/mnt/bench`** volume with its own Docker
daemon at `unix:///run/docker-bench.sock`. Honor each task's declared limits: the ingested
v2 corpus includes `storageMb = 524288` (512 GiB), beyond the old v1 envelope below.

The maintained control runner is `scripts/frontier-swe-controls.ts`. It checks the checkout
against the corpus pin, runs one CPU-runnable task at a time, appends durable rows, and
removes images between tasks. A completed non-error `(task, mode)` pair is skipped on resume.
Attach an already-running control job by its saved task id; do not launch a second copy.
For a new or stopped run, from the canonical repository root:

```bash
DOCKER_HOST=unix:///run/docker-bench.sock npx tsx scripts/frontier-swe-controls.ts \
  --repo /mnt/bench/work/frontier-swe-v2 \
  --out /mnt/bench/work/controls/2026-10-11
```

Gold mirrors Harbor's oracle user/environment and stages `solution/solve.sh`. V2 oracle
scripts write a fresh `HARBOR_ORACLE_FLAG` marker; the separate verifier then scores its
image's reference. A performance baseline can earn **0 by construction**, so inspect
`oracle.logTail`, `exitCode`, `timedOut` and grading detail before calling it a failed solve.
Empty grades the untouched scaffold. A real numeric zero is a scored result; infrastructure
failure has no usable score.

`frontier-swe-control-ledger.ts` enforces FSWE-P007-GOLD/EMPTY: **gold = 1, empty = 0** at
the task's corpus commit and agent image. Missing, errored or mismatched evidence excludes;
the latest `finishedAt` wins. Positive empty floors and baseline gold below 1 stay excluded;
no tolerance is authorized. This is a conservative cohort-admission rule, not a claim that
every excluded task or reference solution is broken.

After the existing whole control job finishes, tabulate the latest rows and inspect gold
failures. Publish the validated `results.jsonl` to
`~/.papercusp/bench-results/frontier-swe-v2/controls.jsonl`, then use
`readFrontierSweControlLedger` / `admitByFrontierSweControls` to record admitted and excluded
tasks and verify `loadFrontierSweTaskSet('frontier-swe-v2-cpu')`. The override is
`PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL`. Every scored v2 set is gated by default and
refuses if nothing is admitted. `controls: 'ignore'` is only for producing controls.

D-015 enforces agent network policy fail-closed: `no-network` uses `--network none`;
`allowlist` also does so unless an arm supplies an egress-restricted network. Initial
controls started before enforcement retain their open-egress caveat in the measured
acceptance decision; they do not prove campaign network fidelity.

## Current v2 runtime and reporting contract

D-004 keeps the integration on the modernization plan's maintained surfaces: P-003
current-su/native-fleet launch adapter, P-004 stock/native references and scoped ablations,
P-005 complete aggregate accounting, P-006 frozen protocol and P-008 Evaluation UI.
The bespoke `makeFrontierSweRunAgent` example below is historical. A setup is runnable
only after observed model/effort/account/runtime identity, container checkpoint/resume,
terminal artifacts, cancellation and all-role accounting are verified. A configured
model label alone does not prove support for D-014's model and max effort in a reference client.

For v2, **mean@5 is primary**; best@5, AVG RANK and dominance are secondary. Complete
task means receive equal weight. The report freezes assigned tasks/arms when supplied;
an incomplete task makes that arm's headline and interval unavailable, while its
complete-task conditional rollup remains explicitly labelled. Intervals resample task
means and paired differences resample matched tasks, not individual seeds. Report
excluded pairs, category overlap, small task counts and trials. V1 history stays separate.

The portable report shows measured USD per assigned task, token totals and a descriptive
cost/score Pareto view. Unknown cost, incomplete grades, absent attempts, observed-only
assignments or incompatible cost bases cannot establish efficiency. Positive per-task
winner ties retain each winner's full recorded task-trial cost; zero-outcome ties have no
successful winner. These projections do not replace missing worker/leader/consult/retry/
recovery telemetry, which remains modernization P-005. No headline or efficiency claim
follows from preparation, local report tests or a conditional score.

## Prerequisites — v1 (history; provision on a dedicated grading volume, NOT the shared dev box)

1. **Docker** (daemon up). 5 tasks additionally need a **datacenter GPU** (see the table).
2. **The vendored repo** — `git clone --depth 1 https://github.com/Proximal-Labs/frontier-swe
   ~/.papercusp/bench-harnesses/frontier-swe` (~1.3 GB; **no LICENSE** → research/eval only,
   D-005). Set `PAPERCUSP_FRONTIER_SWE_DIR` to it.
3. **ghcr access** to pull `ghcr.io/proximal-labs/frontier-swe/<task>:vN` (GB-scale images).
4. **The corpus JSONL** — the v1 corpus at `~/.papercusp/bench-results/frontier-swe/tasks.jsonl` is kept as
   history; its hand-pasted Python ingest is retired in favour of the committed ingest above.

## V1 preflight (history; no spend)

```ts
import { preflightFrontierSwe, describeFrontierSweRun } from './grader/frontier-swe-live';
const pf = await preflightFrontierSwe({ repoDir: process.env.PAPERCUSP_FRONTIER_SWE_DIR });
// → { ready, docker, repo, corpus, issues[] }  (never pulls an image / runs a task)
console.log(describeFrontierSweRun('<container>'));
```

## V1 bounded smoke — historical gold/empty controls

> ✅ **VALIDATED 2026-06-18 on `libexpat-to-x86asm`** (no LLM): gold (oracle solution) → `reward.txt = 0.98511`
> (correctness 1.0 + performance 0.9702, weights 0.5/0.5); empty (unsolved) → `0.0` ("No .so found"). This
> confirms ghcr access, the seam clone→grade path, the `reward.txt`→[0,1] read-back, the `reward.json`
> schema, and the perf-task formula. **The seam stages `tests/` (and `solution/` in oracle mode) into the
> container at GRADE time from `PAPERCUSP_FRONTIER_SWE_DIR`** — the image bakes only `/app`, so that env MUST
> be set for a live run.

Run ONE cheap CPU task end-to-end before any batch. Pick from `frontier-swe-cpu`.

```bash
img=ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6
cid=$(docker run -d "$img" sleep infinity)
# (1) GOLD / positive control — run the reference solution then the verifier in oracle mode:
docker exec -e HARBOR_ORACLE_MODE=1 "$cid" bash -lc 'bash /solution/solve.sh && bash /tests/test.sh'
docker exec "$cid" cat /logs/verifier/reward.txt    # expect a HIGH reward (~1.0)
# (2) EMPTY / negative control — fresh container, verifier only, no agent work:
cid2=$(docker run -d "$img" sleep infinity)
docker exec "$cid2" bash -lc 'bash /tests/test.sh'
docker exec "$cid2" cat /logs/verifier/reward.txt   # expect ~0
docker rm -f "$cid" "$cid2"
```

The TS path: `buildLiveFrontierSweGrader().grade([{modality:'in-container', instanceId, envRef: cid, prefix:'seed-0'}], tasks)`
→ runs `test.sh` → reads `reward.txt` → `GradeResult{ score }` → the run-result row.

## V1 per-task envelope (history)

| task | bucket | gpu | agent h | mem GB | gold? |
|---|---|---|---|---|---|
| cranelift-codegen-opt | performance | — | 20 | 128 | ✅ |
| dart-style-haskell | implementation | — | 20 | 8 | ✅ |
| dependent-type-checker | implementation | — | 20 | 32 | ✅ |
| ffmpeg-swscale-rewrite | performance | — | 8 | 64 | ✅ |
| frogsgame-rl | research | — (Tinker API) | 8 | 64 | — |
| git-to-zig | implementation | — | 20 | 16 | ✅ |
| granite-mamba2-inference-optimization | performance | **B200** | 20 | 64 | ✅ |
| inference-system-optimization | performance | **B200** | 4 | 128 | ✅ |
| libexpat-to-x86asm | implementation | — | 20 | 8 | ✅ |
| lua-native-compiler | implementation | — | 8 | 32 | — |
| modular-stack-wan21 | implementation | **H100** | 4 | 128 | — |
| notebook-compression | performance | — | 8 | 32 | — |
| optimizer-design | research | **H100** | 20 | 128 | ✅ |
| pcqm4mv2-autoresearch | research | **H100** | 20 | 128 | ✅ |
| postgres-sqlite-wire-adapter | implementation | — | 8 | 32 | — |
| pyright-type-checking-optimization | performance | — | 20 | 32 | — |
| revideo-perf-opt | performance | — | 20 | 32 | ✅ |

`frontier-swe-cpu` = the 12 GPU-free tasks. The 5 GPU tasks need B200/H100.

## V1 env vars (history)

- `PAPERCUSP_FRONTIER_SWE_VERSION` — the grader version pin (repo commit / image-set tag). **Required.**
- `PAPERCUSP_FRONTIER_SWE_DIR` — the vendored checkout (preflight + gold control + ingest).
- `PAPERCUSP_BENCH_FRONTIER_SWE_JSONL` — override the corpus path.
- `TINKER_API_KEY` — only for `frogsgame-rl`.

## V1 topology-arm code path (history; not the maintained v2 launch)

This preserves the original v1 wiring for historical replay only. Current v2 treatment
integration consumes the maintained modernization adapter described above; do not use
this bespoke in-container loop to claim current Papercusp or same-model reference support:

```ts
import { makeFrontierSweRunAgent } from '../frontier-swe-runagent';   // adapts metr-hcast singleOpusDriveArm
import { runFrontierSweResilient } from '../frontier-swe-arm';
import { resolveCoordinationSpec } from '../coordination-topology';
// live bindings (metr-hcast-live.ts): the :8788-gateway model call + docker exec
const runAgent = makeFrontierSweRunAgent({ modelCall: liveGatewayModelCall, exec: liveDockerExec });

await runFrontierSweResilient({
  spec: resolveCoordinationSpec(blueprint),  // su-independent (no-coord) | pot (central) | dist-broadcast/-peer-review/-blackboard (distributed) | (ensemble/pair)
  taskSetId: 'frontier-swe-cpu',             // 12 GPU-free tasks; the 5 GPU tasks need B200/H100
  k: 5,                                      // 5 trials → mean@5 / best@5
  resultsPath: '<dedicated-volume>/frontier-swe/runs/<arm>.jsonl',  // durable; re-invoke to resume only missing (task,seed)
  runAgent,
  budget: { maxModelCalls: N, maxWallMs: M },  // iso-budget — wall-clock is load-bearing (4–20h/task)
  rowMeta: { version, modelId: pin.model.modelId /* pinEvaluatedModel() */, harnessVersion, preregHash, rolloutId },
});
// rows → buildFrontierSweSuiteData(rows) (mean@5/best@5/avgRank/dominance) + buildFairnessAudit (the C1–C10 table).
```

Run ≥2 arms (e.g. `su-independent` vs `pot`) over the same tasks + same iso-budget for the topology lift (D-002).
Interrupted? Re-run the same call — only missing trials re-execute.

**Workspace isolation (mandatory — plan benchmark-workspace-isolation-2026-06-18):** the launcher MUST resolve any
run/telemetry workspace via `resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID)` (`bench-workspace.ts`) —
default `'benchmarks'`, NEVER the production `'papercusp-workspace'` (the guard throws on prod). FrontierSWE's
in-container agents are sandboxed (bash+submit only) so they don't reach host memory/coord/work-items, but the
launcher must still isolate the run-store/telemetry workspace as defense-in-depth.

## Discipline

- **Two-port model** — the bench routes `PAPERCUSP_OPERATOR_BASE=:3170` (staging) + the
  `:8788` gateway; **never probe `:3070`** (green release).
- **Fairness** — every number ships with the **C1–C10 audit** (`buildFairnessAudit`); see
  `benchmarks/fairness-criteria`. Iso-budget includes **wall-clock** here.
- **Reliability** — long big-repo trials are the worst case for slow-but-alive
  heartbeat-reclaim; the liveness fix shipped (F-FIX-038 / EI-1293). If cups stall at `$0`,
  check `harness_shared.agent_rate_budget` for a far-future `paused_until` (governor
  false-pause runbook: `agent-insights/rate-limit-is-usually-account-routing-not-capacity`).
- **License (D-005)** — no redistribution of derived data without owner sign-off.
