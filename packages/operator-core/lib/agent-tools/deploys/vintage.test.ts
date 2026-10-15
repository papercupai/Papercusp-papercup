/**
 * deploys:vintage — commit-lag vs origin/staging HEAD per self-reported runtime
 * (fleet-reliability-verification-2026-07-10 P-008).
 *
 * `buildVintageReport` is fully injectable (fake GitRunner + fake row/root
 * loaders) so this needs no real git checkout / PG — pure logic only.
 */
import { describe, it, expect } from 'vitest';
import tool, { buildVintageReport, createRealGit, noteFor, VINTAGE_GIT_TIMEOUT_MS, type GitRunner } from './vintage';
import type { RuntimeVintageRow } from '../../runtime-vintage';

function row(overrides: Partial<RuntimeVintageRow> = {}): RuntimeVintageRow {
  return {
    workspaceId: 'default',
    unit: 'dev-api',
    host: 'tower',
    treeSha: 'sha-behind',
    buildTime: '2026-07-10T00:00:00.000Z',
    bundleVersion: '1.0.0',
    pid: 123,
    extra: {},
    reportedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('deploys:vintage — buildVintageReport', () => {
  it('resolves origin/staging HEAD and computes commit-lag for a row behind it', async () => {
    const git: GitRunner = async (_repo, args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'deadbeef123456789';
      if (args[0] === 'rev-parse' && args[2] === 'sha-behind^{commit}') return 'sha-behind-resolved';
      if (args[0] === 'rev-list' && args[2] === 'sha-behind..origin/staging') return '3';
      if (args[0] === 'rev-list' && args[2] === 'origin/staging..sha-behind') return '0';
      return null;
    };
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row()],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.stagingHeadShortSha).toBe('deadbeef1');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].commitsBehindStaging).toBe(3);
    expect(report.rows[0].commitsAheadOfStaging).toBe(0);
    expect(report.rows[0].note).toMatch(/3 commit\(s\) behind/);
  });

  it('a row carrying commits staging does not have is flagged AHEAD (forked/local build)', async () => {
    const git: GitRunner = async (_repo, args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'stagingsha';
      if (args[0] === 'rev-parse' && args[2] === 'sha-ahead^{commit}') return 'resolved';
      if (args[0] === 'rev-list' && args[2] === 'sha-ahead..origin/staging') return '0';
      if (args[0] === 'rev-list' && args[2] === 'origin/staging..sha-ahead') return '2';
      return null;
    };
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row({ treeSha: 'sha-ahead' })],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.rows[0].commitsBehindStaging).toBe(0);
    expect(report.rows[0].commitsAheadOfStaging).toBe(2);
    expect(report.rows[0].note).toMatch(/carries 2 commit\(s\)/);
  });

  it('a treeSha that does not resolve locally (packaged bundle, unknown commit) reports null lag', async () => {
    const git: GitRunner = async (_repo, args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'stagingsha';
      if (args[0] === 'rev-parse' && args[2] === 'unknown-sha^{commit}') return null; // does not resolve
      return null;
    };
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row({ treeSha: 'unknown-sha' })],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.rows[0].commitsBehindStaging).toBeNull();
    expect(report.rows[0].commitsAheadOfStaging).toBeNull();
    expect(report.rows[0].note).toMatch(/does not resolve in this checkout/);
  });

  it('a row with no treeSha at all is reported with a null-lag note, no git calls needed for it', async () => {
    const git: GitRunner = async (_repo, args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'stagingsha';
      throw new Error('should not be called for a row with no treeSha');
    };
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row({ treeSha: null })],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.rows[0].commitsBehindStaging).toBeNull();
    expect(report.rows[0].note).toBe('no treeSha reported — cannot resolve a commit position.');
  });

  it('an unreachable origin/staging (no fetch yet / detached env) still returns rows, all lag null', async () => {
    const git: GitRunner = async () => null;
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row()],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.stagingHeadSha).toBeNull();
    expect(report.rows[0].commitsBehindStaging).toBeNull();
  });

  it('reportedAgeMs is computed from now vs reportedAt', async () => {
    const oldIso = new Date(Date.now() - 60_000).toISOString();
    const git: GitRunner = async () => null;
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row({ reportedAt: oldIso })],
      loadRoot: async () => '/fake/repo',
    });
    expect(report.rows[0].reportedAgeMs).toBeGreaterThanOrEqual(59_000);
  });

  it('deduplicates equal tree SHAs so repeated runtime rows share one lag probe', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (_repo, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'stagingsha';
      if (args[0] === 'rev-list' && args[2] === 'sha-behind..origin/staging') return '3';
      if (args[0] === 'rev-list' && args[2] === 'origin/staging..sha-behind') return '0';
      return null;
    };
    const report = await buildVintageReport({
      git,
      loadRows: async () => [row(), row({ unit: 'gateway' }), row({ unit: 'watchdog' })],
      loadRoot: async () => '/fake/repo',
    });

    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((r) => r.commitsBehindStaging)).toEqual([3, 3, 3]);
    expect(calls.filter((args) => args[0] === 'rev-list')).toHaveLength(2);
  });

  it('bounds concurrent lag probes while allowing independent SHAs to overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const git: GitRunner = async (_repo, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (args[0] === 'rev-parse' && args[2] === 'origin/staging') return 'stagingsha';
      if (args[0] === 'rev-list') return '0';
      return null;
    };
    const rows = Array.from({ length: 10 }, (_, i) => row({ unit: `runtime-${i}`, treeSha: `sha-${i}` }));
    await buildVintageReport({ git, loadRows: async () => rows, loadRoot: async () => '/fake/repo' });

    // Four concurrent SHA probes, each with two rev-list calls.
    expect(maxActive).toBeGreaterThan(2);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it('declares a dispatch deadline with room for a busy runtime ledger', () => {
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(120);
  });
});

describe('noteFor (pure)', () => {
  it('up to date when behind=0 and ahead=0', () => {
    expect(noteFor(0, 0, 'sha')).toBe('up to date with origin/staging HEAD.');
  });
  it('no treeSha short-circuits before behind/ahead matter', () => {
    expect(noteFor(null, null, null)).toBe('no treeSha reported — cannot resolve a commit position.');
  });
});

describe('deploys:vintage — realGit routes through the sidecar seam (WI-10006307)', () => {
  it('runs git -C <repo> via execFileViaSidecar with a per-site subsystem label and a timeout', async () => {
    const calls: Array<{ command: string; args: string[]; opts: { timeoutMs: number; subsystem: string } }> = [];
    const git = createRealGit((async (command: string, args: string[], opts: { timeoutMs: number; subsystem: string }) => {
      calls.push({ command, args, opts });
      return { stdout: '  abc123\n', stderr: '' };
    }) as never);
    await expect(git('/repo', ['rev-parse', 'HEAD'])).resolves.toBe('abc123');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('git');
    expect(calls[0].args).toEqual(['-C', '/repo', 'rev-parse', 'HEAD']);
    expect(calls[0].opts.subsystem).toBe('deploys-vintage');
    expect(calls[0].opts.timeoutMs).toBe(VINTAGE_GIT_TIMEOUT_MS);
  });

  it('maps a rejected exec (non-zero exit or transport failure) to null', async () => {
    const git = createRealGit((async () => {
      throw Object.assign(new Error('exit 128'), { code: 128, stdout: '', stderr: 'fatal' });
    }) as never);
    await expect(git('/repo', ['rev-parse', 'nope'])).resolves.toBeNull();
  });
});
