/**
 * unclaimable-routine-detector.test.ts — WI-40883.
 *
 * The decider's whole value is the line between "lost a race" (silence, the overwhelmingly
 * common case) and "unreachable" (alarm). Both sides are tested: an alarm that fires on normal
 * contention would be turned off within a day, which is how the original bug stayed invisible.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyClaimSkip,
  UNCLAIMABLE_AFTER_MS,
  type ClaimSkipInput,
} from './unclaimable-routine-detector';

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

function input(over: Partial<ClaimSkipInput> = {}): ClaimSkipInput {
  return {
    id: 'rt_papercusp_thing',
    name: 'thing',
    installSlug: 'papercusp',
    nextFireAt: new Date(NOW - 1000),
    lastFiredAt: new Date(NOW - 60_000),
    ...over,
  };
}

describe('classifyClaimSkip', () => {
  it('WI-10005062: does not throw when lastFiredAt arrives as a string (it aborted routinesTick)', () => {
    const raw = '2026-08-23T10:00:00.000Z' as unknown as Date;
    const v = classifyClaimSkip(input({ nextFireAt: new Date(NOW - 90 * 60_000), lastFiredAt: raw }), NOW);
    expect(v.state).toBe('unclaimable');
    expect(v.reason).toContain('last fired at 2026-08-23T10:00:00.000Z');
  });

  it('stays SILENT for a routine that just lost a race (the common case)', () => {
    // Two executors contend on every tick; the loser must not alarm. If this ever flips, the
    // detector becomes noise and gets ignored — the exact failure it exists to prevent.
    const v = classifyClaimSkip(input({ nextFireAt: new Date(NOW - 1000) }), NOW);
    expect(v.state).toBe('race');
  });

  it('stays SILENT just BELOW the threshold (boundary, not a cliff)', () => {
    const v = classifyClaimSkip(
      input({ nextFireAt: new Date(NOW - (UNCLAIMABLE_AFTER_MS - 1)) }),
      NOW,
    );
    expect(v.state).toBe('race');
  });

  it('ALARMS at/above the threshold', () => {
    const v = classifyClaimSkip(input({ nextFireAt: new Date(NOW - UNCLAIMABLE_AFTER_MS) }), NOW);
    expect(v.state).toBe('unclaimable');
  });

  it('REGRESSION SHAPE: a never-fired routine long overdue is reported as never-fired', () => {
    // This is literally the gc-desktop-sessions / green-checkpoint row shape that went dark.
    const v = classifyClaimSkip(
      input({ nextFireAt: new Date(NOW - 36 * 3600_000), lastFiredAt: null }),
      NOW,
    );
    expect(v.state).toBe('unclaimable');
    if (v.state !== 'unclaimable') throw new Error('unreachable');
    expect(v.neverFired).toBe(true);
    expect(v.reason).toContain('NEVER fired');
    expect(v.reason).toContain('thing');
    expect(v.reason).toContain('papercusp');
  });

  it('distinguishes a once-healthy routine that STOPPED from one that never started', () => {
    const v = classifyClaimSkip(
      input({ nextFireAt: new Date(NOW - 2 * 3600_000), lastFiredAt: new Date(NOW - 5 * 3600_000) }),
      NOW,
    );
    expect(v.state).toBe('unclaimable');
    if (v.state !== 'unclaimable') throw new Error('unreachable');
    expect(v.neverFired).toBe(false);
    expect(v.reason).toContain('last fired at');
    expect(v.reason).not.toContain('NEVER fired');
  });

  it('does not alarm on a due-by-NULL row (no due time to age against)', () => {
    const v = classifyClaimSkip(input({ nextFireAt: null, lastFiredAt: null }), NOW);
    expect(v.state).toBe('race');
    expect(v.overdueMs).toBeNull();
  });

  it('reports overdue minutes accurately in the reason', () => {
    const v = classifyClaimSkip(input({ nextFireAt: new Date(NOW - 90 * 60_000) }), NOW);
    if (v.state !== 'unclaimable') throw new Error('expected unclaimable');
    expect(v.reason).toContain('90m');
    expect(v.overdueMs).toBe(90 * 60_000);
  });
});
