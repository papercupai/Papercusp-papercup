import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WI-10006716: git-sync's default runner passes no AbortSignal, so a sidecar transport
// loss reaches runGitBoundedUnchecked as a thrown error. Before the fix every such
// throw fell through to a local re-run of the SAME args, which can apply a mutation
// twice. Only a failure before dispatch, or a read-only command, may fall back.
const sidecar = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  run: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock('../../fleet/git-via-sidecar', () => ({
  gitSidecarEnabled: sidecar.enabled,
  runGitViaSpawnerSidecar: sidecar.run,
  noteSidecarFallback: sidecar.fallback,
  isSidecarInfrastructureFault: (result: { code: number; stderr: string }) =>
    result.code === -1 && result.stderr.startsWith('spawner sidecar '),
}));

import { markSidecarPostDispatchFault, SIDECAR_POST_DISPATCH_NOT_REPLAYED } from '../../fleet/sidecar-dispatch-fault';
import { runGitBounded } from './run-git-sync';

let repo: string;

beforeEach(() => {
  sidecar.enabled.mockClear();
  sidecar.run.mockReset();
  sidecar.fallback.mockClear();
  repo = mkdtempSync(join(tmpdir(), 'git-sync-post-dispatch-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'test.once', 'original']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const configValue = (): string =>
  execFileSync('git', ['-C', repo, 'config', 'test.once'], { encoding: 'utf8' }).trim();

describe('git-sync unsignalled sidecar transport loss', () => {
  it('does not replay a mutating command locally after the sidecar may have run it', async () => {
    sidecar.run.mockRejectedValue(
      markSidecarPostDispatchFault(Object.assign(new Error('Socket error: connection reset'), { code: 'ECONNRESET' }), 7),
    );

    const result = await runGitBounded(['config', 'test.once', 'modified'], repo, 5000);

    expect(result.code).toBe(-1);
    expect(result.stderr).toContain(SIDECAR_POST_DISPATCH_NOT_REPLAYED);
    expect(result.stderr).toContain('git config');
    expect(configValue()).toBe('original');
    expect(sidecar.run).toHaveBeenCalledOnce();
    // The transport failure still feeds the shared breaker and fallback ledger.
    expect(sidecar.fallback).toHaveBeenCalledOnce();
  });

  it('still falls back locally for a read-only command after dispatch, which cannot double-apply', async () => {
    sidecar.run.mockRejectedValue(markSidecarPostDispatchFault(new Error('RPC request timeout: process:exec'), 8));

    const result = await runGitBounded(['rev-parse', '--is-inside-work-tree'], repo, 5000);

    expect(result).toMatchObject({ code: 0, stdout: 'true\n' });
    expect(sidecar.fallback).toHaveBeenCalledOnce();
  });

  it('still falls back locally for a mutating command whose sidecar call failed before dispatch', async () => {
    sidecar.run.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED /run/spawner.sock'), { code: 'ECONNREFUSED' }));

    const result = await runGitBounded(['config', 'test.once', 'modified'], repo, 5000);

    expect(result.code).toBe(0);
    expect(configValue()).toBe('modified');
    expect(sidecar.fallback).toHaveBeenCalledOnce();
  });
});
