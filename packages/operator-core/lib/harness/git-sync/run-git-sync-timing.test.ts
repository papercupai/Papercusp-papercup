import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitSyncYieldError, runGitSync, type GitSyncStepRunner, type RunGit } from './run-git-sync';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const calls: string[] = [];
  const diagnosticCalls: Array<{ cwd: string; diagnosticTags?: { runId: string; commandClass: 'git' | 'other' } }> = [];
  const logs: string[] = [];
  const recorded = new Map<string, any>();
  const runGit: RunGit = async (args, cwd, options) => {
    calls.push(cwd);
    if (cwd.startsWith('/fake/libs/')) diagnosticCalls.push({ cwd, diagnosticTags: options?.diagnosticTags });
    clock += cwd.endsWith('/slow') ? 100 : 1;
    await Promise.resolve();
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'main', stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const step: GitSyncStepRunner = async (name, fn) => {
    const value = await fn();
    recorded.set(name, JSON.parse(JSON.stringify(value)));
    return value;
  };
  return { calls, diagnosticCalls, logs, recorded, opts: {
    repoPath: '/fake', runGit, step, log: (line: string) => logs.push(line),
    config: { push: false, pushSubmoduleOrigins: false },
  } };
}

describe('git-sync submodule timing evidence', () => {
  it('persists execution identity and slow repository attribution across depth barriers and checkpoint replay', async () => {
    const f = fixture();
    await runGitSync('timing-test', { ...f.opts, submodulePaths: ['libs/parent', 'libs/parent/slow'] });
    const phase = f.recorded.get('git-sync:submodules');
    const timing = phase.submoduleTiming;
    expect(timing).toMatchObject({ schemaVersion: 1, repoRoot: '/fake', pid: process.pid, omittedBatches: 0 });
    expect(timing.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(timing.sourceUrl).toContain('run-git-sync.ts');
    expect(Number.isFinite(Date.parse(timing.startedAt))).toBe(true);
    expect(timing.batches.map((b: any) => b.depth)).toEqual([3, 2]);
    const [child, parent] = timing.batches;
    expect(child.repositories[0].durationMs).toBeGreaterThan(parent.repositories[0].durationMs);
    expect(parent.startOffsetMs).toBeGreaterThanOrEqual(child.startOffsetMs + child.durationMs);
    expect(f.logs.some((line) => line.includes('repository-settled') && line.includes(timing.runId))).toBe(true);
    expect(f.diagnosticCalls.length).toBeGreaterThan(0);
    expect(f.diagnosticCalls.every(({ diagnosticTags }) =>
      diagnosticTags !== undefined && diagnosticTags.runId === timing.runId
      && diagnosticTags.commandClass === 'git')).toBe(true);

    const before = f.calls.length;
    const replay: GitSyncStepRunner = async (name, fn) => f.recorded.has(name) ? f.recorded.get(name) : fn();
    await runGitSync('timing-test', { ...f.opts, step: replay, submodulePaths: [] });
    expect(f.calls.slice(before).some((cwd) => cwd.startsWith('/fake/libs/'))).toBe(false);
    expect(f.recorded.get('git-sync:submodules').submoduleTiming).toEqual(timing);
  });

  it('bounds retained batches and keeps completed evidence when the next batch yields', async () => {
    const f = fixture();
    await expect(runGitSync('timing-test', {
      ...f.opts,
      submodulePaths: Array.from({ length: 261 }, (_, i) => `libs/r${i}`),
      shouldYield: async () => {
        // Several safe yield probes run during setup and the early root commit.
        // Anchor this test to the submodule batch boundary it is asserting.
        return f.logs.some((line) => line.includes('"event":"batch-settled"') && line.includes('"index":64'))
          ? 'drain requested'
          : null;
      },
    })).rejects.toBeInstanceOf(GitSyncYieldError);
    const timing = f.recorded.get('git-sync:submodules').submoduleTiming;
    expect(timing.batches).toHaveLength(64);
    expect(timing.omittedBatches).toBe(1);
    expect(timing.batches.flatMap((b: any) => b.repositories)).toHaveLength(256);
    expect(f.calls).not.toContain('/fake/libs/r260');
    expect(f.logs.some((line) => line.includes('batch-settled') && line.includes('"index":64'))).toBe(true);
  });

  it('continues sibling repositories and records failures even when the timing sink throws', async () => {
    const f = fixture();
    const runGit: RunGit = async (args, cwd, options) => {
      if (cwd.endsWith('/broken') && args.includes('fetch')) {
        return { code: 1, stdout: '', stderr: 'remote unavailable' };
      }
      return f.opts.runGit(args, cwd, options);
    };
    const outcome = await runGitSync('timing-test', {
      ...f.opts, runGit, submodulePaths: ['libs/broken', 'libs/healthy'],
      log: (line) => {
        if (line.startsWith('[git-sync:submodule-timing]')) throw new Error('sink unavailable');
        f.logs.push(line);
      },
    });
    const repositories = f.recorded.get('git-sync:submodules').submoduleTiming.batches[0].repositories;
    expect(repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'libs/broken', status: 'error' }),
      expect.objectContaining({ scope: 'libs/healthy', status: 'synced' }),
    ]));
    if (!('errors' in outcome)) throw new Error(`expected an error-bearing git-sync outcome, got status=${outcome.status}`);
    expect(outcome.errors).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'libs/broken' })]));
    expect(f.calls).toContain('/fake/libs/healthy');
  });
});
