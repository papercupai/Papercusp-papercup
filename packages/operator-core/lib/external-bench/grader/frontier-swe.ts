/**
 * {@link OfficialGrader} backend for **FrontierSWE** (Proximal Labs — v1 github.com/Proximal-Labs/frontier-swe, plan
 * `benchmark-suite-frontier-swe-2026-06-18`; v2 github.com/Proximal-Labs/frontier-swe-v2, plan
 * `benchmark-coverage-frontierswe-v2-2026-10-10` P-003 / D-003).
 *
 * UNLIKE the SWE-bench-family graders (apply a unified diff → run hidden tests → boolean resolved), FrontierSWE
 * is an ULTRA-LONG-HORIZON, CONTINUOUS-SCORE suite (implementation / performance / research work; 4–20h agent
 * budgets; no model fully solves the implementation tasks). Each task ships ITS OWN scorer — `tests/test.sh` (the
 * verifier entrypoint) writes `/logs/verifier/reward.json` (structured) and/or `/logs/verifier/reward.txt` (the bare
 * scalar). We do NOT author a verifier — the fairness invariant is that every arm hits the byte-identical task
 * scorer (D-001 / metr-hcast D-004: drive the task's own score, don't reimplement it).
 *
 * TWO CORPUS VERSIONS, NEVER MIXED (plan R-1). Every grade row is stamped with a per-task `graderVersion` that
 * names its corpus — `frontier-swe@v2+<commit12> verifier=<image@sha256>` or `frontier-swe@v1 <pin>` — and
 * {@link frontierSweGraderCorpusVersion} reads it back, so the report refuses to aggregate the two.
 * - v1 (HISTORY, `environment_mode` shared): the verifier runs INSIDE the arm's own container; `reward.txt` is
 *   read first and `reward.json` is the fallback (the original contract, unchanged).
 * - v2 (`environment_mode = "separate"`, D-003 §1-2): the verifier runs in a FRESH container from the task's
 *   digest-pinned VERIFIER image, with the task's `artifacts` copied over from the arm's container. That
 *   environment is prepared + released by the injected {@link FrontierSweGraderConfig.prepareVerifierEnv} hook.
 *   Reward precedence is HARBOR's (D-003 §3, {@link resolveHarborReward}): `reward.json` is primary whenever it
 *   exists and a malformed one NEVER falls back to `reward.txt`.
 *
 * SCORE: continuous `score ∈ [0,1]` rides {@link GradeResult.score}; `resolved = (score >= 1)` is the degenerate
 * binary. The suite headline is mean@5 / best@5 over the continuous score + AVG-RANK / dominance across a
 * coordination-topology arm pool (see `@papercusp/bench-metrics` frontier-rank.ts), NEVER a single resolved%.
 *
 * The verifier invocation, the reward read and the separate-environment lifecycle are INJECTED, exactly like the
 * SWE-bench-Verified + TheAgentCompany graders inject their harness CLI — the Docker invocation is host-specific
 * (see `frontier-swe-live.ts`). The pure scoring maps are unit-tested with fixtures, NO docker.
 *
 * C1/C6 FAIRNESS RECONCILIATION (plan D-003): a verifier that RAN and emitted a numeric reward — even `0` from an
 * empty / no-progress workspace — is a genuine capability outcome that COUNTS (score 0, never a vanished row). A
 * verifier that itself FAILED to produce a valid reward (image/infra/OOM/timeout, or a malformed reward file) is a
 * `graderError` — surfaced and excluded symmetrically across arms, NEVER silently scored 0 as if the agent failed.
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const GRADER_FAMILY = 'frontier-swe';

/**
 * The verbatim reward files a verifier left behind. `null` means the file is ABSENT; a present-but-empty file is
 * `''`. Harbor precedence (D-003 §3) needs exactly this distinction — "absent" and "empty" are different verdicts.
 */
export interface FrontierSweRewardFiles {
  /** `/logs/verifier/reward.json` text, or `null` when the file does not exist. */
  json: string | null;
  /** `/logs/verifier/reward.txt` text, or `null` when the file does not exist. */
  txt: string | null;
}

/**
 * The reward a task's verifier emitted, as read out of the container. v1 (shared) grading uses the parsed
 * `rewardScalar` / `rewardJson` pair; v2 grading resolves `files` with Harbor precedence and requires them.
 */
export interface FrontierSweRawReward {
  /** The bare [0,1] scalar parsed from `/logs/verifier/reward.txt`. `null` when the file is absent/unparseable. */
  rewardScalar: number | null;
  /** The structured `/logs/verifier/reward.json` (per-task keys), stored verbatim. Optional. */
  rewardJson?: unknown;
  /** The raw files (absent vs present distinguished). REQUIRED for v2 grading; ignored by the v1 path. */
  files?: FrontierSweRewardFiles;
}

/** Pull a [0,1] reward out of a structured `reward.json` regardless of which key the task used (`reward`/`score`). */
export function rewardFromJson(json: unknown): number | null {
  if (typeof json === 'number' && Number.isFinite(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['reward', 'score'] as const) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** Clamp a raw reward into [0,1] (a buggy verifier can't push the score out of range). */
function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/** The outcome of resolving reward files with Harbor precedence. */
export type HarborRewardResolution =
  | {
      ok: true;
      /** The headline reward for the task. */
      reward: number;
      /** Which file it came from. */
      source: 'reward.json' | 'reward.txt';
      /** The json key the headline came from (`null` for a bare number or reward.txt). */
      key: string | null;
      /** Every named reward the file carried (a bare number → `{}`), kept for reproducibility. */
      rewards: Record<string, number>;
    }
  | { ok: false; error: string };

/** A decimal float literal (what Python `float()` accepts minus inf/nan/underscores — those are errors here). */
const FLOAT_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Resolve a verifier's reward files with HARBOR precedence (D-003 §3; Harbor `src/harbor/verifier/verifier.py`):
 * 1. `reward.json` is PRIMARY whenever it exists: a bare finite number, or an object of name → finite number. The
 *    headline is its `reward` key, else its `score` key, else its sole key; several keys with neither name is
 *    ambiguous. Empty, unparseable, non-numeric or non-finite → error — and it NEVER falls back to `reward.txt`.
 * 2. `reward.txt` is read only when `reward.json` is ABSENT: one finite float; empty / non-numeric → error.
 * 3. Neither file → error (Harbor's RewardFileNotFoundError).
 * Every error becomes a `graderError` (score null), never a 0.
 */
export function resolveHarborReward(files: FrontierSweRewardFiles): HarborRewardResolution {
  if (files.json !== null) {
    const text = files.json.trim();
    if (text === '') return { ok: false, error: 'reward.json exists but is empty' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `reward.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    if (typeof parsed === 'number') {
      return Number.isFinite(parsed)
        ? { ok: true, reward: parsed, source: 'reward.json', key: null, rewards: {} }
        : { ok: false, error: 'reward.json holds a non-finite number' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'reward.json must be a number or an object of name → number' };
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return { ok: false, error: 'reward.json is an empty object (no rewards)' };
    const rewards: Record<string, number> = {};
    for (const [k, v] of entries) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, error: `reward.json value '${k}' is not a finite number (${JSON.stringify(v)})` };
      }
      rewards[k] = v;
    }
    const key = 'reward' in rewards ? 'reward' : 'score' in rewards ? 'score' : entries.length === 1 ? entries[0][0] : null;
    if (key === null) {
      return {
        ok: false,
        error: `reward.json has ${entries.length} rewards (${Object.keys(rewards).join(', ')}) and none is 'reward' or 'score' — ambiguous headline`,
      };
    }
    return { ok: true, reward: rewards[key], source: 'reward.json', key, rewards };
  }
  if (files.txt !== null) {
    const text = files.txt.trim();
    if (text === '') return { ok: false, error: 'reward.txt exists but is empty' };
    if (!FLOAT_LITERAL.test(text)) return { ok: false, error: `reward.txt is not a finite number (${JSON.stringify(text.slice(0, 40))})` };
    const reward = Number(text);
    if (!Number.isFinite(reward)) return { ok: false, error: 'reward.txt holds a non-finite number' };
    return { ok: true, reward, source: 'reward.txt', key: null, rewards: {} };
  }
  return { ok: false, error: 'neither reward.json nor reward.txt exists (verifier produced no verdict)' };
}

/**
 * The v1 pure scoring map (unchanged contract). Folds one task's emitted reward into a {@link GradeResult}.
 * `reward.txt`'s scalar wins; else the `reward.json` `reward`/`score` key. A reward that is present-and-numeric
 * (incl. `0`) is SCORED (counts in the denominator); a reward that is entirely ABSENT means the verifier produced no
 * verdict → `graderError`, `score:null`, `resolved:false` — surfaced + excluded, never a silent 0 (C6 / D-003).
 */
export function parseFrontierSweReward(
  raw: FrontierSweRawReward | null | undefined,
  instanceId: string,
  prefix: string,
  version: string,
): GradeResult {
  const scalar = raw?.rewardScalar ?? null;
  const reward = scalar ?? rewardFromJson(raw?.rewardJson);

  if (reward === null || !Number.isFinite(reward)) {
    return {
      instanceId,
      prefix,
      resolved: false,
      score: null,
      rawGraderOutput: { raw, note: 'no numeric reward in reward.txt/reward.json — verifier produced no verdict' },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
      graderError:
        'FrontierSWE verifier emitted no numeric reward (reward.txt/reward.json absent or unparseable) — image/infra failure?',
    };
  }

  const score = clamp01(reward);
  return {
    instanceId,
    prefix,
    // No model fully solves the implementation tasks → resolved is the degenerate (score === 1) binary; the
    // meaningful headline is `score` (mean@5 / best@5 + rank), not resolved%.
    resolved: score >= 1 - 1e-9,
    score,
    rawGraderOutput: { reward, score, rewardScalar: scalar, rewardJson: raw?.rewardJson ?? null },
    graderFamily: GRADER_FAMILY,
    graderVersion: version,
  };
}

/**
 * The v2 pure scoring map: resolve the raw files with {@link resolveHarborReward}, then fold into a
 * {@link GradeResult}. A missing `files` capture is itself an error (the reader could not say absent vs present).
 */
export function parseFrontierSweV2Reward(
  raw: FrontierSweRawReward | null | undefined,
  instanceId: string,
  prefix: string,
  version: string,
): GradeResult {
  const resolution: HarborRewardResolution = raw?.files
    ? resolveHarborReward(raw.files)
    : { ok: false, error: 'reward reader returned no raw reward files (cannot apply Harbor precedence)' };
  if (!resolution.ok) {
    return {
      instanceId,
      prefix,
      resolved: false,
      score: null,
      rawGraderOutput: { files: raw?.files ?? null, error: resolution.error },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
      graderError: `FrontierSWE v2 reward invalid for ${instanceId}: ${resolution.error}`,
    };
  }
  const score = clamp01(resolution.reward);
  return {
    instanceId,
    prefix,
    resolved: score >= 1 - 1e-9,
    score,
    rawGraderOutput: {
      reward: resolution.reward,
      score,
      clamped: score !== resolution.reward,
      source: resolution.source,
      key: resolution.key,
      rewards: resolution.rewards,
      files: raw?.files ?? null,
    },
    graderFamily: GRADER_FAMILY,
    graderVersion: version,
  };
}

/** The grader-version prefix of a v2 row; any other FrontierSWE row (incl. a legacy untagged one) is v1 history. */
export const FRONTIER_SWE_V2_GRADER_PREFIX = 'frontier-swe@v2+';

/** Which corpus version a FrontierSWE grade row's `graderVersion` names (untagged legacy rows read as v1). */
export function frontierSweGraderCorpusVersion(graderVersion: string): 'v1' | 'v2' {
  return graderVersion.startsWith(FRONTIER_SWE_V2_GRADER_PREFIX) ? 'v2' : 'v1';
}

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The per-task grader version pinned on every row. v2: `frontier-swe@v2+<commit12> verifier=<image@sha256:…>` —
 * the corpus commit plus the exact verifier image, so a re-run against a re-pushed image is a DIFFERENT scorer.
 * v1: `frontier-swe@v1 <cfg.version>`. Returns an error string when the row cannot be pinned (never a guess).
 */
export function frontierSweTaskGraderVersion(
  task: BenchTask | undefined,
  v1Pin: string | undefined,
): { ok: true; version: string; corpusVersion: 'v1' | 'v2' } | { ok: false; version: string; error: string } {
  const meta = (task?.graderMeta ?? {}) as Record<string, unknown>;
  if (meta.corpusVersion === 'v2') {
    const commit = typeof meta.upstreamCommit === 'string' ? meta.upstreamCommit : '';
    const image = typeof meta.verifierDockerImage === 'string' ? meta.verifierDockerImage : '';
    const version = `${FRONTIER_SWE_V2_GRADER_PREFIX}${commit.slice(0, 12) || 'unpinned'} verifier=${image || 'none'}`;
    if (!FULL_SHA.test(commit)) return { ok: false, version, error: 'v2 task has no full upstream commit SHA to pin the grader version' };
    if (!DIGEST_PINNED.test(image)) return { ok: false, version, error: 'v2 task has no digest-pinned verifier image (…@sha256:<64 hex>)' };
    return { ok: true, version, corpusVersion: 'v2' };
  }
  if (!v1Pin) {
    return { ok: false, version: 'frontier-swe@v1 unpinned', error: 'v1 task graded with no version pin (PAPERCUSP_FRONTIER_SWE_VERSION)' };
  }
  return { ok: true, version: `frontier-swe@v1 ${v1Pin}`, corpusVersion: 'v1' };
}

/** A prepared SEPARATE verifier environment (v2): where the verifier runs, and how to tear it down. */
export interface FrontierSweVerifierEnv {
  /** The handle the verifier command + reward read target (e.g. the fresh verifier container's id). */
  verifierRef: string;
  /** Tear the environment down. Always called (in a `finally`), even when grading fails. */
  release: () => Promise<void>;
}

export interface FrontierSweGraderConfig {
  /**
   * The v1 grader version PIN (pre-registration): the v1 repo commit + the task image-set tag, e.g.
   * "<sha> / task-images v4-v6". Needed ONLY to grade v1 (history) tasks — a v1 task graded without it is a
   * `graderError`. v2 tasks pin themselves from their corpus commit + verifier image digest.
   */
  version?: string;
  /** Scratch root for any host-side temp the binding needs (default OS temp). */
  workRoot?: string;
  /**
   * v2 SEPARATE mode (D-003 §1-2): create a fresh container from the task's verifier image and copy the task's
   * `artifacts` from the arm's container into it, returning its handle + a release. REQUIRED for any task whose
   * `graderMeta.verifierEnvironmentMode` is 'separate' — without it that task is a `graderError` (grading a v2 task
   * inside the arm's container cannot work: the agent image has no `/tests`).
   */
  prepareVerifierEnv?: (ctx: {
    instanceId: string;
    /** The arm's mutated-env handle — the SOURCE of the artifacts. */
    envRef: string;
    task: BenchTask;
    exec: ProcExec;
  }) => Promise<FrontierSweVerifierEnv>;
  /**
   * Run the task's OWN verifier (`tests/test.sh`). REQUIRED + injected because the Docker invocation is
   * host-specific. `verifierRef` is where it runs: the separate verifier container (v2), or the arm's own container
   * `envRef` (v1 shared). `oracle:true` sets `HARBOR_ORACLE_MODE=1` for the gold/positive-control run.
   */
  buildVerifierCommand: (ctx: {
    instanceId: string;
    /** The arm's mutated-env handle ({@link ArmSubmission} `envRef`) — the task container the arm operated. */
    envRef: string;
    /** Where the verifier runs (the separate verifier container for v2; equals `envRef` for v1 shared). */
    verifierRef: string;
    /** The matched {@link BenchTask} (its `graderMeta` carries the per-task `verifierCmd` / `rewardPath`). */
    task?: BenchTask;
    oracle?: boolean;
    /**
     * The per-run `HARBOR_ORACLE_FLAG` secret a v2 oracle run shares between `solve.sh` (which writes it to
     * `/app/.harbor_oracle_marker`) and the verifier (which checks the marker against it). Oracle mode only.
     */
    oracleFlag?: string;
  }) => { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };
  /**
   * Read the reward the verifier wrote for one task, from `verifierRef`. For v2 it MUST return `files` (absent vs
   * present distinguished). REQUIRED + injected because the path is INSIDE a container. May throw (→ that task's
   * grade errors, surfaced).
   */
  readReward: (ctx: {
    instanceId: string;
    envRef: string;
    verifierRef: string;
    /** The matched {@link BenchTask} (its `graderMeta.rewardPath` / `rewardJsonPath` say where the verifier wrote). */
    task?: BenchTask;
    readFile: (path: string) => Promise<string>;
    exec: ProcExec;
  }) => Promise<FrontierSweRawReward>;
}

export interface FrontierSweGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

const errorRow = (sub: { instanceId: string; prefix: string }, version: string, detail: string, extra?: object): GradeResult => ({
  instanceId: sub.instanceId,
  prefix: sub.prefix,
  resolved: false,
  score: null,
  rawGraderOutput: { batchError: detail, ...extra },
  graderFamily: GRADER_FAMILY,
  graderVersion: version,
  graderError: detail,
});

/**
 * Build the live FrontierSWE grader. Arm-agnostic (the fairness invariant) — it cannot tell which arm produced a
 * run. For each `in-container` submission it pins the task's grader version, prepares the separate verifier
 * environment when the task needs one, runs that task's `test.sh`, reads the reward, and folds it into a
 * {@link GradeResult} with the version's reward precedence. Any failure → `graderError`, surfaced + excluded,
 * never a silent fail. `diff`/`qa`/`deliverable-bundle` submissions are ignored (FrontierSWE is in-container only).
 */
export function makeFrontierSweGrader(cfg: FrontierSweGraderConfig, deps: FrontierSweGraderDeps): OfficialGrader {
  const { exec, fs } = deps;

  async function gradeOne(sub: Extract<ArmSubmission, { modality: 'in-container' }>, task: BenchTask | undefined): Promise<GradeResult> {
    const pinned = frontierSweTaskGraderVersion(task, cfg.version);
    if (!pinned.ok) return errorRow(sub, pinned.version, `FrontierSWE grader version for ${sub.instanceId}: ${pinned.error}`);
    const { version, corpusVersion } = pinned;
    const separate = (task?.graderMeta as Record<string, unknown> | undefined)?.verifierEnvironmentMode === 'separate';

    let verifierEnv: FrontierSweVerifierEnv | null = null;
    if (separate) {
      if (!cfg.prepareVerifierEnv || !task) {
        return errorRow(
          sub,
          version,
          `FrontierSWE task ${sub.instanceId} needs a SEPARATE verifier environment and no prepareVerifierEnv hook is configured`,
        );
      }
      try {
        verifierEnv = await cfg.prepareVerifierEnv({ instanceId: sub.instanceId, envRef: sub.envRef, task, exec });
      } catch (e) {
        return errorRow(sub, version, `could not prepare the FrontierSWE verifier environment for ${sub.instanceId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let releaseError: string | null = null;
    let result: GradeResult;
    try {
      const verifierRef = verifierEnv?.verifierRef ?? sub.envRef;
      let code = 0;
      let stderr = '';
      try {
        const { cmd, args, cwd, env } = cfg.buildVerifierCommand({ instanceId: sub.instanceId, envRef: sub.envRef, verifierRef, task });
        ({ code, stderr } = await exec(cmd, args, { cwd, env }));
      } catch (e) {
        // The verifier exec itself threw (spawn failure) — an infra failure, surfaced not silently scored.
        return errorRow(sub, version, `FrontierSWE verifier exec failed for ${sub.instanceId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      let raw: FrontierSweRawReward;
      try {
        raw = await cfg.readReward({ instanceId: sub.instanceId, envRef: sub.envRef, verifierRef, task, readFile: (p) => fs.readFile(p), exec });
      } catch (e) {
        const detail =
          `could not read FrontierSWE reward for ${sub.instanceId}: ` +
          `${e instanceof Error ? e.message : String(e)}` +
          (code !== 0 ? ` (verifier exit ${code}: ${stderr.slice(0, 400)})` : '');
        return errorRow(sub, version, detail);
      }

      result =
        corpusVersion === 'v2'
          ? parseFrontierSweV2Reward(raw, sub.instanceId, sub.prefix, version)
          : parseFrontierSweReward(raw, sub.instanceId, sub.prefix, version);
      if (result.graderError && code !== 0) {
        result = { ...result, graderError: `${result.graderError} (verifier exit ${code}: ${stderr.slice(0, 400)})` };
      }
    } finally {
      if (verifierEnv) {
        try {
          await verifierEnv.release();
        } catch (e) {
          releaseError = e instanceof Error ? e.message : String(e);
        }
      }
    }
    // A failed teardown leaks a container but does not change the verdict: record it on the row, never drop it.
    return releaseError
      ? { ...result, rawGraderOutput: { ...(result.rawGraderOutput as object), verifierReleaseError: releaseError } }
      : result;
  }

  return {
    family: GRADER_FAMILY,
    modality: 'in-container',
    async grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]> {
      const envSubs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'in-container' }> => s.modality === 'in-container',
      );
      if (envSubs.length === 0) return [];

      const taskById = new Map(tasks.map((t) => [t.instanceId, t] as const));
      const out: GradeResult[] = [];
      for (const sub of envSubs) out.push(await gradeOne(sub, taskById.get(sub.instanceId)));
      return out;
    },
  };
}
