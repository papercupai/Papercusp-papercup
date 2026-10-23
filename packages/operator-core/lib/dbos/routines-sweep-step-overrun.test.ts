import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTINES_SWEEP_STEP_OVERRUN_BUDGET_MS,
  runSweepStepWithOverrunBudget,
} from './routines-sweep-step-overrun';

describe('routinesSweepTick step overrun logging', () => {
  afterEach(() => vi.useRealTimers());

  it('uses a 30 second diagnostic budget without cancelling a slow step', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let finish!: (value: string) => void;
    const result = runSweepStepWithOverrunBudget(
      'wall-fact-lapse-sweep',
      () => new Promise<string>((resolvePromise) => { finish = resolvePromise; }),
      { budgetMs: 30, workflowId: 'sweep-1', log },
    );

    await vi.advanceTimersByTimeAsync(30);
    expect(log).toHaveBeenCalledWith(
      '[routines-sweep-step] exceeded diagnostic budget; step is still running',
      expect.objectContaining({ stepName: 'wall-fact-lapse-sweep', workflowId: 'sweep-1', phase: 'still-running' }),
    );
    finish('finished');
    await expect(result).resolves.toBe('finished');
    expect(log).toHaveBeenLastCalledWith(
      '[routines-sweep-step] step completed over diagnostic budget',
      expect.objectContaining({ stepName: 'wall-fact-lapse-sweep', elapsedMs: 30, phase: 'completed', outcome: 'succeeded' }),
    );
    expect(ROUTINES_SWEEP_STEP_OVERRUN_BUDGET_MS).toBe(30_000);
  });

  it('preserves a slow step rejection and records the failed outcome', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const failure = new Error('step failed');
    const pending = runSweepStepWithOverrunBudget(
      'loop-rebase-sweep',
      async () => {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 30));
        throw failure;
      },
      { budgetMs: 15, log },
    );

    const rejected = expect(pending).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(log).toHaveBeenLastCalledWith(
      '[routines-sweep-step] step completed over diagnostic budget',
      expect.objectContaining({ stepName: 'loop-rebase-sweep', phase: 'completed', outcome: 'failed' }),
    );
  });

  it('routes every sweep DBOS step through the diagnostic proxy, including loop rebase', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const passStart = source.indexOf(
      'async function routinesSweepPassImpl(DBOS: typeof timedSweepDbos = timedSweepDbos): Promise<void> {',
    );
    const passEnd = source.indexOf('\nconst routinesTickWorkflow', passStart);
    const pass = source.slice(passStart, passEnd);
    const tickStart = source.indexOf('async function routinesSweepTickImpl(): Promise<void> {');
    const tickEnd = source.indexOf('\nasync function routinesSweepPassImpl', tickStart);
    const tick = source.slice(tickStart, tickEnd);
    const proxyStart = source.indexOf('const timedSweepDbos = new Proxy(DBOS, {');
    const proxyEnd = source.indexOf('\n});', proxyStart);
    const proxy = source.slice(proxyStart, proxyEnd);
    const loopStart = source.indexOf('async function runLoopRebaseSweep(');
    const loopEnd = source.indexOf('/** The scheduled tick:', loopStart);
    const loopHelper = source.slice(loopStart, loopEnd);

    expect(passStart).toBeGreaterThan(-1);
    expect(tick).toContain('await routinesSweepPassImpl(timedSweepDbos)');
    expect(proxy).toContain('runSweepStepWithOverrunBudget(');
    expect(proxy).toContain('Reflect.apply(value, target, [wrappedOperation, ...stepArgs])');
    expect(pass).toMatch(/DBOS\.runStep\(/);
    expect(pass).not.toMatch(/runLoopRebaseSweep\(sql\)/);
    expect(pass).toContain('runLoopRebaseSweep(sql, DBOS)');
    expect(loopHelper).toContain('dbos: typeof DBOS = DBOS');
    expect(loopHelper).toContain('await dbos.runStep(');
  });
});
