/**
 * FrontierSWE v2 gold / empty CONTROLS (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-007) — the two
 * no-LLM runs that prove the v2 grading pipeline measures something before any paid agent run:
 *
 *   empty — clone the task image, grade the untouched scaffold, tear down. Expect ~0.
 *   gold  — clone, run the task's reference `solution/solve.sh` exactly the way Harbor's OracleAgent does, then
 *           grade in ORACLE mode, tear down.
 *
 * What "gold" means in v2 (measured 2026-10-11 against the pinned corpus da83f84f + the spice verifier image):
 * v2 ships NO reference solutions. Every `solve.sh` writes the per-run `HARBOR_ORACLE_FLAG` secret to
 * `/app/.harbor_oracle_marker` (a few also stage reference sources), and the verifier — which receives the same
 * flag — then scores the IMAGE'S OWN reference as the candidate (e.g. real ngspice). So gold is a pipeline-sanity
 * control: for correctness tasks it should score high, but for performance tasks it measures parity with the
 * reference, which is reward 0.0 BY CONSTRUCTION (libexpat-optimization solve.md). Read gold per task, never as
 * a blanket "gold must be high".
 *
 * Harbor OracleAgent semantics mirrored here (laude-institute/harbor main, src/harbor/agents/oracle.py and
 * trial/trial.py, read 2026-10-11):
 *   - upload `solution/` to `/solution`; `chmod +x` the solve script as root;
 *   - run `bash /solution/solve.sh > /logs/agent/oracle.txt 2>&1` under the agent phase's default user, which is
 *     the task's `[agent].user` (trial.py `with_default_user(task.config.agent.user)`), with
 *     `DEBIAN_FRONTEND=noninteractive` plus the task's `[solution.env]`, bounded by the agent timeout;
 *   - a non-zero solve exit is recorded, and grading still runs.
 * `HARBOR_ORACLE_FLAG` itself comes from Proximal's px-eval harness, not upstream Harbor; this module mints a
 * fresh random flag per gold run and hands the SAME value to the verifier through the seam.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import TOML from '@iarna/toml';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import { liveProcExec } from './grader/index';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle, type FrontierSweSeamConfig } from './frontier-swe-seam';

export type FrontierSweControlMode = 'gold' | 'empty';

/** What a v2 task.toml says about running its reference solution. */
export interface FrontierSweSolutionSpec {
  /** `[agent].user` — the user the oracle runs as. `null` = the image's default user. */
  user: string | null;
  /** `[solution.env]` — passed to `solve.sh`. */
  env: Record<string, string>;
}

/**
 * Parse the oracle-relevant parts of a task.toml. A `${…}` template in `[solution.env]` is REFUSED: Harbor
 * resolves those from the host env, and passing one through literally would run the reference misconfigured.
 */
export function parseFrontierSweSolutionSpec(taskToml: string): FrontierSweSolutionSpec {
  const doc = TOML.parse(taskToml) as Record<string, unknown>;
  const agent = (doc['agent'] ?? {}) as Record<string, unknown>;
  const user = typeof agent['user'] === 'string' && agent['user'] ? (agent['user'] as string) : null;
  const solution = (doc['solution'] ?? {}) as Record<string, unknown>;
  const rawEnv = (solution['env'] ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(`[solution.env] ${k} is not a scalar`);
    }
    const s = String(v);
    if (s.includes('${')) throw new Error(`[solution.env] ${k} is a host-env template (${s}) — not resolvable by this runner`);
    env[k] = s;
  }
  return { user, env };
}

/** The reference-solution run inside the task container (gold only). */
export interface FrontierSweOracleRun {
  user: string | null;
  exitCode: number;
  /** `timeout` fired (exit 124, or 137 after the kill-after grace). */
  timedOut: boolean;
  timeoutSec: number;
  durationMs: number;
  /** The last bytes of /logs/agent/oracle.txt (solve.sh stdout+stderr). */
  logTail: string;
}

export interface FrontierSweControlResult {
  instanceId: string;
  mode: FrontierSweControlMode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The seam's verdict: passed / failed (a real score, incl. 0) / error (infra, no valid score) / invalid. */
  graderStatus: string;
  score: number | null;
  resolved: boolean | null;
  detail?: unknown;
  oracle?: FrontierSweOracleRun;
  /** Actual agent-container network inspected before any oracle or verifier execution. */
  networkPolicy?: { declaredMode: string; agentNetworkMode: string };
  /** An infra failure before or around grading (clone, staging, solve exec) — never a silent score. */
  error?: string;
}

export interface RunFrontierSweControlOpts {
  task: BenchTask;
  mode: FrontierSweControlMode;
  /** The pinned Proximal-Labs/frontier-swe-v2 checkout (task.toml + solution/ are read from here). */
  repoDir: string;
  exec?: ProcExec;
  readText?: (path: string) => Promise<string>;
  prepareVerifierEnv?: FrontierSweSeamConfig['prepareVerifierEnv'];
  extraRunArgs?: string[];
  /** Tests only — production mints a fresh random flag per gold run. */
  oracleFlag?: string;
  /** Override the solve timeout (s); default the task's `agentTimeoutSec`, else 4h. */
  solveTimeoutSec?: number;
  now?: () => number;
}

const DEFAULT_SOLVE_TIMEOUT_SEC = 4 * 3600;
const LOG_TAIL_BYTES = 4000;

/** Run ONE control for ONE v2 task. Never throws for a per-task failure: it is reported in the result. */
export async function runFrontierSweControl(opts: RunFrontierSweControlOpts): Promise<FrontierSweControlResult> {
  const { task, mode, repoDir } = opts;
  const exec = opts.exec ?? liveProcExec;
  const readText = opts.readText ?? ((p: string) => readFile(p, 'utf8'));
  const now = opts.now ?? Date.now;
  const t0 = now();
  const meta = (task.graderMeta ?? {}) as Record<string, unknown>;
  let networkPolicy: FrontierSweControlResult['networkPolicy'];
  const base = { instanceId: task.instanceId, mode, startedAt: new Date(t0).toISOString() };
  const finish = (r: Omit<FrontierSweControlResult, 'instanceId' | 'mode' | 'startedAt' | 'finishedAt' | 'durationMs'>) => {
    const t1 = now();
    return { ...base, finishedAt: new Date(t1).toISOString(), durationMs: t1 - t0,
      ...(networkPolicy ? { networkPolicy } : {}), ...r };
  };
  const infra = (error: string, extra: Partial<FrontierSweControlResult> = {}) =>
    finish({ graderStatus: 'error', score: null, resolved: null, error, ...extra });

  // v2 only: the v1 corpus stages its hidden tests through the seam's own v1 path (verified 2026-06-18).
  if (meta['verifierEnvironmentMode'] !== 'separate') {
    return infra(`task ${task.instanceId} is not a v2 separate-verifier task — v2 controls only`);
  }
  if (mode === 'gold' && !meta['solutionCmd']) {
    return infra(`task ${task.instanceId} ships no reference solution — no gold control is possible`);
  }
  const declaredMode = typeof meta['networkMode'] === 'string' ? meta['networkMode'].trim() : '';
  if (!['allowlist', 'no-network', 'none'].includes(declaredMode)) {
    return infra(`task ${task.instanceId} has no enforceable declared network mode`);
  }

  let spec: FrontierSweSolutionSpec = { user: null, env: {} };
  if (mode === 'gold') {
    try {
      spec = parseFrontierSweSolutionSpec(await readText(`${repoDir}/tasks/${task.instanceId}/task.toml`));
    } catch (e) {
      return infra(`task.toml: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const oracleFlag = mode === 'gold' ? (opts.oracleFlag ?? randomBytes(16).toString('hex')) : undefined;
  const seam = makeFrontierSweCloneGradeSeam({
    exec,
    oracle: mode === 'gold',
    oracleFlag,
    extraRunArgs: opts.extraRunArgs,
    prepareVerifierEnv: opts.prepareVerifierEnv,
  });

  let handle: FrontierSweEnvHandle;
  try {
    handle = await seam.clone(task);
  } catch (e) {
    return infra(`clone: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    // Controls have no model client in the container, so zero egress also satisfies allowlist.
    // Inspect the running container rather than inferring fidelity from intended docker arguments.
    const inspection = await exec('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', handle.containerId]);
    if (inspection.code !== 0) return infra(`inspect agent network: exit ${inspection.code}`);
    networkPolicy = { declaredMode, agentNetworkMode: inspection.stdout.trim() };
    if (networkPolicy.agentNetworkMode !== 'none') {
      return infra(`agent network is ${networkPolicy.agentNetworkMode || 'unknown'}, expected none for ${declaredMode}`);
    }
    let oracle: FrontierSweOracleRun | undefined;
    if (mode === 'gold') {
      const cid = handle.containerId;
      // `<dir>/.` copies the CONTENTS: the image entrypoint's oracle stage has usually already created /solution
      // (and staged reference material in it), and `docker cp <dir> <cid>:/solution` onto an EXISTING directory
      // nests it as /solution/solution — solve.sh would then not be at /solution/solve.sh.
      const cp = await exec('docker', ['cp', `${repoDir}/tasks/${task.instanceId}/solution/.`, `${cid}:/solution`]);
      if (cp.code !== 0) return infra(`stage /solution: docker cp exit ${cp.code}: ${cp.stderr.slice(0, 300)}`);
      const prep = await exec('docker', [
        'exec', '--user', 'root', cid, 'bash', '-c', 'mkdir -p /logs/agent && chmod 0777 /logs/agent && chmod +x /solution/solve.sh',
      ]);
      if (prep.code !== 0) return infra(`prepare oracle: exit ${prep.code}: ${prep.stderr.slice(0, 300)}`);

      const timeoutSec = Math.max(1, Math.round(opts.solveTimeoutSec ?? Number(meta['agentTimeoutSec'] ?? DEFAULT_SOLVE_TIMEOUT_SEC)));
      const args = ['exec'];
      if (spec.user) args.push('--user', spec.user);
      args.push('-e', 'DEBIAN_FRONTEND=noninteractive');
      for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
      args.push('-e', `HARBOR_ORACLE_FLAG=${oracleFlag}`);
      args.push(cid, 'bash', '-c', `timeout --kill-after=30 ${timeoutSec} bash /solution/solve.sh > /logs/agent/oracle.txt 2>&1`);
      const s0 = now();
      const solve = await exec('docker', args);
      const durationMs = now() - s0;
      const tail = await exec('docker', ['exec', '--user', 'root', cid, 'tail', '-c', String(LOG_TAIL_BYTES), '/logs/agent/oracle.txt']);
      oracle = {
        user: spec.user,
        exitCode: solve.code,
        timedOut: solve.code === 124 || solve.code === 137,
        timeoutSec,
        durationMs,
        logTail: tail.code === 0 ? tail.stdout : `(no oracle log: ${tail.stderr.slice(0, 200)})`,
      };
    }
    const g = await seam.grade(task, handle);
    return finish({
      graderStatus: g.graderStatus,
      score: g.score ?? null,
      resolved: g.resolved,
      detail: g.detail,
      ...(oracle ? { oracle } : {}),
    });
  } catch (e) {
    return infra(`control run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await seam.teardown(handle);
  }
}
