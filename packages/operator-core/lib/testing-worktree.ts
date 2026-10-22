/**
 * Shared worktree provenance helpers for test runners.
 *
 * Keep this module's dependency graph small: Playwright loads its reporters
 * through a CommonJS transform, so reporters must not import the full
 * testing-run-store (which also owns task-manager/systemd spawn code).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import {
  exemptProbeSubject,
  isMutationProbeRun,
  mutationSubjectForVerifierSource,
  resolveProbeSubjectExemption,
  resolveProbeSubjectExemptionSync,
  WORKTREE_SNAPSHOT_GIT_BUDGETS_MS,
} from '@papercusp/test-config/admin-test-runs-reporter';
import { findVerifierSourceRoot, readVerifierSourceReceiptSync } from './verifier-source';

export interface WorktreeGitSnapshot {
  /** `git rev-parse HEAD`, or null if it couldn't be read. */
  commit: string | null;
  /** `git status --porcelain --untracked-files=all` output, or null if unreadable.
   *  Empty string means clean; non-empty means the shared worktree carries
   *  uncommitted changes at this snapshot. */
  porcelain: string | null;
  /** Archive verification failures remain visible in the reporter's diagnostics. */
  provenanceError?: string;
}

/** Playwright's rootDir is the e2e directory. A committed verifier archive has
 * no Git marker; its existing manifest identifies the source root, even when
 * its content is invalid (capture must fail closed rather than use ambient Git).
 */
export function resolveReporterSourceRoot(projectDir?: string): string {
  if (projectDir) {
    const archive = findVerifierSourceRoot(projectDir);
    if (archive) return archive;
  }
  return resolveAgentWorkspaceRoot(projectDir ? { projectDir } : {});
}

/** Source stability only, equivalent to Git's ignored dependency/build data.
 * The independent receipt is retained outside the archive by the verifier.
 * Verify the entire archived source population at both boundaries; a supplied
 * SHA alone never attests clean source. Runtime/dependency acceptance is separate.
 */
export function captureTestSourceSnapshot(root: string): WorktreeGitSnapshot {
  if (!existsSync(join(root, '.verifier-source.json')) && !process.env.VERIFY_TAURI_SOURCE_RECEIPT) {
    return captureWorktreeSnapshot(root);
  }
  try {
    const mutation = mutationSubjectForVerifierSource(root);
    const receipt = readVerifierSourceReceiptSync(root, undefined, { mutation });
    return { commit: receipt.sourceCommit, porcelain: '' };
  } catch (error) {
    return { commit: null, porcelain: null,
      provenanceError: `verifier source: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Awaitable reporter boundaries use the governed async Git runner. Archive
 * custody still requires its independent receipt; never fall back to ambient Git.
 */
export async function captureTestSourceSnapshotAsync(root: string): Promise<WorktreeGitSnapshot> {
  if (existsSync(join(root, '.verifier-source.json')) || process.env.VERIFY_TAURI_SOURCE_RECEIPT) {
    return captureTestSourceSnapshot(root);
  }
  return captureWorktreeSnapshotAsync(root);
}

export function computeWorktreeDirty(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): boolean {
  if (!before.commit || !after.commit) return true;
  if (before.commit !== after.commit) return true;
  if (before.porcelain === null || after.porcelain === null) return true;
  if (before.porcelain.trim().length > 0) return true;
  if (after.porcelain.trim().length > 0) return true;
  return false;
}

/**
 * Capture the shared worktree's commit and full porcelain status fail-soft.
 *
 * This is intentionally synchronous for the pre-run call: callers must finish
 * the before snapshot before spawning a child, otherwise a fast child could
 * complete before its "before" probe does. A missing/failed probe is returned
 * as null and therefore marks the run dirty via computeWorktreeDirty.
 */
export function captureWorktreeSnapshot(cwd?: string): WorktreeGitSnapshot {
  let root = cwd;
  const origin = process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT?.trim();
  if (isMutationProbeRun() && origin && isAbsolute(origin)) root = origin;
  if (!root) {
    try {
      root = resolveAgentWorkspaceRoot({});
    } catch {
      return { commit: null, porcelain: null };
    }
  }

  const failures: string[] = [];
  const readGit = (args: string[], gitRoot = root, timeoutMs = 2_000): string | null => {
    const started = Date.now();
    try {
      const output = execFileSync('git', args, {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: timeoutMs,
        // These snapshots only observe the shared tree. Prevent Git's optional
        // index refresh from competing with git-sync's index writer.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (output == null) return null;
      return output.trim();
    } catch (error) {
      const failure = error as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown } | null;
      const stderr = typeof failure?.stderr === 'string' || Buffer.isBuffer(failure?.stderr)
        ? String(failure.stderr).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      failures.push(`git ${args.join(' ')} failed after ${Date.now() - started}ms `
        + `(budget=${timeoutMs}ms, code=${String(failure?.code ?? 'unknown')}, `
        + `status=${String(failure?.status ?? 'unknown')}, signal=${String(failure?.signal ?? 'none')})`
        + (stderr ? `: ${stderr}` : ''));
      return null;
    }
  };

  const snapshot = (commit: string | null, porcelain: string | null): WorktreeGitSnapshot => ({
    commit, porcelain,
    ...(failures.length ? { provenanceError: failures.slice(0, 2).join('; ').slice(0, 500) } : {}),
  });
  // Match the shared reporter's existing bounded snapshot policy. Playwright's
  // synchronous onBegin cannot await the final-capture runner; a single short
  // attempt here had drifted from the Vitest and mutation-exemption readers.
  const readWithPolicy = (args: string[]): string | null => {
    const failureStart = failures.length;
    for (const budget of WORKTREE_SNAPSHOT_GIT_BUDGETS_MS) {
      const output = readGit(args, root, budget);
      if (output !== null) {
        failures.splice(failureStart);
        return output;
      }
    }
    return null;
  };
  const commit = readWithPolicy(['rev-parse', 'HEAD']) || null;
  const porcelain = readWithPolicy(['status', '--porcelain', '--untracked-files=all']);
  if (!porcelain || !isMutationProbeRun()) return snapshot(commit, porcelain);
  const exemption = resolveProbeSubjectExemptionSync(root, (cmd, gitRoot, budget) => {
    if (cmd === 'git rev-parse --show-toplevel') return readGit(['rev-parse', '--show-toplevel'], gitRoot, budget);
    if (cmd === 'git rev-parse HEAD') return readGit(['rev-parse', 'HEAD'], gitRoot, budget);
    if (cmd === 'git status --porcelain --untracked-files=all') return readGit(['status', '--porcelain', '--untracked-files=all'], gitRoot, budget);
    const pinned = cmd.match(/^git rev-parse '(HEAD:[^']+)'$/);
    return pinned ? readGit(['rev-parse', pinned[1]], gitRoot, budget) : null;
  });
  return snapshot(commit, exemption ? exemptProbeSubject(porcelain, exemption) : porcelain);
}

/** Async producers can await the shared sidecar subprocess runner rather than
 * block their host on the synchronous reporter's two-second deadline. Keep
 * unknown reads fail-closed, preserve mutation-probe root/exemption behavior,
 * and bracket status to detect source movement. The shared runner bounds and
 * drains the child on both sidecar and local paths. The lazy import keeps
 * synchronous reporter imports small; no cached status can attest a later run.
 */
export async function captureWorktreeSnapshotAsync(root: string): Promise<WorktreeGitSnapshot> {
  const origin = process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT?.trim();
  const snapshotRoot = isMutationProbeRun() && origin && isAbsolute(origin) ? origin : root;
  try {
    const { execFileViaSidecar } = await import('./fleet/git-via-sidecar');
    const failures: string[] = [];
    const read = async (args: string[]): Promise<string | null> => {
      const started = Date.now();
      try {
        const result = await execFileViaSidecar('git', ['--no-optional-locks', ...args], {
          cwd: snapshotRoot, timeoutMs: 30_000, subsystem: 'test-source-provenance',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        });
        return result.stdout.trim();
      } catch (error) {
        failures.push(`git ${args.join(' ')} failed after ${Date.now() - started}ms `
          + `(budget=30000ms): ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    const head = await read(['rev-parse', 'HEAD']);
    let porcelain = await read(['status', '--porcelain', '--untracked-files=all']);
    const after = await read(['rev-parse', 'HEAD']);
    if (head && after && head !== after) failures.push('Git HEAD changed during provenance capture');
    if (porcelain && isMutationProbeRun()) {
      const exemption = await resolveProbeSubjectExemption(snapshotRoot);
      if (exemption) porcelain = exemptProbeSubject(porcelain, exemption);
    }
    return {
      commit: head && head === after ? head : null,
      porcelain,
      ...(failures.length ? { provenanceError: failures.join('; ').slice(0, 500) } : {}),
    };
  } catch (error) {
    return { commit: null, porcelain: null,
      provenanceError: `async source capture: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}
