/**
 * Live binding + preflight for the FrontierSWE grader (plan benchmark-suite-frontier-swe-2026-06-18 P-006; v2:
 * plan benchmark-coverage-frontierswe-v2-2026-10-10 P-003 / D-003). Every Docker call is shell-free (the injected
 * {@link ProcExec} is `execFile`-based — `liveProcExec` — so no HOST shell string is ever built).
 *
 * - v1 (shared): the task's OWN verifier (`tests/test.sh`) runs inside the ARM's container via `docker exec`.
 * - v2 (separate, D-003 §1-2): {@link livePrepareSeparateVerifier} starts a FRESH container from the task's
 *   digest-pinned verifier image (root; `--network none` when the verifier is no-network), empties each task.toml
 *   `artifacts` source path in it and re-materializes that path from the arm's container (directory artifacts
 *   honour their exclude globs), then the verifier runs THERE with `[verifier.env]`; release = `docker rm -f`.
 * - {@link liveReadReward} reads `reward.json` + `reward.txt` raw, distinguishing ABSENT from EMPTY, so the grader
 *   can apply Harbor precedence (D-003 §3).
 *
 * A preflight reports readiness WITHOUT pulling GB-scale task images or running a multi-hour task (those + the
 * full run are owner-gated: disk + budget + 4–20h/task — plan D-001).
 *
 * Config comes from env so the grading host owns the paths/pins without a code change:
 *   PAPERCUSP_FRONTIER_SWE_VERSION — the v1 grader version pin (repo commit / image-set tag). Needed ONLY to grade
 *                                    v1 (history) tasks; v2 tasks pin themselves (corpus commit + verifier digest).
 *   PAPERCUSP_FRONTIER_SWE_DIR     — the vendored v1 checkout (preflight + gold control + ingest).
 *   PAPERCUSP_FRONTIER_SWE_V2_DIR  — the vendored v2 checkout (preflight + gold control + ingest).
 */
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { BenchTask, OfficialGrader } from '../types';
import { frontierSweTaskSetPath, frontierSweV2TaskSetPath, type FrontierSweArtifact } from '../task-sets';
import type { FrontierSweGraderConfig, FrontierSweRawReward, FrontierSweRewardFiles, FrontierSweVerifierEnv } from './frontier-swe';
import type { ProcExec } from './swe-bench-pro';
import { getOfficialGrader, liveGraderFs, liveProcExec } from './index';

const DEFAULT_VERIFIER_CMD = 'bash /tests/test.sh';
const DEFAULT_REWARD_PATH = '/logs/verifier/reward.txt';
const DEFAULT_REWARD_JSON_PATH = '/logs/verifier/reward.json';

const metaOf = (task: BenchTask | undefined): Record<string, unknown> => (task?.graderMeta ?? {}) as Record<string, unknown>;
const isSeparate = (task: BenchTask | undefined) => metaOf(task).verifierEnvironmentMode === 'separate';

/**
 * Run the task's own verifier via `docker exec` in `verifierRef` — the separate verifier container (v2) or the
 * arm's own container (v1). v2 passes `[verifier.env]` and runs as root after ensuring `/logs/verifier` exists.
 * Oracle mode sets HARBOR_ORACLE_MODE=1 (the v1 convention). A v2 oracle run ALSO needs the per-run
 * `HARBOR_ORACLE_FLAG` secret: v2 `solve.sh` writes it to `/app/.harbor_oracle_marker`, and the v2 verifier treats
 * the run as the oracle only when that marker matches the flag in ITS env (e.g. spice-circuit-simulator-in-rust
 * `verify.py detect_oracle`, read from its verifier image 2026-10-11). Without the flag a v2 gold run is silently
 * scored as an ordinary candidate, so a separate-mode oracle call without `oracleFlag` is REFUSED.
 * A `${…}` template in `[verifier.env]` is REFUSED (Harbor resolves those from the host env; passing them through
 * literally would grade with the wrong configuration).
 */
export const liveBuildVerifierCommand: FrontierSweGraderConfig['buildVerifierCommand'] = ({ envRef, verifierRef, task, oracle, oracleFlag }) => {
  const meta = metaOf(task);
  const verifierCmd = (meta.verifierCmd as string | undefined) ?? DEFAULT_VERIFIER_CMD;
  const args = ['exec'];
  if (isSeparate(task)) {
    if (verifierRef === envRef) {
      throw new Error('a separate-mode FrontierSWE task cannot be verified inside the arm container — prepare a verifier env first');
    }
    args.push('--user', 'root');
    for (const [k, v] of Object.entries((meta.verifierEnv as Record<string, string> | undefined) ?? {})) {
      if (v.includes('${')) throw new Error(`verifier env ${k} is a host-env template (${v}) — not resolvable by this binding`);
      args.push('-e', `${k}=${v}`);
    }
  }
  if (oracle) {
    if (isSeparate(task) && !oracleFlag) {
      throw new Error('a v2 (separate-mode) oracle run needs the per-run oracleFlag (HARBOR_ORACLE_FLAG) — without it the verifier scores the gold run as an ordinary candidate');
    }
    args.push('-e', 'HARBOR_ORACLE_MODE=1');
    if (oracleFlag) args.push('-e', `HARBOR_ORACLE_FLAG=${oracleFlag}`);
  }
  // `bash -lc <cmd>` runs in the CONTAINER's shell (not the host); docker is invoked shell-free via execFile.
  const inContainer = isSeparate(task) ? `mkdir -p /logs/verifier && ${verifierCmd}` : verifierCmd;
  args.push(verifierRef, 'bash', '-lc', inContainer);
  return { cmd: 'docker', args };
};

/** `docker exec <ref> test <flag> <path>` → true (exit 0) / false (exit 1); any other exit is a Docker failure. */
async function probePath(exec: ProcExec, ref: string, flag: '-e' | '-d', path: string): Promise<boolean> {
  const r = await exec('docker', ['exec', ref, 'test', flag, path]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`docker exec ${ref} test ${flag} ${path} failed (exit ${r.code}: ${r.stderr.slice(0, 200)})`);
}

/** Read one in-container file verbatim, or `null` when it does not exist (absent ≠ empty — Harbor precedence). */
async function readOptional(exec: ProcExec, ref: string, path: string): Promise<string | null> {
  if (!(await probePath(exec, ref, '-e', path))) return null;
  const r = await exec('docker', ['exec', ref, 'cat', path]);
  if (r.code !== 0) throw new Error(`docker exec ${ref} cat ${path} failed (exit ${r.code}: ${r.stderr.slice(0, 200)})`);
  return r.stdout;
}

/**
 * Read `reward.json` + `reward.txt` out of `verifierRef` RAW (`files`, absent → null), plus the v1 parsed pair
 * (`rewardScalar` / `rewardJson`) that the shared-mode grader still uses. A Docker failure throws (→ graderError).
 */
export const liveReadReward: FrontierSweGraderConfig['readReward'] = async ({ verifierRef, task, exec }) => {
  const meta = metaOf(task);
  const rewardPath = (meta.rewardPath as string | undefined) ?? DEFAULT_REWARD_PATH;
  const rewardJsonPath = (meta.rewardJsonPath as string | undefined) ?? DEFAULT_REWARD_JSON_PATH;
  const files: FrontierSweRewardFiles = {
    json: await readOptional(exec, verifierRef, rewardJsonPath),
    txt: await readOptional(exec, verifierRef, rewardPath),
  };
  const v = files.txt === null ? Number.NaN : Number.parseFloat(files.txt.trim());
  let rewardJson: unknown;
  if (files.json !== null) {
    try {
      rewardJson = JSON.parse(files.json);
    } catch {
      /* v1 path: a partial reward.json is non-fatal — reward.txt is its primary. v2 judges `files` strictly. */
    }
  }
  return { rewardScalar: Number.isFinite(v) ? v : null, rewardJson, files } satisfies FrontierSweRawReward;
};

/** Run a docker command and throw a labelled error on a non-zero exit. */
async function docker(exec: ProcExec, args: string[], what: string): Promise<string> {
  const r = await exec('docker', args);
  // The OCI runtime's exec failure can land on stdout with an empty stderr — report whichever carries the reason.
  if (r.code !== 0) throw new Error(`${what} failed (docker ${args[0]} exit ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)})`);
  return r.stdout;
}

/** An artifact source must be an absolute, non-root, `..`-free path — it is `rm -rf`'d in the verifier container. */
function artifactPath(source: string): string {
  const p = posix.normalize(source).replace(/\/+$/, '');
  if (!p.startsWith('/') || p === '' || p === '/' || source.split('/').includes('..')) {
    throw new Error(`unsafe FrontierSWE artifact source '${source}' (must be an absolute, non-root path)`);
  }
  return p;
}

/**
 * Copy ONE task.toml artifact from the arm container into the verifier container, at the SAME path, after
 * emptying that path (D-003 §2). Directories go through `tar` with the artifact's exclude globs (Harbor applies
 * excludes to directories only); a file is copied as-is; an artifact absent in the arm leaves the target emptied
 * (never the verifier image's baked-in copy), recreated as a directory when it has no suffix (Harbor's fallback).
 */
export async function copyFrontierSweArtifact(
  exec: ProcExec,
  from: string,
  to: string,
  artifact: FrontierSweArtifact,
  hostDir: string,
  index: number,
): Promise<'directory' | 'file' | 'absent'> {
  const src = artifactPath(artifact.source);
  // Every exec INTO the verifier runs from `/`: emptying `src` can delete the image's WORKDIR (it IS /app for v2
  // images), and docker exec then fails before running anything — `chdir to cwd ("/app") … no such file or
  // directory`, exit 127 (measured 2026-10-11 on the spice-circuit-simulator-in-rust verifier image, P-007).
  const inVerifier = (...cmd: string[]) => ['exec', '-w', '/', to, ...cmd];
  const isDir = await probePath(exec, from, '-d', src);
  const isFile = !isDir && (await probePath(exec, from, '-e', src));
  await docker(exec, inVerifier('rm', '-rf', '--', src), `empty ${src} in the verifier`);
  if (isDir) {
    const inner = `/tmp/pc-fswe-artifact-${index}.tar`;
    const hostTar = join(hostDir, `artifact-${index}.tar`);
    await docker(exec, ['exec', from, 'tar', '-C', src, ...artifact.exclude.map((g) => `--exclude=${g}`), '-cf', inner, '.'], `tar ${src} in the arm`);
    await docker(exec, ['cp', `${from}:${inner}`, hostTar], `copy ${src} out of the arm`);
    await exec('docker', ['exec', from, 'rm', '-f', inner]);
    await docker(exec, inVerifier('mkdir', '-p', src), `recreate ${src} in the verifier`);
    await docker(exec, ['cp', hostTar, `${to}:${inner}`], `copy ${src} into the verifier`);
    await docker(exec, inVerifier('tar', '-C', src, '-xf', inner), `untar ${src} in the verifier`);
    await exec('docker', inVerifier('rm', '-f', inner));
    return 'directory';
  }
  if (isFile) {
    const hostFile = join(hostDir, `artifact-${index}.file`);
    await docker(exec, ['cp', `${from}:${src}`, hostFile], `copy ${src} out of the arm`);
    await docker(exec, inVerifier('mkdir', '-p', posix.dirname(src)), `create ${posix.dirname(src)} in the verifier`);
    await docker(exec, ['cp', hostFile, `${to}:${src}`], `copy ${src} into the verifier`);
    return 'file';
  }
  if (!posix.extname(src)) await docker(exec, inVerifier('mkdir', '-p', src), `recreate empty ${src} in the verifier`);
  return 'absent';
}

/**
 * The separate verifier's GPU count, from [verifier.environment] gpus (graderMeta.verifierGpus) — NOT the agent's
 * `gpus`, which can differ (multi-gpu-efficient-finetuning: agent 2×T4, verifier 4×H100). `null` means the corpus
 * row predates verifier GPU ingest: for a GPU task that is refused (re-ingest) rather than guessed, since 0 would
 * grade on a GPU-less verifier and the agent's count can be wrong. A GPU-free agent with an unknown verifier count
 * runs without GPUs — at the pinned commit no task pairs a GPU-free agent with a GPU verifier (census, WI-6554700010008334).
 */
export function verifierGpuCountOf(instanceId: string, meta: Record<string, unknown>): number {
  const raw = meta.verifierGpus;
  if (raw === null || raw === undefined) {
    if (Number(meta.gpus ?? 0) > 0) {
      throw new Error(
        `task ${instanceId} needs GPUs but its corpus row has no [verifier.environment] gpus (ingested before ` +
          `verifier GPUs were recorded) — re-run the FrontierSWE v2 ingest`,
      );
    }
    return 0;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`task ${instanceId} has an invalid verifierGpus '${String(raw)}'`);
  return n;
}

/**
 * v2 SEPARATE verifier environment (D-003 §1-2): `docker run -d` the task's digest-pinned verifier image idle
 * (as root; `--network none` for a no-network verifier; `--gpus <n>` from [verifier.environment] gpus), copy every
 * artifact from the arm container into it, and return its name + a `docker rm -f` release. Any failure tears the
 * half-built container down before throwing.
 */
export const livePrepareSeparateVerifier: NonNullable<FrontierSweGraderConfig['prepareVerifierEnv']> = async ({
  instanceId,
  envRef,
  task,
  exec,
}): Promise<FrontierSweVerifierEnv> => {
  const meta = metaOf(task);
  const image = typeof meta.verifierDockerImage === 'string' ? meta.verifierDockerImage : '';
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`task ${instanceId} has no digest-pinned verifier image`);
  const verifierGpus = verifierGpuCountOf(instanceId, meta);
  const name = `pc-fswe-verify-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40)}-${randomBytes(4).toString('hex')}`;
  const runArgs = ['run', '-d', '--name', name, '--user', 'root'];
  if (meta.verifierNetworkMode === 'no-network') runArgs.push('--network', 'none');
  // A COUNT, never `all`: on a host with fewer GPUs docker refuses (a loud graderError) instead of the verifier
  // silently running on fewer accelerators than [verifier.environment] declares and scoring the arm down.
  if (verifierGpus > 0) runArgs.push('--gpus', String(verifierGpus));
  runArgs.push('--entrypoint', 'sleep', image, 'infinity');
  await docker(exec, runArgs, `start verifier container from ${image}`);

  const release = async () => {
    const r = await exec('docker', ['rm', '-f', name]);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
      throw new Error(`docker rm -f ${name} failed (exit ${r.code}: ${r.stderr.slice(0, 200)})`);
    }
  };
  const hostDir = await mkdtemp(join(tmpdir(), 'pc-fswe-artifacts-'));
  try {
    const artifacts = (meta.artifacts as FrontierSweArtifact[] | undefined) ?? [];
    for (const [i, a] of artifacts.entries()) await copyFrontierSweArtifact(exec, envRef, name, a, hostDir, i);
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
  return { verifierRef: name, release };
};

/**
 * Resolve the live FrontierSWE grader config from env. The v1 pin is optional: without it, v1 (history) tasks
 * grade as a `graderError` while v2 tasks — which pin themselves — grade normally.
 */
export function resolveFrontierSweConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FrontierSweGraderConfig {
  return {
    version: env.PAPERCUSP_FRONTIER_SWE_VERSION || undefined,
    prepareVerifierEnv: livePrepareSeparateVerifier,
    buildVerifierCommand: liveBuildVerifierCommand,
    readReward: liveReadReward,
  };
}

/** Build the live FrontierSWE grader (real `docker` + fs). cfg defaults to the env-resolved config. */
export function buildLiveFrontierSweGrader(
  cfg: FrontierSweGraderConfig = resolveFrontierSweConfigFromEnv(),
): OfficialGrader {
  return getOfficialGrader('frontier-swe', { frontierSwe: cfg }, { exec: liveProcExec, fs: liveGraderFs });
}

export interface FrontierSwePreflight {
  /** Which corpus this preflight checked. */
  corpusVersion: 'v1' | 'v2';
  /** True iff Docker is reachable AND the vendored repo + corpus are present — safe to launch the grader. */
  ready: boolean;
  docker: { available: boolean; detail: string };
  repo: { present: boolean; path: string | null };
  corpus: { present: boolean; path: string };
  /** Human-actionable gaps (provisioning steps to run before a launch). */
  issues: string[];
}

export interface FrontierSwePreflightDeps {
  exec?: ProcExec;
  pathExists?: (p: string) => Promise<boolean>;
}

/**
 * Check readiness WITHOUT spending: Docker daemon reachable + the vendored checkout + the corpus JSONL present.
 * Never pulls a GB image / runs a task. `issues` lists exactly what to provision. `corpusVersion` defaults to
 * 'v2' (the current corpus); 'v1' checks the history corpus + its checkout.
 */
export async function preflightFrontierSwe(
  opts: { repoDir?: string; corpusPath?: string; corpusVersion?: 'v1' | 'v2' } = {},
  deps: FrontierSwePreflightDeps = {},
): Promise<FrontierSwePreflight> {
  const exec = deps.exec ?? liveProcExec;
  const pathExists =
    deps.pathExists ??
    (async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    });

  const corpusVersion = opts.corpusVersion ?? 'v2';
  const dirEnv = corpusVersion === 'v2' ? 'PAPERCUSP_FRONTIER_SWE_V2_DIR' : 'PAPERCUSP_FRONTIER_SWE_DIR';
  const upstream = corpusVersion === 'v2' ? 'Proximal-Labs/frontier-swe-v2' : 'Proximal-Labs/frontier-swe';
  const repoDir = opts.repoDir ?? process.env[dirEnv] ?? null;
  const corpusPath = opts.corpusPath ?? (corpusVersion === 'v2' ? frontierSweV2TaskSetPath() : frontierSweTaskSetPath());

  const ver = await exec('docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerAvailable = ver.code === 0 && ver.stdout.trim().length > 0;

  const repoPresent = repoDir ? await pathExists(`${repoDir}/tasks`) : false;
  const corpusPresent = await pathExists(corpusPath);

  const issues: string[] = [];
  if (!dockerAvailable)
    issues.push(`Docker daemon not reachable (docker version exit ${ver.code}: ${ver.stderr.slice(0, 200)})`);
  if (!repoDir) issues.push(`${dirEnv} unset — point it at the vendored ${upstream} checkout`);
  else if (!repoPresent) issues.push(`vendored repo missing its tasks/ dir at ${repoDir} (clone ${upstream})`);
  if (!corpusPresent) {
    issues.push(
      `corpus JSONL missing at ${corpusPath} — run the ${corpusVersion === 'v2' ? 'v2 (P-002)' : 'v1 (P-001)'} ingest to build it`,
    );
  }

  return {
    corpusVersion,
    ready: dockerAvailable && repoPresent && corpusPresent,
    docker: { available: dockerAvailable, detail: dockerAvailable ? `Server ${ver.stdout.trim()}` : ver.stderr.slice(0, 200) || `exit ${ver.code}` },
    repo: { present: repoPresent, path: repoDir },
    corpus: { present: corpusPresent, path: corpusPath },
    issues,
  };
}

/** The exact grading commands (for the runbook / a dry-run preview) — matches what the live grader runs. */
export function describeFrontierSweRun(
  envRef = '<container>',
  verifierCmd = DEFAULT_VERIFIER_CMD,
  corpusVersion: 'v1' | 'v2' = 'v2',
): string {
  if (corpusVersion === 'v1') {
    return [
      `# v1 (history): run the task's OWN verifier inside the arm's container, then read the [0,1] reward back:`,
      `docker exec ${envRef} bash -lc '${verifierCmd}'`,
      `docker exec ${envRef} cat ${DEFAULT_REWARD_PATH}     # → the bare [0,1] reward (primary)`,
      `docker exec ${envRef} cat ${DEFAULT_REWARD_JSON_PATH}  # → the structured reward (fallback / breakdown)`,
      `# Gold/oracle positive control (skips anti-cheat): docker exec -e HARBOR_ORACLE_MODE=1 ${envRef} bash -lc '${verifierCmd}'`,
    ].join('\n');
  }
  return [
    `# v2 (separate verifier): a FRESH container from the task's digest-pinned verifier image grades the arm's artifacts:`,
    `docker run -d --name <v> --user root [--network none] --entrypoint sleep <verifierImage@sha256:…> infinity`,
    `# per task.toml artifact (e.g. /app/): tar it in ${envRef} with its exclude globs, docker cp out, empty the path in <v>, docker cp in, untar`,
    `docker exec --user root [-e K=V …from [verifier.env]] <v> bash -lc 'mkdir -p /logs/verifier && ${verifierCmd}'`,
    `docker exec <v> cat ${DEFAULT_REWARD_JSON_PATH}  # → PRIMARY when present (Harbor precedence; malformed = grader error)`,
    `docker exec <v> cat ${DEFAULT_REWARD_PATH}     # → read ONLY when reward.json is absent`,
    `docker rm -f <v>`,
  ].join('\n');
}
