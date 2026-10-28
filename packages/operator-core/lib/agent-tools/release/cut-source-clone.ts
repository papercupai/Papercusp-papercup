import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
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
  options: { readOnly?: boolean; reuseSeedVersion?: string } = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha) || !path.isAbsolute(requestedRoot)) {
    return { ok: false, reason: 'root_clone_source_required — independent clones require an absolute root and exact sourceSha' };
  }
  try {
    return await runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'release-cut-source-clone',
        owner: 'release:cut:source-clone',
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 6 },
        payloadRef: `release:cut-source-clone:${sourceSha}`,
        metadata: { projectCount: projects.length, operation: 'verify-independent-clone' },
      },
      async () => verifyCutSourceCloneAdmitted(requestedRoot, projects, sourceSha, options),
    );
  } catch (error) {
    return {
      ok: false,
      reason: `root_clone_admission_failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function verifyCutSourceCloneAdmitted(
  requestedRoot: string,
  projects: ReadonlyArray<{ path: string }>,
  sourceSha: string,
  options: { readOnly?: boolean; reuseSeedVersion?: string },
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  try {
    const root = await realpath(requestedRoot);
    if (!(await lstat(path.join(root, '.git'))).isDirectory()) throw new Error('root must have an independent .git directory');
    const common = (await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    if (await realpath(common) !== await realpath(path.join(root, '.git'))) throw new Error('shared Git common directory');
    if ((await git(root, 'rev-parse', '--show-toplevel')).trim() !== root) throw new Error('root is not the repository top level');
    // symbolic-ref exits 1 for detached HEAD; other errors must fail closed.
    try {
      await git(root, 'symbolic-ref', '-q', 'HEAD');
      throw new Error('clone HEAD must be detached');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    const origin = (await git(root, 'remote', 'get-url', 'origin')).trim();
    if (!path.isAbsolute(origin)) throw new Error('clone origin must name a registered local repository');
    const canonicalOrigin = await realpath(origin);
    const registered = await Promise.all(projects.map(async (project) => {
      try { return await realpath(project.path); } catch { return null; }
    }));
    if (registered.some((project) => project && within(project, root))) throw new Error('clone must be outside registered source trees');
    if (!registered.includes(canonicalOrigin)) throw new Error('clone origin is not a registered repository');

    async function verifyRepo(candidate: string, authority: string, pin: string): Promise<void> {
      if (candidate !== root) {
        const childCommon = (await git(candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
        if (await realpath(childCommon) !== await realpath(path.join(candidate, '.git')) ||
            (await git(candidate, 'rev-parse', '--show-toplevel')).trim() !== candidate) {
          throw new Error(`gitlink has shared Git storage or an external worktree: ${candidate}`);
        }
      }
      if ((await git(candidate, 'rev-parse', 'HEAD')).trim() !== pin) throw new Error(`HEAD differs from pin at ${candidate}`);
      const [actualCommit, expectedCommit] = await Promise.all([
        git(candidate, 'cat-file', 'commit', pin), git(authority, 'cat-file', 'commit', pin),
      ]);
      if (actualCommit !== expectedCommit) throw new Error(`registered commit differs at ${candidate}`);
      // Read-only inspection retains the existing dirty-artifact contract. For
      // a retry, only root/desktop residue is deferred to resolveCutRoot's exact
      // release-owned residue validator; every other submodule must be clean.
      const retryResidue = options.reuseSeedVersion && (candidate === root || candidate === path.join(root, 'papercusp-desktop'));
      if (!options.readOnly && !retryResidue && (await git(candidate, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')).trim()) {
        throw new Error(`unclean source repository at ${candidate}`);
      }
      for (const entry of (await git(candidate, 'ls-tree', '-r', '-z', pin)).split('\0').filter(Boolean)) {
        const match = /^160000 commit ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        const relative = match[2];
        if (path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe gitlink path');
        const child = path.join(candidate, relative);
        if (await realpath(child) !== child || !within(root, child)) throw new Error('gitlink escapes clone');
        if (!(await lstat(path.join(child, '.git'))).isDirectory()) throw new Error(`gitlink is not an independent materialized repository: ${relative}`);
        await verifyRepo(child, path.join(authority, relative), match[1]);
      }
    }
    await verifyRepo(root, canonicalOrigin, sourceSha);
    return { ok: true, path: root };
  } catch (error) {
    return { ok: false, reason: `root_clone_invalid — ${error instanceof Error ? error.message : String(error)}` };
  }
}
