import { describe, expect, it } from 'vitest';
import {
  armTurnEndRewake,
  cancelTurnEndRewake,
  decideTurnEndRewake,
  isTurnEndRewakeKey,
  TURN_END_REWAKE_BASE_SEC,
  TURN_END_REWAKE_JITTER,
  TURN_END_REWAKE_NO_PROGRESS_BUDGET,
  turnEndRewakeKey,
  turnEndRewakeNote,
  turnEndRewakeRefusalLine,
  turnEndRewakeTimeoutSec,
  type TurnEndRewakeDeps,
} from './turn-end-rewake';
import type { HeldWorkItem } from './wake-source-predicate';

// WI-6554700010018567: the per-agent timer the turn-end gate arms when it refuses a stop.
const OWNER = 'su-test-owner';
const held = (id: string): HeldWorkItem => ({ id, harness: 'papercusp', status: 'wip', eventBlockers: [] });

function spyDeps(fired: number) {
  const armed: Array<{ ownerId: string; eventKey: string; timeoutSec: number; note: string }> = [];
  const cancelled: Array<[string, string]> = [];
  const counted: Array<readonly string[]> = [];
  const deps: Partial<TurnEndRewakeDeps> = {
    countFiredWithoutProgress: async (_owner, ids) => {
      counted.push(ids);
      return fired;
    },
    arm: async (input) => {
      armed.push(input);
    },
    cancel: async (ownerId, key) => {
      cancelled.push([ownerId, key]);
    },
    random: () => 0.5,
  };
  return { deps, armed, cancelled, counted };
}

describe('turn-end rewake timer (WI-6554700010018567)', () => {
  it('keys the timer per owner on a prefix nothing emits', () => {
    expect(turnEndRewakeKey(OWNER)).toBe(`turn-end:rewake:${OWNER}`);
    expect(isTurnEndRewakeKey(turnEndRewakeKey(OWNER))).toBe(true);
    expect(isTurnEndRewakeKey(`coord:inbox-wake:${OWNER}`)).toBe(false);
  });

  it('jitters the deadline within ±20% of 15 minutes', () => {
    const spread = TURN_END_REWAKE_BASE_SEC * TURN_END_REWAKE_JITTER;
    expect(turnEndRewakeTimeoutSec(() => 0)).toBe(TURN_END_REWAKE_BASE_SEC - spread);
    expect(turnEndRewakeTimeoutSec(() => 0.5)).toBe(TURN_END_REWAKE_BASE_SEC);
    expect(turnEndRewakeTimeoutSec(() => 0.999999)).toBe(TURN_END_REWAKE_BASE_SEC + spread);
    // An out-of-range random is clamped, never a zero or negative deadline.
    expect(turnEndRewakeTimeoutSec(() => -3)).toBe(TURN_END_REWAKE_BASE_SEC - spread);
  });

  it('arms attempt N+1 until the no-progress budget is spent, then stops arming', () => {
    expect(TURN_END_REWAKE_NO_PROGRESS_BUDGET).toBe(2);
    expect(decideTurnEndRewake(0, () => 0.5)).toEqual({ kind: 'armed', attempt: 1, timeoutSec: 900 });
    expect(decideTurnEndRewake(1, () => 0.5)).toEqual({ kind: 'armed', attempt: 2, timeoutSec: 900 });
    expect(decideTurnEndRewake(2)).toEqual({ kind: 'exhausted', firedWithoutProgress: 2 });
    expect(decideTurnEndRewake(5)).toEqual({ kind: 'exhausted', firedWithoutProgress: 5 });
  });

  it('registers one await on the owner key with the wake note, counting against the held ids', async () => {
    const spy = spyDeps(1);
    const outcome = await armTurnEndRewake({ ownerId: OWNER, held: [held('WI-1'), held('WI-2')], deps: spy.deps });
    expect(outcome).toEqual({ kind: 'armed', attempt: 2, timeoutSec: 900 });
    expect(spy.counted).toEqual([['WI-1', 'WI-2']]);
    expect(spy.armed).toHaveLength(1);
    expect(spy.armed[0]).toMatchObject({ ownerId: OWNER, eventKey: turnEndRewakeKey(OWNER), timeoutSec: 900 });
    expect(spy.armed[0].note).toContain('turn-end rewake 2 of 2');
    expect(spy.armed[0].note).toContain('WI-1, WI-2');
  });

  it('registers nothing once the budget is spent', async () => {
    const spy = spyDeps(2);
    const outcome = await armTurnEndRewake({ ownerId: OWNER, held: [held('WI-1')], deps: spy.deps });
    expect(outcome.kind).toBe('exhausted');
    expect(spy.armed).toHaveLength(0);
  });

  it('cancels only this owner key', async () => {
    const spy = spyDeps(0);
    await cancelTurnEndRewake({ ownerId: OWNER, deps: spy.deps });
    expect(spy.cancelled).toEqual([[OWNER, turnEndRewakeKey(OWNER)]]);
  });

  it('caps the ids the note names', () => {
    const many = Array.from({ length: 7 }, (_, i) => held(`WI-${i + 1}`));
    expect(turnEndRewakeNote(1, many)).toContain('WI-5, +2 more');
  });

  it('labels the one-shot fallback without implying a standing wake or paging', () => {
    const armed = turnEndRewakeRefusalLine({ kind: 'armed', attempt: 1, timeoutSec: 900 });
    expect(armed).toContain('One-shot rewake fallback scheduled');
    expect(armed).toContain('not a standing wake source');
    expect(armed).toContain('timed rewake 1 of 2');
    expect(armed).toContain('never pages anyone');
    expect(turnEndRewakeNote(1, [held('WI-1')])).toContain('one-shot fallback woke you');
    expect(turnEndRewakeRefusalLine({ kind: 'exhausted', firedWithoutProgress: 2 })).not.toMatch(/\bpag(e|ed|ing)\b/);
  });
});
