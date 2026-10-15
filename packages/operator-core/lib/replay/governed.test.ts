/**
 * governed.test.ts — the flag + governor gate around the battery (P-020 /
 * FB-06, D-001 double-dark + D-004 refusal). All deps faked; the flag-off
 * path must never touch a pool (the default-on-flag-glue insight) — pinned by
 * fakes that throw when reached.
 */
import { describe, expect, it, vi } from 'vitest';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import type { LearningSpendReservation } from '../learning-governor/store';
import { REPLAY_BASELINE_VARIANT } from './battery';
import { replayPreflight, runGovernedReplay } from './governed';
import { REPLAY_LOOP_ID, type ReplayCase, type ReplayRunner, type ReplayStore } from './types';

const neverSql = async () => {
  throw new Error('pool must not be touched on this path');
};

const fakeJudge: JudgeLlmCall = async () => ({
  text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'ok' }),
  costUsd: 0.01,
  inputTokens: 10,
  outputTokens: 10,
});

const runner: ReplayRunner = async () => ({
  outputText: 'continuation',
  costUsd: 0.02,
  inputTokens: 10,
  outputTokens: 10,
  replayed: true,
});

const noopStore: ReplayStore = {
  startRun: async () => {},
  finishRun: async () => {},
  recordScore: async () => {},
  markFailed: async () => {},
};

const syntheticCase: ReplayCase = { kind: 'synthetic', caseId: 'c1', context: 'mid-task', intent: 'finish it' };

function reservationGlue() {
  const reservation: LearningSpendReservation = {
    id: 'reservation-replay', workspaceId: 'ws', loopId: REPLAY_LOOP_ID,
    potSlug: null, attemptKind: 'evaluation', requestedUsd: 5, reservedUsd: 5,
    usedUsd: 0, status: 'open', signalOrigin: 'replay', runRef: 'bat-gov',
    note: 'replay battery', createdAt: 1, settledAt: null,
  };
  const reserve = vi.fn(async () => ({ ok: true as const, reservation, clamped: false, headroomUsd: 5 }));
  const settle = vi.fn(async (_sql: unknown, input: { usedUsd?: number; disposition: string }) => ({
    ok: true as const, event: null, releasedUsd: 5 - (input.usedUsd ?? 0), overrunUsd: 0,
    reservation: { ...reservation, status: input.disposition === 'used' ? 'settled' as const : 'failed' as const,
      usedUsd: input.usedUsd ?? 0, settledAt: 2 },
  }));
  return {
    reservation, reserve, settle,
    glue: { enabled: async () => true, preflight: async () => ({ allow: true, remainingUsd: 5 }),
      getSql: async () => ({}) as never, reserve, settle, log: vi.fn() },
  };
}

describe('replayPreflight', () => {
  it('flag OFF ⇒ replay-dark, governor never consulted, pool untouched', async () => {
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => false,
        getSql: neverSql,
        preflight: async () => {
          throw new Error('governor must not be consulted while dark');
        },
      },
    );
    expect(verdict).toEqual({ allow: false, reason: 'replay-dark', remainingUsd: null });
  });

  it('flag ON ⇒ the governor verdict passes through (loop id pinned)', async () => {
    let seenLoopId = '';
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => true,
        preflight: async (q) => {
          seenLoopId = q.loopId;
          return { allow: true, remainingUsd: 3.5 };
        },
      },
    );
    expect(seenLoopId).toBe(REPLAY_LOOP_ID);
    expect(verdict).toEqual({ allow: true, remainingUsd: 3.5 });
  });

  it('fail-CLOSED: an erroring gate refuses', async () => {
    const verdict = await replayPreflight(
      { workspaceId: 'ws' },
      {
        enabled: async () => {
          throw new Error('posthog down');
        },
        log: () => {},
      },
    );
    expect(verdict).toEqual({ allow: false, reason: 'governor-error', remainingUsd: null });
  });
});

describe('runGovernedReplay', () => {
  const baseConfig = {
    batteryId: 'bat-gov',
    variants: [REPLAY_BASELINE_VARIANT],
    cases: [syntheticCase],
    repeats: 1,
  };

  it('refused preflight ⇒ no battery, no spend, result null', async () => {
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      {
        runner: async () => {
          throw new Error('runner must not run while dark');
        },
        llmCall: fakeJudge,
        now: () => 0,
      },
      { enabled: async () => false, getSql: neverSql },
    );
    expect(out.verdict.reason).toBe('replay-dark');
    expect(out.result).toBeNull();
  });

  it('reserves before starting cells, clamps the request, and settles one actual charge', async () => {
    const { glue, reserve, settle } = reservationGlue();
    const startRun = vi.fn(async () => { expect(reserve).toHaveBeenCalledOnce(); expect(settle).not.toHaveBeenCalled(); });
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: { ...baseConfig, maxSpendUsd: 9 } },
      { runner, llmCall: fakeJudge, store: { ...noopStore, startRun }, now: () => 0 },
      glue,
    );
    expect(out.result?.outcomes[0]?.status).toBe('scored');
    expect(startRun).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      loopId: REPLAY_LOOP_ID, signalOrigin: 'replay', runRef: 'bat-gov',
      attemptKind: 'evaluation', requestedUsd: 5,
    }));
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-replay', accumulate: true, disposition: 'used',
      usedUsd: out.result!.totalCostUsd,
    }));
    expect(out).toMatchObject({ reservation: { status: 'settled', usedUsd: out.result!.totalCostUsd, settledAt: 2 } });
  });

  it('a concurrent-headroom refusal runs no cells and returns the refusal', async () => {
    const { glue, settle } = reservationGlue();
    const startRun = vi.fn(noopStore.startRun);
    const reserve = vi.fn(async () => ({ ok: false as const, reason: 'no-headroom' as const, requestedUsd: 5, headroomUsd: 0 }));
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: { ...noopStore, startRun }, now: () => 0 },
      { ...glue, reserve },
    );
    expect(out).toMatchObject({ result: null, verdict: { allow: false, reason: 'reservation-refused' }, reservationRefusal: 'no-headroom' });
    expect(startRun).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('uses the granted amount, not the stale preflight headroom, as the battery cap', async () => {
    const { glue, reservation } = reservationGlue();
    const startRun = vi.fn(noopStore.startRun);
    const reserve = vi.fn(async () => ({ ok: true as const,
      reservation: { ...reservation, reservedUsd: 0 }, clamped: true, headroomUsd: 0 }));
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: { ...noopStore, startRun }, now: () => 0 },
      { ...glue, reserve },
    );
    expect(startRun).not.toHaveBeenCalled();
    expect(out.result?.budgetExhausted).toBe(true);
  });

  it('zero-cost batteries still settle their recorded evaluation attempt', async () => {
    const { glue, settle } = reservationGlue();
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner: async () => ({ outputText: 'free continuation', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true }),
        llmCall: async () => ({ text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'ok' }), costUsd: 0 }) as never,
        store: noopStore, now: () => 0 }, glue,
    );
    expect(out.result?.totalCostUsd).toBe(0);
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ disposition: 'used', usedUsd: 0 }));
    expect(out).toMatchObject({ reservation: { status: 'settled', usedUsd: 0 } });
  });

  it('an unknown judge charge retains its open reservation and the measured execution lower bound', async () => {
    const { glue, settle } = reservationGlue();
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: async () => { throw new Error('unknown provider charge'); }, store: noopStore, now: () => 0 },
      glue,
    );
    expect(out.result).toMatchObject({ totalCostUsd: 0.02, costMeasured: false });
    expect(out.reservation).toMatchObject({ status: 'open' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('a failed battery with unknown charge retains its open reservation', async () => {
    const { glue, settle } = reservationGlue();
    const failure = new Error('setup failed after the reservation');
    const badVariants = { [Symbol.iterator]: () => { throw failure; } } as never;
    await expect(runGovernedReplay(
      { workspaceId: 'ws', config: { ...baseConfig, variants: badVariants } },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 }, glue,
    )).rejects.toBe(failure);
    expect(settle).not.toHaveBeenCalled();
    expect(glue.log).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });

  it('a failed battery carrying its actual partial charge settles as failed', async () => {
    const { glue, settle } = reservationGlue();
    const failure = Object.assign(new Error('partial battery failure'), { costUsd: 0.4 });
    const badVariants = { [Symbol.iterator]: () => { throw failure; } } as never;
    await expect(runGovernedReplay(
      { workspaceId: 'ws', config: { ...baseConfig, variants: badVariants } },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 }, glue,
    )).rejects.toBe(failure);
    expect(settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ disposition: 'failed', usedUsd: 0.4 }));
  });

  it('a missing finite budget refuses before opening a reservation or running cells', async () => {
    const { glue, reserve } = reservationGlue();
    const startRun = vi.fn(noopStore.startRun);
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: { ...noopStore, startRun }, now: () => 0 },
      { ...glue, preflight: async () => ({ allow: true, remainingUsd: null }) },
    );
    expect(out).toMatchObject({ result: null, verdict: { allow: false, reason: 'reservation-unmeasured' } });
    expect(reserve).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it('a reservation error refuses before running cells', async () => {
    const { glue } = reservationGlue();
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 },
      { ...glue, reserve: async () => { throw new Error('reservation table unavailable'); } },
    );
    expect(out).toMatchObject({ result: null, verdict: { allow: false, reason: 'reservation-error' } });
  });

  it('a refused settlement preserves the actual open position', async () => {
    const { glue, reservation } = reservationGlue();
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 },
      { ...glue, settle: async () => ({ ok: false as const, reason: 'not-found' as const, reservation: null }) },
    );
    expect(out.result?.outcomes).toHaveLength(1);
    expect(out).toMatchObject({ reservation });
    expect(glue.log).toHaveBeenCalledWith(expect.stringContaining('not-found'));
  });

  it('settlement failure never loses the battery result or claims settled spend', async () => {
    const { glue, reservation } = reservationGlue();
    const out = await runGovernedReplay(
      { workspaceId: 'ws', config: baseConfig },
      { runner, llmCall: fakeJudge, store: noopStore, now: () => 0 },
      { ...glue, settle: async () => { throw new Error('ledger down'); } },
    );
    expect(out.result?.outcomes).toHaveLength(1);
    expect(out).toMatchObject({ reservation });
    expect(glue.log).toHaveBeenCalledWith(expect.stringContaining('OPEN'));
  });
});
