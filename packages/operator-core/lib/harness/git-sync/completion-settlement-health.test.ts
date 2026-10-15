import { describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_SETTLEMENT_HEALTH_KEY,
  FLOOR_REJECTED_CONSECUTIVE_FIRES_LIMIT,
  LOOKUP_UNAVAILABLE_CONSECUTIVE_FIRES_LIMIT,
  NEVER_ATTEMPTED_WAIT_FIRES_LIMIT,
  advanceCompletionSettlementHealth,
  recordCompletionSettlementHealth,
  type CompletionSettlementHealth,
  type SettlementFireObservation,
} from './completion-settlement-health';

const NOW = Date.parse('2026-09-30T20:30:00.000Z');

const completed = (over: Partial<Extract<SettlementFireObservation, { outcome: 'completed' }>> = {}) =>
  ({
    outcome: 'completed',
    inspected: 200,
    upgraded: 10,
    residual: 3,
    unreadable: 0,
    floorRejected: 0,
    lookupUnavailable: 0,
    neverAttemptedRemaining: 0,
    ...over,
  }) as SettlementFireObservation;

/** Drive N successive fires, feeding each verdict back in as the next `previous`. */
function run(observations: SettlementFireObservation[]): CompletionSettlementHealth[] {
  const out: CompletionSettlementHealth[] = [];
  let previous: unknown = null;
  for (const observation of observations) {
    const next = advanceCompletionSettlementHealth(previous, observation, NOW);
    out.push(next);
    previous = next;
  }
  return out;
}

describe('advanceCompletionSettlementHealth', () => {
  it('is ok with zeroed streaks when nothing waits and nothing is floor-rejected', () => {
    const [h] = run([completed()]);
    expect(h).toMatchObject({
      verdict: 'ok',
      reasons: [],
      consecutive_never_attempted_fires: 0,
      consecutive_floor_rejected_fires: 0,
      last_outcome: 'completed',
      inspected: 200,
      upgraded: 10,
    });
    expect(h!.observed_at).toBe('2026-09-30T20:30:00.000Z');
  });

  it('fails only once never-attempted candidates have waited the limit of consecutive fires', () => {
    const fires = run(Array.from({ length: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT }, () => completed({ neverAttemptedRemaining: 11 })));
    expect(fires.slice(0, -1).every((h) => h.verdict === 'ok')).toBe(true);
    const last = fires.at(-1)!;
    expect(last.verdict).toBe('failing');
    expect(last.consecutive_never_attempted_fires).toBe(NEVER_ATTEMPTED_WAIT_FIRES_LIMIT);
    expect(last.reasons).toHaveLength(1);
    expect(last.reasons[0]).toMatch(/^never-attempted: 11 /);
  });

  it('recovers the moment the never-attempted tier is empty', () => {
    const fires = run([
      ...Array.from({ length: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT }, () => completed({ neverAttemptedRemaining: 4 })),
      completed({ neverAttemptedRemaining: 0 }),
    ]);
    expect(fires.at(-2)!.verdict).toBe('failing');
    expect(fires.at(-1)).toMatchObject({ verdict: 'ok', consecutive_never_attempted_fires: 0 });
  });

  it('counts a budget-exceeded fire toward the never-attempted streak (the DB count is still measured)', () => {
    const fires = run(
      Array.from({ length: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT }, () => ({
        outcome: 'budget-exceeded' as const,
        neverAttemptedRemaining: 7,
      })),
    );
    const last = fires.at(-1)!;
    expect(last.verdict).toBe('failing');
    // a cut-short pass has no per-row stats — they must read null, never a fabricated 0
    expect(last).toMatchObject({
      last_outcome: 'budget-exceeded',
      inspected: null,
      upgraded: null,
      residual: null,
      unreadable: null,
      floor_rejected: null,
    });
  });

  it('holds the never-attempted streak when the count itself could not be measured', () => {
    const fires = run([
      completed({ neverAttemptedRemaining: 5 }),
      completed({ neverAttemptedRemaining: 5 }),
      { outcome: 'error', neverAttemptedRemaining: null, error: 'pg down' },
      completed({ neverAttemptedRemaining: 5 }),
    ]);
    expect(fires.map((h) => h.consecutive_never_attempted_fires)).toEqual([1, 2, 2, 3]);
    expect(fires.at(-1)!.verdict).toBe('failing');
    expect(fires[2]!.never_attempted_remaining).toBeNull();
  });

  it('fails on consecutive measured floor-rejected fires and only then', () => {
    const fires = run(Array.from({ length: FLOOR_REJECTED_CONSECUTIVE_FIRES_LIMIT }, () => completed({ floorRejected: 119 })));
    expect(fires[0]!.verdict).toBe('ok');
    expect(fires.at(-1)!.verdict).toBe('failing');
    expect(fires.at(-1)!.reasons[0]).toMatch(/^floor-rejected: /);
  });

  it('a cut-short fire neither extends nor resets the floor-rejected streak', () => {
    const fires = run([
      completed({ floorRejected: 3 }),
      { outcome: 'budget-exceeded', neverAttemptedRemaining: 0 },
      completed({ floorRejected: 3 }),
    ]);
    expect(fires.map((h) => h.consecutive_floor_rejected_fires)).toEqual([1, 1, 2]);
    expect(fires.at(-1)!.verdict).toBe('failing');
  });

  it('a clean completed fire resets the floor-rejected streak', () => {
    const fires = run([completed({ floorRejected: 3 }), completed({ floorRejected: 0 }), completed({ floorRejected: 3 })]);
    expect(fires.map((h) => h.consecutive_floor_rejected_fires)).toEqual([1, 0, 1]);
    expect(fires.every((h) => h.verdict === 'ok')).toBe(true);
  });

  // EI-24807349327024992: a skipped (lookup-unavailable) row is not settled. One fire is a git
  // timeout under load; a run of them must fail the guard, and a clean fire must reset it.
  it('fails on consecutive lookup-unavailable fires, holds across a cut-short fire, resets on a clean one', () => {
    const streak = run(
      Array.from({ length: LOOKUP_UNAVAILABLE_CONSECUTIVE_FIRES_LIMIT }, () => completed({ lookupUnavailable: 4 })),
    );
    expect(streak.slice(0, -1).every((h) => h.verdict === 'ok')).toBe(true);
    expect(streak.at(-1)!.verdict).toBe('failing');
    expect(streak.at(-1)!.reasons[0]).toMatch(/^lookup-unavailable: /);
    expect(streak.at(-1)!.lookup_unavailable).toBe(4);

    const held = run([
      completed({ lookupUnavailable: 1 }),
      { outcome: 'budget-exceeded', neverAttemptedRemaining: 0 },
      completed({ lookupUnavailable: 0 }),
    ]);
    expect(held.map((h) => h.consecutive_lookup_unavailable_fires)).toEqual([1, 1, 0]);
    expect(held[1]!.lookup_unavailable).toBeNull();
  });

  it('reports both reasons when both conditions hold', () => {
    const both = completed({ floorRejected: 2, neverAttemptedRemaining: 2 });
    const last = run(Array.from({ length: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT }, () => both)).at(-1)!;
    expect(last.reasons.map((r) => r.split(':')[0]).sort()).toEqual(['floor-rejected', 'never-attempted']);
  });

  it.each([undefined, null, 'garbage', 42, { consecutive_never_attempted_fires: 'NaN' }, { consecutive_floor_rejected_fires: -5 }])(
    'treats an unusable previous value %j as a fresh start',
    (previous) => {
      const h = advanceCompletionSettlementHealth(previous, completed({ neverAttemptedRemaining: 1, floorRejected: 1 }), NOW);
      expect(h).toMatchObject({ consecutive_never_attempted_fires: 1, consecutive_floor_rejected_fires: 1, verdict: 'ok' });
    },
  );
});

describe('recordCompletionSettlementHealth', () => {
  const setup = (previous: unknown) => {
    const write = vi.fn(async () => {});
    const warn = vi.fn();
    const deps = { readPrevious: async () => previous, write, warn, now: () => NOW };
    return { write, warn, deps };
  };

  it('persists the verdict under the `_health` key routines:list already projects', async () => {
    const { write, deps } = setup(null);
    const h = await recordCompletionSettlementHealth(completed(), deps);
    expect(COMPLETION_SETTLEMENT_HEALTH_KEY.endsWith('_health')).toBe(true);
    expect(write).toHaveBeenCalledWith({ [COMPLETION_SETTLEMENT_HEALTH_KEY]: h });
  });

  it('warns once on the ok→failing edge and stays quiet while the failure persists', async () => {
    const edge = setup({ consecutive_never_attempted_fires: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT - 1, verdict: 'ok' });
    await recordCompletionSettlementHealth(completed({ neverAttemptedRemaining: 9 }), edge.deps);
    expect(edge.warn).toHaveBeenCalledTimes(1);
    expect(edge.warn.mock.calls[0]![0]).toMatch(/standing guard FAILING: never-attempted/);

    const chronic = setup({ consecutive_never_attempted_fires: NEVER_ATTEMPTED_WAIT_FIRES_LIMIT, verdict: 'failing' });
    await recordCompletionSettlementHealth(completed({ neverAttemptedRemaining: 9 }), chronic.deps);
    expect(chronic.warn).not.toHaveBeenCalled();
  });

  it('survives an unreadable previous value by restarting the streaks, and still writes', async () => {
    const write = vi.fn(async () => {});
    const h = await recordCompletionSettlementHealth(completed({ neverAttemptedRemaining: 2 }), {
      readPrevious: async () => {
        throw new Error('pg unavailable');
      },
      write,
      warn: vi.fn(),
      now: () => NOW,
    });
    expect(h.consecutive_never_attempted_fires).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
