import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// WI-10006716: pot-git's defaultRunGit passes the caller's signal, which is usually
// absent, so a sidecar transport loss AFTER dispatch arrives as a thrown error.
// Replaying a mutation locally then may apply it twice. A read may still replay:
// "a sidecar fault degrades performance, never correctness" (storage-run-git.test.ts).
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/git-via-sidecar')>();
  return {
    ...actual,
    gitSidecarEnabled: () => true,
    runGitViaSpawnerSidecar: (...a: unknown[]) => sidecarRunMock(...a),
    noteSidecarFallback: () => {},
  };
});

let sidecarRunMock: (...a: unknown[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const { markSidecarPostDispatchFault, SIDECAR_POST_DISPATCH_NOT_REPLAYED } = await import('../../fleet/sidecar-dispatch-fault');
const { defaultRunGit } = await import('./storage');

let repo: string;
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pot-git-post-dispatch-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pot-git defaultRunGit after a post-dispatch sidecar fault', () => {
  it('returns an unknown outcome for a ref write instead of replaying it locally', async () => {
    const head = git('rev-parse', 'HEAD');
    sidecarRunMock = () => Promise.reject(markSidecarPostDispatchFault(new Error('Socket error: connection reset'), 3));

    const r = await defaultRunGit(['update-ref', 'refs/pots/x', head], repo);

    expect(r.code).toBe(-1);
    expect(r.stderr).toContain(SIDECAR_POST_DISPATCH_NOT_REPLAYED);
    expect(() => git('rev-parse', '--verify', '-q', 'refs/pots/x')).toThrow();
  });

  it('still answers a ref read through the local fallback', async () => {
    const head = git('rev-parse', 'HEAD');
    sidecarRunMock = () => Promise.reject(markSidecarPostDispatchFault(new Error('RPC request timeout: process:exec'), 4));

    const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);

    expect(r).toMatchObject({ code: 0, stdout: `${head}\n` });
  });

  it('still replays a ref write whose sidecar call failed before dispatch', async () => {
    const head = git('rev-parse', 'HEAD');
    sidecarRunMock = () => Promise.reject(new Error('connect ECONNREFUSED /run/nope.sock'));

    const r = await defaultRunGit(['update-ref', 'refs/pots/y', head], repo);

    expect(r.code).toBe(0);
    expect(git('rev-parse', 'refs/pots/y')).toBe(head);
  });
});
