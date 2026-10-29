import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { runGovernedOperation } from '../../resource-governor/execution';
import { activeWorkspaceId } from '../../workspace-registry';

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExec: typeof execFile.__promisify__ | undefined;
const exec = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExec ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;
const git = async (root: string, ...args: string[]) => (await exec(
  'git', ['--no-optional-locks', '-C', root, ...args],
  { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } },
)).stdout;

export interface ReleaseCutPhaseTiming {
  phase: string;
  stage: 'start' | 'finish';
  elapsedMs?: number;
  outcome?: 'fulfilled' | 'rejected';
  metrics?: Record<string, number>;
}

function emitPhase(
  onPhase: ((event: ReleaseCutPhaseTiming) => void) | undefined,
  event: ReleaseCutPhaseTiming,
): void {
  try {
    onPhase?.(event);
  } catch {
    // Diagnostics never change source-clone admission.
  }
}

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function within(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Recompute authority from registered Git objects; mutable origin/config and
 * setup stdout are never admission receipts. No candidate file is written. */
export async function verifyCutSourceClone(
  requestedRoot: string,
  projects: ReadonlyArray<{ path: string }>,
  sourceSha: string | undefined,
  options: {
    readOnly?: boolean;
    reuseSeedVersion?: string;
    onPhase?: (event: ReleaseCutPhaseTiming) => void;
  } = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha) || !path.isAbsolute(requestedRoot)) {
    return { ok: false, reason: 'root_clone_source_required — independent clones require an absolute root and exact sourceSha' };
  }
  const startedAt = performance.now();
  let outcome: ReleaseCutPhaseTiming['outcome'] = 'rejected';
  emitPhase(options.onPhase, { phase: 'governed-execution', stage: 'start' });
  try {
    const result = await runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'release-cut-source-clone',
        owner: 'release:cut:source-clone',
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 6 },
        payloadRef: `release:cut-source-clone:${sourceSha}`,
        metadata: { projectCount: projects.length, operation: 'verify-independent-clone' },
        ...(options.onPhase ? {
          onAdmissionPhase: (event: {
            phase: string;
            state: 'pending' | 'fulfilled' | 'rejected';
            elapsedMs: number;
          }) => emitPhase(options.onPhase, {
            phase: 'governor-' + event.phase,
            stage: event.state === 'pending' ? 'start' : 'finish',
            elapsedMs: event.elapsedMs,
            ...(event.state === 'pending' ? {} : {
              outcome: event.state === 'fulfilled' ? 'fulfilled' : 'rejected',
            }),
          }),
        } : {}),
      },
      async () => verifyCutSourceCloneAdmitted(requestedRoot, projects, sourceSha, options),
    );
    outcome = result.ok ? 'fulfilled' : 'rejected';
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: `root_clone_admission_failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    emitPhase(options.onPhase, {
      phase: 'governed-execution',
      stage: 'finish',
      elapsedMs: elapsedSince(startedAt),
      outcome,
    });
  }
}

async function verifyCutSourceCloneAdmitted(
  requestedRoot: string,
  projects: ReadonlyArray<{ path: string }>,
  sourceSha: string,
  options: {
    readOnly?: boolean;
    reuseSeedVersion?: string;
    onPhase?: (event: ReleaseCutPhaseTiming) => void;
  },
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const startedAt = performance.now();
  const authorityStartedAt = performance.now();
  let outcome: ReleaseCutPhaseTiming['outcome'] = 'rejected';
  let authorityFinished = false;
  let graphStartedAt: number | null = null;
  let graphFinished = false;
  let repositoryCount = 0;
  let gitlinkCount = 0;
  let gitCallCount = 0;
  const gitTimings = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  const trackedGit = async (candidate: string, ...args: string[]): Promise<string> => {
    if (!options.onPhase) return git(candidate, ...args);
    const command = args.slice(0, 2).join(' ') || 'unknown';
    const callStartedAt = performance.now();
    try {
      return await git(candidate, ...args);
    } finally {
      const durationMs = elapsedSince(callStartedAt);
      const current = gitTimings.get(command) ?? { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs = Math.round((current.totalMs + durationMs) * 10) / 10;
      current.maxMs = Math.max(current.maxMs, durationMs);
      gitTimings.set(command, current);
      gitCallCount += 1;
    }
  };
  const gitMetrics = (): Record<string, number> => {
    const metrics: Record<string, number> = { repositoryCount, gitlinkCount, gitCallCount };
    for (const [command, timing] of gitTimings) {
      const prefix = 'git_' + command.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase() + '_';
      metrics[prefix + 'count'] = timing.count;
      metrics[prefix + 'total_ms'] = timing.totalMs;
      metrics[prefix + 'max_ms'] = timing.maxMs;
    }
    return metrics;
  };
  emitPhase(options.onPhase, { phase: 'source-clone-integrity', stage: 'start' });
  emitPhase(options.onPhase, { phase: 'source-clone-authority-checks', stage: 'start' });
  emitPhase(options.onPhase, { phase: 'source-clone-git-command-timing', stage: 'start' });
  try {
    const root = await realpath(requestedRoot);
    if (!(await lstat(path.join(root, '.git'))).isDirectory()) throw new Error('root must have an independent .git directory');
    const common = (await trackedGit(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    if (await realpath(common) !== await realpath(path.join(root, '.git'))) throw new Error('shared Git common directory');
    if ((await trackedGit(root, 'rev-parse', '--show-toplevel')).trim() !== root) throw new Error('root is not the repository top level');
    // symbolic-ref exits 1 for detached HEAD; other errors must fail closed.
    try {
      await trackedGit(root, 'symbolic-ref', '-q', 'HEAD');
      throw new Error('clone HEAD must be detached');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    const origin = (await trackedGit(root, 'remote', 'get-url', 'origin')).trim();
    if (!path.isAbsolute(origin)) throw new Error('clone origin must name a registered local repository');
    const canonicalOrigin = await realpath(origin);
    const registered = await Promise.all(projects.map(async (project) => {
      try { return await realpath(project.path); } catch { return null; }
    }));
    if (registered.some((project) => project && within(project, root))) throw new Error('clone must be outside registered source trees');
    if (!registered.includes(canonicalOrigin)) throw new Error('clone origin is not a registered repository');
    authorityFinished = true;
    emitPhase(options.onPhase, {
      phase: 'source-clone-authority-checks',
      stage: 'finish',
      elapsedMs: elapsedSince(authorityStartedAt),
      outcome: 'fulfilled',
      metrics: { registeredProjectCount: projects.length },
    });

    async function verifyRepo(candidate: string, authority: string, pin: string): Promise<void> {
      repositoryCount += 1;
      if (candidate !== root) {
        const childCommon = (await trackedGit(candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
        if (await realpath(childCommon) !== await realpath(path.join(candidate, '.git')) ||
            (await trackedGit(candidate, 'rev-parse', '--show-toplevel')).trim() !== candidate) {
          throw new Error(`gitlink has shared Git storage or an external worktree: ${candidate}`);
        }
      }
      if ((await trackedGit(candidate, 'rev-parse', 'HEAD')).trim() !== pin) throw new Error(`HEAD differs from pin at ${candidate}`);
      const [actualCommit, expectedCommit] = await Promise.all([
        trackedGit(candidate, 'cat-file', 'commit', pin), trackedGit(authority, 'cat-file', 'commit', pin),
      ]);
      if (actualCommit !== expectedCommit) throw new Error(`registered commit differs at ${candidate}`);
      // Read-only inspection retains the existing dirty-artifact contract. For
      // a retry, only root/desktop residue is deferred to resolveCutRoot's exact
      // release-owned residue validator; every other submodule must be clean.
      const retryResidue = options.reuseSeedVersion && (candidate === root || candidate === path.join(root, 'papercusp-desktop'));
      if (!options.readOnly && !retryResidue && (await trackedGit(candidate, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')).trim()) {
        throw new Error(`unclean source repository at ${candidate}`);
      }
      for (const entry of (await trackedGit(candidate, 'ls-tree', '-r', '-z', pin)).split('\0').filter(Boolean)) {
        const match = /^160000 commit ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        gitlinkCount += 1;
        const relative = match[2];
        if (path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe gitlink path');
        const child = path.join(candidate, relative);
        if (await realpath(child) !== child || !within(root, child)) throw new Error('gitlink escapes clone');
        if (!(await lstat(path.join(child, '.git'))).isDirectory()) throw new Error(`gitlink is not an independent materialized repository: ${relative}`);
        await verifyRepo(child, path.join(authority, relative), match[1]);
      }
    }
    graphStartedAt = performance.now();
    emitPhase(options.onPhase, { phase: 'source-clone-gitlink-verification', stage: 'start' });
    try {
      await verifyRepo(root, canonicalOrigin, sourceSha);
      outcome = 'fulfilled';
    } finally {
      graphFinished = true;
      emitPhase(options.onPhase, {
        phase: 'source-clone-gitlink-verification',
        stage: 'finish',
        elapsedMs: elapsedSince(graphStartedAt),
        outcome,
        metrics: gitMetrics(),
      });
    }
    return { ok: true, path: root };
  } catch (error) {
    outcome = 'rejected';
    return { ok: false, reason: `root_clone_invalid — ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (!authorityFinished) {
      emitPhase(options.onPhase, {
        phase: 'source-clone-authority-checks',
        stage: 'finish',
        elapsedMs: elapsedSince(authorityStartedAt),
        outcome: 'rejected',
        metrics: { registeredProjectCount: projects.length },
      });
    }
    if (graphStartedAt !== null && !graphFinished) {
      emitPhase(options.onPhase, {
        phase: 'source-clone-gitlink-verification',
        stage: 'finish',
        elapsedMs: elapsedSince(graphStartedAt),
        outcome: 'rejected',
        metrics: gitMetrics(),
      });
    }
    emitPhase(options.onPhase, {
      phase: 'source-clone-git-command-timing',
      stage: 'finish',
      elapsedMs: elapsedSince(startedAt),
      outcome,
      metrics: gitMetrics(),
    });
    emitPhase(options.onPhase, {
      phase: 'source-clone-integrity',
      stage: 'finish',
      elapsedMs: elapsedSince(startedAt),
      outcome,
      metrics: { registeredProjectCount: projects.length, ...gitMetrics() },
    });
  }
}
