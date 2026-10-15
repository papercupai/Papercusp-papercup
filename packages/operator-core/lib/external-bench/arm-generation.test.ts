/**
 * Shared generation primitive unit tests — fake ports, no real clone / harness / diff.
 */
import { describe, expect, it, vi } from 'vitest';
import { runArmGeneration, runPapercuspArm } from './arm-generation';
import type { BenchTask, GenerationPorts, GenerationTelemetry, TaskCheckout } from './types';

function task(): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: 'i1', problemStatement: 'p', repo: 'a/b', baseCommit: 'abc1234', graderMeta: {} };
}

function telemetry(over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return { tokensIn: 100, tokensOut: 200, costUsd: 0.5, turns: 7, wallClockMs: 1234, trajectoryRef: 'roll://1', stopReason: 'done', ...over };
}

const input = { arm: 'papercusp', blueprintId: 'external-bench', task: task(), seed: 'seed-0', budget: {} };

describe('runArmGeneration', () => {
  it('maps a clean run to an ArmAttempt and always cleans up', async () => {
    const cleanup = vi.fn(async () => {});
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup }) as TaskCheckout,
      extractDiff: async () => 'DIFF-OUT',
      instantiate: async () => ({ worktreePath: '/co', telemetry: telemetry() }),
    };
    const a = await runArmGeneration(input, ports);
    expect(a).toMatchObject({
      arm: 'papercusp',
      blueprintId: 'external-bench',
      instanceId: 'i1',
      seed: 'seed-0',
      diff: 'DIFF-OUT',
      tokensIn: 100,
      tokensOut: 200,
      costUsd: 0.5,
      turns: 7,
      wallClockMs: 1234,
      trajectoryRef: 'roll://1',
      stopReason: 'done',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('a clone failure → stopReason error; never instantiates', async () => {
    const instantiate = vi.fn();
    const extractDiff = vi.fn();
    const ports: GenerationPorts = {
      clone: async () => {
        throw new Error('netfail');
      },
      extractDiff: extractDiff as never,
      instantiate: instantiate as never,
    };
    const a = await runArmGeneration(input, ports);
    expect(a.stopReason).toBe('error');
    expect(a.generationError).toMatch(/clone failed: netfail/);
    expect(a.diff).toBe('');
    expect(instantiate).not.toHaveBeenCalled();
  });

  it('an instantiate failure → stopReason error; still cleans up', async () => {
    const cleanup = vi.fn(async () => {});
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup }) as TaskCheckout,
      extractDiff: async () => 'X',
      instantiate: async () => {
        throw new Error('harness boom');
      },
    };
    const a = await runArmGeneration(input, ports);
    expect(a.stopReason).toBe('error');
    expect(a.generationError).toMatch(/instantiate failed: harness boom/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('a diff-extraction failure → stopReason error; cleans up', async () => {
    const cleanup = vi.fn(async () => {});
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup }) as TaskCheckout,
      extractDiff: async () => {
        throw new Error('diff boom');
      },
      instantiate: async () => ({ worktreePath: '/co', telemetry: telemetry() }),
    };
    const a = await runArmGeneration(input, ports);
    expect(a.stopReason).toBe('error');
    expect(a.generationError).toMatch(/extractDiff failed: diff boom/);
    expect(a.diff).toBe('');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not extract a diff when the harness itself errored', async () => {
    const extractDiff = vi.fn(async () => 'SHOULD-NOT-RUN');
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup: async () => {} }) as TaskCheckout,
      extractDiff,
      instantiate: async () => ({ worktreePath: '/co', telemetry: telemetry({ stopReason: 'error', generationError: 'died' }) }),
    };
    const a = await runArmGeneration(input, ports);
    expect(a.stopReason).toBe('error');
    expect(a.diff).toBe('');
    expect(extractDiff).not.toHaveBeenCalled();
  });

  it('carries a budget-exhausted stop through but still grades the diff it produced', async () => {
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup: async () => {} }) as TaskCheckout,
      extractDiff: async () => 'PARTIAL',
      instantiate: async () => ({ worktreePath: '/co', telemetry: telemetry({ stopReason: 'budget-exhausted' }) }),
    };
    const a = await runArmGeneration(input, ports);
    expect(a.stopReason).toBe('budget-exhausted');
    expect(a.diff).toBe('PARTIAL');
  });
});

describe('runPapercuspArm', () => {
  it('runs the maintained current treatment and preserves its execution receipts', async () => {
    const ports: GenerationPorts = {
      clone: async () => ({ dir: '/co', repo: 'a/b', baseCommit: 'abc1234', cleanup: async () => {} }) as TaskCheckout,
      extractDiff: async () => 'D',
      instantiate: async (blueprintId) => {
        expect(blueprintId).toBe('su');
        return { worktreePath: '/co', telemetry: telemetry({ armMeta: { currentExecution: { identityStatus: 'unknown' } } }) };
      },
    };
    const a = await runPapercuspArm(task(), 'seed-0', {}, ports);
    expect(a.arm).toBe('papercusp');
    expect(a.blueprintId).toBe('su');
    expect(a.armMeta).toEqual({ currentExecution: { identityStatus: 'unknown' } });
  });
});
