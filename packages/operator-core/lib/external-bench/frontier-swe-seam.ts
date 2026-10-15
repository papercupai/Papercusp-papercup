/**
 * FrontierSWE's {@link CloneGradeSeam} (plan benchmark-suite-frontier-swe-2026-06-18 P-008; v2 grading: plan
 * benchmark-coverage-frontierswe-v2-2026-10-10 P-003 / D-003) — the per-benchmark clone/grade half that EVERY
 * coordination-topology arm shares (the C5 fairness invariant: identical across arms, differs across benchmarks).
 * su-37e53a76's topology runtime drives the agent inside the container per the arm's {@link CoordinationSpec};
 * THIS seam owns only the benchmark-specific lifecycle:
 *
 *   clone(task)   → `docker run -d <image> sleep infinity` → a live container handle (the agent execs in and
 *                   works in /app; the task workspace is baked into the image). `--gpus all` for GPU tasks.
 *   grade(task,h) → grade with the task's OWN verifier — v1: stage `tests/` into the arm container and run it
 *                   there; v2: a FRESH container from the digest-pinned verifier image, artifacts copied over
 *                   (D-003 §1-2) — and turn the reward into a continuous `score∈[0,1]`. We author NO verifier.
 *   teardown(h)   → `docker rm -f` (never-throw — always called, leak-free).
 *
 * grade() DELEGATES to {@link makeFrontierSweGrader} with the live primitives, so the seam and the standalone
 * OfficialGrader run literally the same code path — reward precedence, version pinning and the separate verifier
 * can never diverge between them. Subprocess is INJECTED ({@link ProcExec}) → unit-testable with a fake docker.
 */
import type { CloneGradeSeam } from './coordination-topology';
import type { BenchTask } from './types';
import type { GraderFs, ProcExec } from './grader/swe-bench-pro';
import { liveProcExec } from './grader/index';
import { liveBuildVerifierCommand, livePrepareSeparateVerifier, liveReadReward } from './grader/frontier-swe-live';
import { makeFrontierSweGrader, type FrontierSweGraderConfig } from './grader/frontier-swe';
import { checkContainerEvidenceIntegrity, FRONTIER_SWE_PROTECTED_PATHS, type EvidenceIntegrity } from './evidence-integrity';
import { CONTAINER_CODEX_BIN_PATH, resolveContainerCodexBinary } from './container-exec-target';
import { CONTAINER_BUSYBOX_PATH, CONTAINER_HOOK_SHIM_PATH, materializeHookShim, resolveStaticBusybox } from './codex-hook-bridge';
import type { BenchEgress, TaskNetworkLease } from './bench-egress';
import { codexHomesRoot, codexSqliteHomesRoot } from '@papercusp/orchestrator/session-launch-dirs';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/** The opaque environment handle for a FrontierSWE task — a live Docker container the arm operated. */
export interface FrontierSweEnvHandle {
  containerId: string;
  image: string;
  instanceId: string;
  /**
   * Present when the arm runs its Codex CLI inside this container (D-026 / D-029). The runAgent adapter builds
   * the docker-exec wrapper's `sessionRelocation` from `roots` (sessionEnv CODEX_HOME) and points the wrapper
   * at `binPath`.
   */
  inContainerCodex?: InContainerCodexMounts;
  /**
   * The per-task `--internal` egress network the container is on (D-031), when the seam has an egress. Plain data:
   * the lease that releases it lives inside the seam, so the handle stays serializable.
   */
  taskNetwork?: string;
}

/** The per-task mounts clone() made for an in-container Codex arm. */
export interface InContainerCodexMounts {
  /** Where the musl Codex is mounted read-only inside the container. */
  binPath: string;
  /** Each shared host root and the per-task dir bind-mounted over it at the same absolute path. Homes root first. */
  roots: { hostRoot: string; perTaskDir: string }[];
  /** Host uid:gid that teardown hands the mounted files back to (the container may write them as root). */
  hostOwner: { uid: number; gid: number };
}

/** Optional overrides for {@link FrontierSweSeamConfig.inContainerCodex}. Production uses the defaults. */
export interface InContainerCodexConfig {
  /** Default {@link codexHomesRoot} — the root the operator writes every Codex session home under. */
  homesRoot?: string;
  /** Default {@link codexSqliteHomesRoot}. */
  sqliteRoot?: string;
  /** Default {@link resolveContainerCodexBinary} — the static musl Codex from the host's own install. */
  codexBinary?: string;
  /** Default the operator's own uid/gid. */
  hostOwner?: { uid: number; gid: number };
  /** The D-032 hook shim, mounted read-only at {@link CONTAINER_HOOK_SHIM_PATH}. Default: materialized into a temp dir. */
  hookShim?: string;
  /** The shim's interpreter, mounted read-only at {@link CONTAINER_BUSYBOX_PATH}. Default {@link resolveStaticBusybox}. */
  busybox?: string;
}

export interface FrontierSweSeamConfig {
  /**
   * The v1 grader version pin (repo commit / image-set tag). Needed only for v1 (history) tasks — a v1 task graded
   * without it is an error row. v2 tasks pin themselves from their corpus commit + verifier image digest.
   */
  version?: string;
  /** Inject a fake in tests; production uses the shell-free `liveProcExec` (execFile, no host shell). */
  exec?: ProcExec;
  /** Run the verifier in oracle mode (HARBOR_ORACLE_MODE=1) — the gold/positive control path. Default false. */
  oracle?: boolean;
  /**
   * The per-run `HARBOR_ORACLE_FLAG` secret for a v2 oracle run — the SAME value the driver passed to `solve.sh`.
   * Required with `oracle` for v2 tasks (the verifier refuses to treat the run as gold without it).
   */
  oracleFlag?: string;
  /**
   * Extra `docker run` flags (e.g. resource limits) the driver wants applied uniformly. Default none. A network
   * flag here is REFUSED: the agent container's network is the task's declared policy
   * ({@link frontierSweAgentNetworkArgs}), never a per-driver override.
   */
  extraRunArgs?: string[];
  /**
   * The run's egress (bench-egress.ts, D-030 / D-031) for an arm that runs its model client INSIDE the container.
   * Required with {@link inContainerCodex} and refused without it. clone() opens one `--internal` network per task
   * on which only the gateway and MCP are reachable (as `papercusp-egress:<port>`), and puts the container on it for
   * EVERY network mode, mirroring upstream Harbor, which gives the agent its model host on no-network tasks too.
   * teardown() releases it after the container is gone. Unset (the host-side model loop) → `--network none`.
   */
  egress?: Pick<BenchEgress, 'openTaskNetwork'>;
  /**
   * The vendored v1 Proximal-Labs/frontier-swe checkout (default PAPERCUSP_FRONTIER_SWE_DIR). For a v1 (shared)
   * task the seam `docker cp`s `<repoDir>/tasks/<id>/tests` into the container at `/tests` at GRADE time (and
   * `/solution` in oracle mode) — the v1 task image bakes only `/app`; Harbor uploads tests/ at verify time, so we
   * mirror that. Staging post-agent keeps the hidden tests away from the agent (anti-cheat). Confirmed against the
   * real harness 2026-06-18: gold control → 0.985, empty → 0.0 (libexpat-to-x86asm). v2 tasks need no staging:
   * their verifier image owns `/tests` (D-003 §1).
   */
  repoDir?: string;
  /** Override the separate-verifier lifecycle (tests); production uses {@link livePrepareSeparateVerifier}. */
  prepareVerifierEnv?: FrontierSweGraderConfig['prepareVerifierEnv'];
  /**
   * The arm runs its Codex CLI INSIDE the task container (D-026; session homes per D-029). clone() then mints one
   * per-task dir beside each shared Codex root, bind-mounts it over that root at the same absolute path (the
   * container sees only this task's sessions, never another session's home or tokens), and mounts the static musl
   * Codex read-only at {@link CONTAINER_CODEX_BIN_PATH}. teardown() hands the mounted files back to the host user,
   * moves every relocated session dir back into its shared root, and removes the per-task dirs.
   */
  inContainerCodex?: true | InContainerCodexConfig;
}

/** The seam never reads host files through the grader — the reward is read out of a container. */
const NO_HOST_FS: GraderFs = {
  mkdtemp: async () => {
    throw new Error('FrontierSWE seam: no host fs');
  },
  writeFile: async () => {
    throw new Error('FrontierSWE seam: no host fs');
  },
  readFile: async () => '',
  rm: async () => undefined,
};

/**
 * The protected set for one task: {@link FRONTIER_SWE_PROTECTED_PATHS} plus the task's optional
 * `graderMeta.protectedPaths` (verifier fixtures under /app; /app itself is the submission and cannot be
 * protected wholesale). A malformed declaration is `unverifiable`, never silently ignored.
 *
 * `oracle` (the gold control, P-007): the reference solution IS the attempt, and Harbor's oracle agent uploads it
 * to `/solution` before running it, so `/solution` is the one protected path an oracle run legitimately writes.
 * Every other protected path (the verifier, `/logs/verifier`, task fixtures) stays protected in oracle mode too.
 */
export async function checkFrontierSweIntegrity(
  exec: ProcExec,
  task: BenchTask,
  containerId: string,
  opts: { oracle?: boolean } = {},
): Promise<EvidenceIntegrity> {
  const base = opts.oracle ? FRONTIER_SWE_PROTECTED_PATHS.filter((p) => p !== '/solution') : [...FRONTIER_SWE_PROTECTED_PATHS];
  const declared = task.graderMeta?.['protectedPaths'];
  if (declared !== undefined && !(Array.isArray(declared) && declared.every((p) => typeof p === 'string'))) {
    return { verdict: 'unverifiable', protectedPaths: base, error: 'graderMeta.protectedPaths must be an array of strings' };
  }
  return checkContainerEvidenceIntegrity(exec, containerId, [...base, ...((declared as string[] | undefined) ?? [])]);
}

/** Build FrontierSWE's CloneGradeSeam — supplied once to the shared topology runtime; every arm uses it identically. */
/** A `docker run` flag that would set or add a network — the policy below owns that decision. */
const NETWORK_FLAG = /^--net(work)?(=|$)/;

/**
 * The agent container's network flags for one task (WI-6554700010008591). A v2 task declares
 * `[environment].network_mode`, and upstream (px-eval / Harbor) enforces it on the agent sandbox:
 *
 *   - `no-network` → no egress at all.
 *   - `allowlist`  → egress ONLY to the configured model endpoints. Every allowlist task's preflight asserts that
 *     google.com, github.com and the task's own toolchain origin are UNREACHABLE, so an open container both
 *     breaks that contract and lets an agent fetch answers or toolchains the task deliberately baked offline.
 *
 * A host-side model loop runs on the HOST (the gateway) and only `docker exec`s tools into the container, so the
 * container needs no model host: `--network none` satisfies `allowlist` (zero hosts is a subset of the allowlist).
 *
 * An arm that runs its model client INSIDE the container passes `egressNetwork` — a per-task `--internal` network
 * on which only the gateway and MCP are reachable (bench-egress.ts, D-030 / D-031). It is used for EVERY mode,
 * no-network included: upstream Harbor's `merge_extra_allowlists` likewise turns no-network into an allowlist of
 * the agent's model host. A task with no declared mode gets it too, because the in-container client can only reach
 * its model through that network.
 *
 * Fail closed: a declared mode this function does not know THROWS — never a silent unrestricted run. Without an
 * egress network, a task with no declared mode (v1 history rows) keeps its historical unrestricted run.
 * `PX_TASK_NETWORK_MODE` mirrors px-eval's sandbox env so the image's own preflight checks the declared policy.
 */
export function frontierSweAgentNetworkArgs(task: BenchTask, opts: { egressNetwork?: string } = {}): string[] {
  const egress = opts.egressNetwork?.trim();
  const raw = task.graderMeta?.['networkMode'];
  if (raw === undefined || raw === null) return egress ? ['--network', egress] : [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`FrontierSWE clone: task ${task.instanceId} has a malformed networkMode (${JSON.stringify(raw)}) — refusing to guess a network policy`);
  }
  const mode = raw.trim();
  const env = ['-e', `PX_TASK_NETWORK_MODE=${mode}`];
  if (mode === 'no-network' || mode === 'none' || mode === 'allowlist') return ['--network', egress || 'none', ...env];
  throw new Error(`FrontierSWE clone: task ${task.instanceId} declares network_mode '${mode}', which this seam cannot enforce — refusing an unrestricted run`);
}

interface ResolvedInContainerCodex {
  roots: [string, string];
  codexBinary: string;
  hostOwner: { uid: number; gid: number };
  hook: { shim: string; busybox: string };
}

/** Is `p` equal to or inside `base`? */
function within(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve and validate the in-container Codex config ONCE, at seam construction, so a bad config fails before any
 * container starts. Refuses non-absolute paths, a ',' in a path (`--mount` is comma-separated; a comma would
 * silently change the mount), and nested roots (one mount would shadow the other).
 */
export function resolveInContainerCodexConfig(c: true | InContainerCodexConfig): ResolvedInContainerCodex {
  const o: InContainerCodexConfig = c === true ? {} : c;
  const homesRoot = o.homesRoot ?? codexHomesRoot();
  const sqliteRoot = o.sqliteRoot ?? codexSqliteHomesRoot();
  const codexBinary = o.codexBinary ?? resolveContainerCodexBinary();
  // Every in-container Codex runs its hooks through the D-032 bridge, so a missing static busybox fails here, before
  // any container starts, instead of leaving an arm whose hooks silently fail.
  const busybox = o.busybox ?? resolveStaticBusybox();
  const hookShim = o.hookShim ?? materializeHookShim();
  const paths = [['homesRoot', homesRoot], ['sqliteRoot', sqliteRoot], ['codexBinary', codexBinary], ['busybox', busybox], ['hookShim', hookShim]] as const;
  for (const [name, p] of paths) {
    if (!isAbsolute(p)) throw new Error(`FrontierSWE seam: inContainerCodex.${name} must be absolute (got ${JSON.stringify(p)})`);
    if (p.includes(',')) throw new Error(`FrontierSWE seam: inContainerCodex.${name} contains ',' — refusing an ambiguous --mount (${p})`);
  }
  if (within(homesRoot, sqliteRoot) || within(sqliteRoot, homesRoot)) {
    throw new Error(`FrontierSWE seam: the Codex homes root and SQLite root must not nest (${homesRoot}, ${sqliteRoot}) — one mount would shadow the other`);
  }
  const hostOwner = o.hostOwner ?? { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  return { roots: [homesRoot, sqliteRoot], codexBinary, hostOwner, hook: { shim: hookShim, busybox } };
}

/**
 * Mint the per-task dir for one shared root: a fresh sibling of the root, so it is on the same filesystem and the
 * wrapper's rename() works. Also ensures the root itself exists (the operator writes the session home there).
 */
function mintPerTaskDir(root: string, instanceId: string): string {
  mkdirSync(root, { recursive: true });
  const tag = instanceId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
  return mkdtempSync(join(dirname(root), `${basename(root)}.bench-${tag}-`));
}

/** The `docker run` mount flags for an in-container Codex arm (exported for tests). */
export function inContainerCodexMountArgs(m: InContainerCodexMounts, codexBinary: string, hook: { shim: string; busybox: string }): string[] {
  const args: string[] = [];
  for (const { hostRoot, perTaskDir } of m.roots) {
    if (perTaskDir.includes(',')) throw new Error(`FrontierSWE seam: per-task dir contains ',' (${perTaskDir})`);
    args.push('--mount', `type=bind,source=${perTaskDir},target=${hostRoot}`);
  }
  args.push('--mount', `type=bind,source=${codexBinary},target=${m.binPath},readonly`);
  // The D-032 hook bridge: the static busybox first (it is the shim's shebang), then the shim. Both read-only.
  args.push('--mount', `type=bind,source=${hook.busybox},target=${CONTAINER_BUSYBOX_PATH},readonly`);
  args.push('--mount', `type=bind,source=${hook.shim},target=${CONTAINER_HOOK_SHIM_PATH},readonly`);
  return args;
}

export interface RestoreReport {
  /** Session dirs moved back into their shared root (host paths). */
  restored: string[];
  /** Per-task dirs removed. */
  removed: string[];
  /** Non-fatal failures; teardown never throws. A per-task dir that could not be removed is listed here. */
  errors: string[];
}

/**
 * Undo the wrapper's relocation after the container is gone (D-029 step 4). For each root, every entry of the
 * per-task dir whose host path is a symlink pointing at it is moved back into the shared root (the symlink is
 * replaced by the real dir). That keeps the session's Codex transcript and lets session-dir-gc own its lifecycle
 * as for a native session. Anything else in the per-task dir (no host symlink, so no host reference) is removed
 * with the dir. Never throws.
 */
export function restoreRelocatedSessions(roots: readonly { hostRoot: string; perTaskDir: string }[]): RestoreReport {
  const report: RestoreReport = { restored: [], removed: [], errors: [] };
  for (const { hostRoot, perTaskDir } of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(perTaskDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') report.errors.push(`read ${perTaskDir}: ${(e as Error).message}`);
      continue;
    }
    for (const name of names) {
      const target = join(perTaskDir, name);
      const link = join(hostRoot, name);
      try {
        if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) continue;
      } catch {
        continue; // no host reference — removed with the per-task dir
      }
      try {
        unlinkSync(link);
        renameSync(target, link);
        report.restored.push(link);
      } catch (e) {
        report.errors.push(`restore ${target} -> ${link}: ${(e as Error).message}`);
      }
    }
    try {
      rmSync(perTaskDir, { recursive: true, force: true });
      report.removed.push(perTaskDir);
    } catch (e) {
      report.errors.push(`remove ${perTaskDir}: ${(e as Error).message}`);
    }
  }
  return report;
}

export function makeFrontierSweCloneGradeSeam(cfg: FrontierSweSeamConfig): CloneGradeSeam<FrontierSweEnvHandle> {
  const netOverride = cfg.extraRunArgs?.find((a) => NETWORK_FLAG.test(a));
  if (netOverride) {
    throw new Error(`FrontierSWE seam: extraRunArgs may not set the network (${netOverride}) — the task's declared network_mode decides it`);
  }
  const exec = cfg.exec ?? liveProcExec;
  const codex = cfg.inContainerCodex ? resolveInContainerCodexConfig(cfg.inContainerCodex) : null;
  // An in-container Codex reaches its model only through the egress, and a host-side loop must not get one.
  if (codex && !cfg.egress) throw new Error('FrontierSWE seam: inContainerCodex requires egress — the in-container Codex has no other route to its model');
  if (cfg.egress && !codex) throw new Error('FrontierSWE seam: egress is only for an in-container Codex arm — a host-side model loop runs with --network none');
  /** Open per-task egress leases, by container id (the handle carries only the network name). */
  const leases = new Map<string, TaskNetworkLease>();
  const releaseLease = async (lease: TaskNetworkLease | undefined, instanceId: string) => {
    if (!lease) return;
    const errors = await lease.release();
    if (errors.length) console.warn(`[frontier-swe-seam] ${instanceId}: egress network release: ${errors.join('; ').slice(0, 500)}`);
  };
  const grader = makeFrontierSweGrader(
    {
      version: cfg.version,
      prepareVerifierEnv: cfg.prepareVerifierEnv ?? livePrepareSeparateVerifier,
      buildVerifierCommand: (ctx) => liveBuildVerifierCommand({ ...ctx, oracle: cfg.oracle, oracleFlag: cfg.oracleFlag }),
      readReward: liveReadReward,
    },
    { exec, fs: NO_HOST_FS },
  );

  return {
    modality: 'in-container',

    async clone(task: BenchTask): Promise<FrontierSweEnvHandle> {
      const image = task.graderMeta?.['dockerImage'] as string | undefined;
      if (!image) throw new Error(`FrontierSWE clone: task ${task.instanceId} has no dockerImage in graderMeta`);
      const gpus = Number(task.graderMeta?.['gpus'] ?? 0);
      // Validate the declared mode BEFORE opening an egress lease, so a refusal cannot leak a network.
      frontierSweAgentNetworkArgs(task);
      const lease = cfg.egress ? await cfg.egress.openTaskNetwork(task.instanceId) : undefined;
      const runArgs = ['run', '-d', ...frontierSweAgentNetworkArgs(task, { egressNetwork: lease?.network })];
      if (gpus > 0) runArgs.push('--gpus', 'all');
      if (cfg.extraRunArgs?.length) runArgs.push(...cfg.extraRunArgs);
      // v2 oracle stage: every v2 image's ENTRYPOINT (entrypoint.sh, run once at container init) gates its oracle
      // setup on HARBOR_ORACLE_FLAG — it creates an agent-owned /solution and, for some tasks, stages reference
      // material there (fitness-recap copies /root/tests/reference/src → /solution/reference-src, which solve.sh
      // then needs). px-eval sets the flag in the SANDBOX env, so it must be on `docker run`, not only on the
      // solve.sh exec; without it the gold control fails on missing reference material, not on the solution.
      // Agent rollouts (oracle=false) never carry it, so they never see a /solution.
      if (cfg.oracle && cfg.oracleFlag) runArgs.push('-e', `HARBOR_ORACLE_FLAG=${cfg.oracleFlag}`);
      // In-container Codex (D-026 / D-029): per-task dirs mounted over the shared roots at the same paths, plus the
      // musl Codex read-only. Minted only after every refusal above, and released again if `docker run` fails.
      let mounts: InContainerCodexMounts | undefined;
      if (codex) {
        const roots: InContainerCodexMounts['roots'] = [];
        try {
          for (const root of codex.roots) roots.push({ hostRoot: root, perTaskDir: mintPerTaskDir(root, task.instanceId) });
          mounts = { binPath: CONTAINER_CODEX_BIN_PATH, roots, hostOwner: codex.hostOwner };
          runArgs.push(...inContainerCodexMountArgs(mounts, codex.codexBinary, codex.hook));
        } catch (e) {
          restoreRelocatedSessions(roots);
          await releaseLease(lease, task.instanceId);
          throw e;
        }
      }
      // Keep the container alive so the topology runtime can exec the agent into the baked-in /app workspace.
      runArgs.push(image, 'sleep', 'infinity');
      let r: Awaited<ReturnType<ProcExec>>;
      try {
        r = await exec('docker', runArgs);
      } catch (e) {
        if (mounts) restoreRelocatedSessions(mounts.roots);
        await releaseLease(lease, task.instanceId);
        throw e;
      }
      const containerId = r.stdout.trim().split('\n').pop() ?? '';
      if (r.code !== 0 || !containerId) {
        if (mounts) restoreRelocatedSessions(mounts.roots);
        await releaseLease(lease, task.instanceId);
        throw new Error(`FrontierSWE clone: docker run failed for ${task.instanceId} (${image}) — exit ${r.code}: ${r.stderr.slice(0, 300)}`);
      }
      if (lease) leases.set(containerId, lease);
      return {
        containerId,
        image,
        instanceId: task.instanceId,
        ...(mounts ? { inContainerCodex: mounts } : {}),
        ...(lease ? { taskNetwork: lease.network } : {}),
      };
    },

    async grade(task: BenchTask, handle: FrontierSweEnvHandle) {
      // Pre-grade evidence integrity (P-020 / D-008) — FIRST, before v1 staging legitimately writes /tests and
      // /solution into this container. Tampering → 'invalid' (terminal, disclosed); an unreadable diff → 'error'.
      const integrity = await checkFrontierSweIntegrity(exec, task, handle.containerId, { oracle: cfg.oracle });
      if (integrity.verdict === 'tampered') return { resolved: null, score: null, graderStatus: 'invalid', detail: { integrity } };
      if (integrity.verdict === 'unverifiable') return { resolved: null, score: null, graderStatus: 'error', detail: { integrity } };
      const separate = task.graderMeta?.['verifierEnvironmentMode'] === 'separate';
      // v1 only: stage the hidden tests INTO the arm container at GRADE time (post-agent) — the v1 image bakes only
      // /app; Harbor uploads tests/ at verify time. Doing it here (not in clone) keeps /tests away from the agent.
      const repoDir = cfg.repoDir ?? process.env.PAPERCUSP_FRONTIER_SWE_DIR;
      if (repoDir && !separate) {
        try {
          await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/tests`, `${handle.containerId}:/tests`]);
          if (cfg.oracle) await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/solution`, `${handle.containerId}:/solution`]);
        } catch (e) {
          return { resolved: null, score: null, graderStatus: 'error', detail: { stageTestsError: e instanceof Error ? e.message : String(e), integrity } };
        }
      }

      const [g] = await grader.grade(
        [{ modality: 'in-container', instanceId: handle.instanceId, envRef: handle.containerId, prefix: 'seam' }],
        [task],
      );
      if (!g || g.graderError || g.score == null) {
        // Verifier produced no valid verdict → infra, surfaced + excluded (C6), never a silent 0.
        return {
          resolved: null,
          score: null,
          graderStatus: 'error',
          detail: { graderError: g?.graderError ?? 'no grade row', graderVersion: g?.graderVersion ?? null, raw: g?.rawGraderOutput ?? null, integrity },
        };
      }
      // A genuine capability outcome (incl. score 0). resolved = (score === 1) is degenerate for FrontierSWE.
      return {
        resolved: g.resolved,
        score: g.score,
        graderStatus: g.resolved ? 'passed' : 'failed',
        detail: { ...(g.rawGraderOutput as object), graderVersion: g.graderVersion, integrity },
      };
    },

    async teardown(handle: FrontierSweEnvHandle): Promise<void> {
      // Never-throw: teardown is ALWAYS called (success / capability-fail / infra-fail) — must not leak a container.
      const m = handle.inContainerCodex;
      if (m) {
        // The container may have written the mounted session files as root. Hand them back to the host user from
        // inside (as uid 0) BEFORE removing the container, so the host can move them and session-dir-gc can delete
        // them later. Best effort: a failure leaves root-owned files the host cannot remove (reported below).
        try {
          await exec('docker', ['exec', '-u', '0', handle.containerId, 'chown', '-R', `${m.hostOwner.uid}:${m.hostOwner.gid}`, ...m.roots.map((x) => x.hostRoot)]);
        } catch {
          /* swallow — reported via restore errors if it mattered */
        }
      }
      try {
        await exec('docker', ['rm', '-f', handle.containerId]);
      } catch {
        /* swallow — a teardown failure must never break the run */
      }
      // The task network goes only after its container (docker refuses to remove a network with live endpoints).
      const lease = leases.get(handle.containerId);
      leases.delete(handle.containerId);
      try {
        await releaseLease(lease, handle.instanceId);
      } catch {
        /* swallow — release is never-throw already; this guards a custom egress */
      }
      if (m) {
        const report = restoreRelocatedSessions(m.roots);
        if (report.errors.length) {
          console.warn(`[frontier-swe-seam] teardown ${handle.instanceId}: ${report.errors.length} restore error(s): ${report.errors.join('; ').slice(0, 500)}`);
        }
      }
    },
  };
}
