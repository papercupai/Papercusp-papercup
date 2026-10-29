import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitSyncYieldError, runGitSync, type GitSyncStepRunner, type RunGit } from './run-git-sync';
import { gitSubcommandOf } from '../../fleet/sidecar-read-only-git';
import * as gitSidecar from '../../fleet/git-via-sidecar';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const calls: string[] = [];
  const taggedCalls: Array<{
    cwd: string;
    args: string[];
    diagnosticTags: { runId: string; commandClass: 'git' | 'other'; gitSubcommand?: string };
  }> = [];
  const diagnosticCalls: Array<{
    cwd: string;
    subcommand: string | null;
    diagnosticTags?: { runId: string; commandClass: 'git' | 'other'; gitSubcommand?: string };
  }> = [];
  const logs: string[] = [];
  const recorded = new Map<string, any>();
  const allCalls: Array<Parameters<RunGit>> = [];
  const phaseCalls = new Map<string, Array<Parameters<RunGit>>>();
  const runGit: RunGit = async (args, cwd, options) => {
    allCalls.push([args, cwd, options]);
    calls.push(cwd);
    if (options?.diagnosticTags) taggedCalls.push({ cwd, args: [...args], diagnosticTags: options.diagnosticTags });
    if (cwd.startsWith('/fake/libs/')) {
      diagnosticCalls.push({ cwd, subcommand: gitSubcommandOf(args), diagnosticTags: options?.diagnosticTags });
    }
    clock += cwd.endsWith('/slow') ? 100 : 1;
    await Promise.resolve();
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'main', stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const step: GitSyncStepRunner = async (name, fn) => {
    const before = allCalls.length;
    const value = await fn();
    phaseCalls.set(name, allCalls.slice(before));
    recorded.set(name, JSON.parse(JSON.stringify(value)));
    return value;
  };
  return { calls, taggedCalls, diagnosticCalls, logs, recorded, phaseCalls, advance: (ms: number) => { clock += ms; }, opts: {
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
    expect(f.diagnosticCalls.every(({ subcommand, diagnosticTags }) => {
      const safeSubcommand = subcommand && /^[a-z][a-z0-9-]{0,63}$/.test(subcommand) ? subcommand : undefined;
      return diagnosticTags?.gitSubcommand === safeSubcommand;
    })).toBe(true);
    expect(f.diagnosticCalls.some(({ diagnosticTags }) => diagnosticTags?.gitSubcommand === 'fetch')).toBe(true);
    const setupEvent = f.logs
      .filter((line) => line.startsWith('[git-sync:submodule-timing] '))
      .map((line) => JSON.parse(line.slice('[git-sync:submodule-timing] '.length)))
      .find((event) => event.event === 'setup-complete');
    expect(setupEvent).toMatchObject({ runId: timing.runId, setupMs: timing.setupMs, repositoryCount: 2 });
    expect(f.taggedCalls.some(({ cwd, args, diagnosticTags }) =>
      cwd === '/fake' && args[0] === 'submodule' && args[1] === 'sync' && diagnosticTags.runId === timing.runId,
    )).toBe(true);
    expect(f.taggedCalls.some(({ cwd, args, diagnosticTags }) =>
      cwd === '/fake' && args[0] === 'rev-parse' && diagnosticTags.runId === timing.runId,
    )).toBe(true);

    const before = f.calls.length;
    const replay: GitSyncStepRunner = async (name, fn) => f.recorded.has(name) ? f.recorded.get(name) : fn();
    await runGitSync('timing-test', { ...f.opts, step: replay, submodulePaths: [] });
    expect(f.calls.slice(before).some((cwd) => cwd.startsWith('/fake/libs/'))).toBe(false);
    expect(f.recorded.get('git-sync:submodules').submoduleTiming).toEqual(timing);
  });

  it('tags recursive discovery and reports its repository count before batch work', async () => {
    const f = fixture();
    await runGitSync('timing-test', f.opts);

    const timing = f.recorded.get('git-sync:submodules').submoduleTiming;
    const setupEvent = f.logs
      .filter((line) => line.startsWith('[git-sync:submodule-timing] '))
      .map((line) => JSON.parse(line.slice('[git-sync:submodule-timing] '.length)))
      .find((event) => event.event === 'setup-complete');
    expect(setupEvent).toMatchObject({ runId: timing.runId, setupMs: timing.setupMs, repositoryCount: 0 });
    expect(f.taggedCalls.some(({ cwd, args, diagnosticTags }) =>
      cwd === '/fake' && args[0] === 'submodule' && args[1] === 'status' && args.includes('--recursive')
        && diagnosticTags.runId === timing.runId,
    )).toBe(true);
  });

  it('distinguishes setup guards from early commit work and preserves the breakdown on replay', async () => {
    const f = fixture();
    await runGitSync('timing-test', {
      ...f.opts,
      submodulePaths: ['libs/child'],
      toolRoutingChecker: async () => { f.advance(500); },
      toolCatalogRegenerator: async () => { f.advance(700); },
      generatedDeclarationsRegenerator: async () => ({ status: 'not-needed', atomicPaths: [] }),
    });
    const timing = f.recorded.get('git-sync:submodules').submoduleTiming;
    expect(timing.setupSteps.map((step: any) => step.name)).toEqual([
      'url-sync', 'discovery', 'early-root-guards', 'early-root-migration-census',
      'early-root-commit', 'early-root-proof', 'remainder',
    ]);
    expect(timing.setupSteps.find((step: any) => step.name === 'early-root-guards').durationMs).toBeGreaterThanOrEqual(1200);
    expect(timing.setupSteps.find((step: any) => step.name === 'early-root-commit').durationMs).toBeLessThan(1200);
    expect(timing.setupSteps.reduce((sum: number, step: any) => sum + step.durationMs, 0)).toBe(timing.setupMs);
    expect(f.logs.some((line) => line.includes('"event":"setup-step"') && line.includes(timing.runId))).toBe(true);
    const before = f.taggedCalls.length;
    const replay: GitSyncStepRunner = async (name, fn) => f.recorded.has(name) ? f.recorded.get(name) : fn();
    await runGitSync('timing-test', { ...f.opts, step: replay, submodulePaths: [] });
    expect(f.taggedCalls).toHaveLength(before);
    expect(f.recorded.get('git-sync:submodules').submoduleTiming).toEqual(timing);
  });

  it('persists pointer-bump and commit duration evidence in the checkpointed phase output', async () => {
    const f = fixture();
    await runGitSync('timing-test', { ...f.opts, submodulePaths: ['libs/child'] });

    const timing = f.recorded.get('git-sync:pointer-bump').pointerBumpTiming;
    expect(timing).toMatchObject({
      schemaVersion: 1,
      repoRoot: '/fake',
      pid: process.pid,
      status: expect.any(String),
    });
    expect(timing.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(timing.sourceUrl).toContain('run-git-sync.ts');
    expect(Number.isFinite(Date.parse(timing.startedAt))).toBe(true);
    expect(timing.durationMs).toBeGreaterThan(0);
    expect(Number.isFinite(timing.commitDurationMs)).toBe(true);
    const pointerCalls = f.phaseCalls.get('git-sync:pointer-bump')!;
    expect(pointerCalls.length).toBeGreaterThan(0);
    expect(pointerCalls.every(([args, , options]) =>
      options?.diagnosticTags?.runId === timing.runId
      && options?.diagnosticTags?.commandClass === 'git'
      && options?.diagnosticTags?.gitSubcommand === gitSubcommandOf(args))).toBe(true);

    const replay: GitSyncStepRunner = async (name, fn) => f.recorded.has(name) ? f.recorded.get(name) : fn();
    await runGitSync('timing-test', { ...f.opts, step: replay, submodulePaths: [] });
    expect(f.recorded.get('git-sync:pointer-bump').pointerBumpTiming).toEqual(timing);
  });

  it('forwards phase identities through the default bounded runner to the sidecar', async () => {
    const f = fixture();
    vi.spyOn(gitSidecar, 'gitSidecarEnabled').mockReturnValue(true);
    const sidecar = vi.spyOn(gitSidecar, 'runGitViaSpawnerSidecar').mockImplementation(
      (args, cwd, _timeout, _env, options) => f.opts.runGit(args, cwd, options),
    );
    const { runGit: _injectedRunner, ...opts } = f.opts;
    await runGitSync('timing-test', { ...opts, submodulePaths: ['libs/child'] });
    for (const phase of ['git-sync:submodules', 'git-sync:pointer-bump']) {
      const output = f.recorded.get(phase);
      const timing = output.submoduleTiming ?? output.pointerBumpTiming;
      const phaseCommands = sidecar.mock.calls.filter(([, , , , options]) => options?.diagnosticTags?.runId === timing.runId);
      expect(phaseCommands.length).toBeGreaterThan(0);
      for (const [args, , , , options] of phaseCommands) {
        const subcommand = gitSubcommandOf(args);
        const safeSubcommand = subcommand && /^[a-z][a-z0-9-]{0,63}$/.test(subcommand) ? subcommand : undefined;
        expect(options?.diagnosticTags).toEqual({
          runId: timing.runId, commandClass: 'git', ...(safeSubcommand ? { gitSubcommand: safeSubcommand } : {}),
        });
      }
    }
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
