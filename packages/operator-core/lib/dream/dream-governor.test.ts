import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  DREAM_REGISTRANT_PRIORITY,
  DREAM_ROLLING_WINDOW_MS,
  dreamLoopId,
  dreamRegistrationInput,
  preflightDreamCycle,
  sumDreamSpendSince,
  type DreamGovernorDeps,
} from './dream-governor';

const sql = (() => Promise.resolve([])) as unknown as Sql;

describe('legacy tiered usage budget bounds', () => {
  it('accounts for a lost zero-price receipt without changing it or double-counting its loop', async () => {
    const outcome = { capabilityRun: {
      schemaVersion: 'dream-capability-run-v1', manifestHash: 'a'.repeat(64), manifestRevision: 'fixture',
      dreamerModel: 'gpt-6.1-sol', reviewerModel: 'gpt-6.1-sol',
      dreamPromptVersion: 'fixture', reviewPromptVersion: 'fixture', sampling: null, artifactId: null,
      calls: [{ callId: 'generation', phase: 'generation', model: 'gpt-6.1-sol', status: 'settled',
        reservedUsd: 0.1, error: null, usage: { model: 'gpt-6.1-sol', costUsd: 0, inputTokens: 6670, outputTokens: 446 } }],
    } };
    const query = vi.fn()
      .mockResolvedValueOnce([{ total: 2, loops: 1, loop_ids: ['dream:papercusp'] }])
      .mockResolvedValueOnce([{ pot_slug: 'papercusp', outcome }]);
    const result = await sumDreamSpendSince(query as unknown as Sql, { workspaceId: 'ws', sinceMs: 0 });
    expect(result.totalUsd).toBeGreaterThan(2);
    expect(result.totalUsd).toBeLessThanOrEqual(2.1);
    expect(result.loopCount).toBe(1);
    expect(outcome.capabilityRun.calls[0]!.usage.costUsd).toBe(0);
  });
});

function deps(overrides: Partial<DreamGovernorDeps> = {}): DreamGovernorDeps {
  return {
    enabled: vi.fn(async () => true),
    register: vi.fn(async () => ({})),
    check: vi.fn(async () => ({ allow: true, remainingUsd: 1 })),
    sumSince: vi.fn(async () => ({ totalUsd: 1.25, loopCount: 2 })),
    now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    ...overrides,
  };
}

describe('dream governor registration', () => {
  it('extends the shared governor with one bounded per-cycle registrant', () => {
    expect(dreamLoopId(' papercusp ')).toBe('dream:papercusp');
    expect(dreamRegistrationInput({ workspaceId: 'ws-1', potSlug: 'papercusp' })).toEqual({
      workspaceId: 'ws-1',
      loopId: 'dream:papercusp',
      potSlug: 'papercusp',
      displayName: 'Dream cycles (papercusp)',
      budgetKind: 'per-cycle',
      budgetUsd: 1,
      priority: DREAM_REGISTRANT_PRIORITY,
      enabled: true,
      enforcement: 'governor',
      meta: {
        maxDreamsPerCycle: 3,
        rolling24hCostUsd: 5,
        rollingWindowMs: DREAM_ROLLING_WINDOW_MS,
      },
    });
  });
});

describe('preflightDreamCycle', () => {
  it('registers raised cycle caps and enforces the configured rolling ceiling', async () => {
    const input = { workspaceId: 'ws-1', potSlug: 'papercusp', config: { maxCostUsd: 10, rolling24hCostUsd: 200 } };
    const d = deps({
      check: vi.fn(async () => ({ allow: true, remainingUsd: 10 })),
      sumSince: vi.fn(async () => ({ totalUsd: 199, loopCount: 2 })),
    });
    await expect(preflightDreamCycle(sql, input, d)).resolves.toMatchObject({
      allow: true,
      cycleRemainingUsd: 10,
      rollingRemainingUsd: 1,
    });
    expect(d.register).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        budgetUsd: 10,
        meta: expect.objectContaining({ rolling24hCostUsd: 200 }),
      }),
    );
    d.sumSince = async () => ({ totalUsd: 200, loopCount: 2 });
    await expect(preflightDreamCycle(sql, input, d)).resolves.toMatchObject({
      allow: false,
      reason: 'rolling-cap-exceeded',
      rollingRemainingUsd: 0,
    });
  });

  it('fails closed before registration when the shared governor flag is dark', async () => {
    const d = deps({ enabled: vi.fn(async () => false) });

    await expect(preflightDreamCycle(sql, { workspaceId: 'ws-1', potSlug: 'papercusp' }, d)).resolves.toEqual({
      allow: false,
      loopId: 'dream:papercusp',
      reason: 'governor-dark',
      cycleRemainingUsd: null,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 5,
      rollingLoopCount: 0,
    });
    expect(d.register).not.toHaveBeenCalled();
  });

  it('honors a shared-governor refusal even when the rolling window has room', async () => {
    const d = deps({
      check: vi.fn(async () => ({ allow: false as const, reason: 'disabled' as const, remainingUsd: 1 })),
    });

    await expect(preflightDreamCycle(sql, { workspaceId: 'ws-1', potSlug: 'papercusp' }, d)).resolves.toMatchObject({
      allow: false,
      reason: 'disabled',
      cycleRemainingUsd: 1,
      rollingSpentUsd: 1.25,
      rollingRemainingUsd: 3.75,
    });
  });

  it('refuses at the workspace-wide rolling ceiling and measures the exact 24h window', async () => {
    const d = deps({ sumSince: vi.fn(async () => ({ totalUsd: 5, loopCount: 3 })) });

    await expect(preflightDreamCycle(sql, { workspaceId: 'ws-1', potSlug: 'papercusp' }, d)).resolves.toMatchObject({
      allow: false,
      reason: 'rolling-cap-exceeded',
      rollingSpentUsd: 5,
      rollingRemainingUsd: 0,
      rollingLoopCount: 3,
    });
    expect(d.sumSince).toHaveBeenCalledWith(sql, {
      workspaceId: 'ws-1',
      sinceMs: d.now() - DREAM_ROLLING_WINDOW_MS,
    });
  });

  it('returns both cycle and rolling remaining spend when every gate allows', async () => {
    const d = deps();

    await expect(preflightDreamCycle(sql, { workspaceId: 'ws-1', potSlug: 'papercusp' }, d)).resolves.toEqual({
      allow: true,
      loopId: 'dream:papercusp',
      cycleRemainingUsd: 1,
      rollingSpentUsd: 1.25,
      rollingRemainingUsd: 3.75,
      rollingLoopCount: 2,
    });
    expect(d.register).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ loopId: 'dream:papercusp', budgetKind: 'per-cycle', budgetUsd: 1 }),
    );
  });
});
