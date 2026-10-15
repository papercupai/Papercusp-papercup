/**
 * signal-actor-registry.test.ts — EI-7347: every registered signal must
 * carry a live actor or an unexpired waiver; a lapsed one REDS the build so
 * the gap can't linger silently forever (mirrors KNOWN_DARK_FLAGS expiry).
 */

import { describe, expect, it } from 'vitest';
import {
  defineSignal,
  getSignal,
  isSignalCovered,
  listSignals,
  uncoveredSignals,
  type SignalActorEntry,
} from '../signal-actor-registry';

describe('signal-actor-registry', () => {
  it('registers the EI-7347 seed signal set with no duplicate ids', () => {
    const ids = listSignals().map((e) => e.id);
    expect(new Set(ids).size, 'no duplicate signal ids').toBe(ids.length);
    expect(ids.sort()).toEqual(
      // degradation-watchdog: degradation-signals-on-condition-rail-2026-10-11 P-003 (R-8).
      ['coord-conditions', 'degradation-watchdog', 'hive-watchdog-fires', 'liveness-alarm', 'scorecards-freshness'].sort(),
    );
  });

  it('the degradation watchdog is actor-backed by the condition bridge, never a waiver (R-8)', () => {
    const entry = getSignal('degradation-watchdog');
    expect(entry?.actingConsumer).toBe('system:condition-bridge');
    expect(entry?.waiver).toBeUndefined();
  });

  it('every registered signal is currently COVERED (live actor, or a live waiver) — the CI floor', () => {
    const uncovered = uncoveredSignals();
    expect(
      uncovered.map((e) => e.id),
      'a signal with neither an actingConsumer nor a live waiver means it is decorative — the ' +
        'exact WI-2374 trap this registry exists to catch. Add an actingConsumer, or a waiver with ' +
        'a future expiresAt + a tracked followUp.',
    ).toEqual([]);
  });

  it('every actor-backed signal names a concrete consumer (non-empty, not a placeholder)', () => {
    for (const e of listSignals()) {
      if (!e.actingConsumer) continue;
      expect(e.actingConsumer.trim().length, `${e.id}: actingConsumer must be a real description`).toBeGreaterThan(10);
    }
  });

  it('every waiver names a follow-up and an acceptor, and its expiry is a valid future-at-write-time date', () => {
    for (const e of listSignals()) {
      if (!e.waiver) continue;
      expect(e.waiver.acceptedBy, `${e.id}: waiver needs acceptedBy`).toBeTruthy();
      expect(e.waiver.followUp, `${e.id}: waiver needs a tracked followUp ref`).toBeTruthy();
      expect(Number.isNaN(new Date(e.waiver.expiresAt).getTime()), `${e.id}: waiver.expiresAt must parse as a date`).toBe(false);
    }
  });

  it('the coord-conditions gap is CLOSED (WI-2965): condition-staleness-alarm.ts is the acting consumer, no waiver needed', () => {
    const cc = getSignal('coord-conditions');
    expect(cc, 'coord-conditions must stay registered').toBeTruthy();
    expect(cc!.actingConsumer, 'coord-conditions now has a periodic actor (condition-staleness-alarm.ts)').toBeTruthy();
    expect(cc!.waiver, 'the waiver was dropped once the actor landed — WI-2965 is closed, not just extended').toBeUndefined();
  });

  it('isSignalCovered: actingConsumer wins even with no waiver', () => {
    const e: SignalActorEntry = { id: 'x', description: 'd', source: 's', actingConsumer: 'something acts' };
    expect(isSignalCovered(e)).toBe(true);
  });

  it('isSignalCovered: a live (unexpired) waiver covers with no actingConsumer', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const e: SignalActorEntry = {
      id: 'x',
      description: 'd',
      source: 's',
      waiver: { reason: 'r', expiresAt: future, acceptedBy: 'someone', followUp: 'WI-0' },
    };
    expect(isSignalCovered(e)).toBe(true);
  });

  it('isSignalCovered: an EXPIRED waiver does not cover', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const e: SignalActorEntry = {
      id: 'x',
      description: 'd',
      source: 's',
      waiver: { reason: 'r', expiresAt: past, acceptedBy: 'someone', followUp: 'WI-0' },
    };
    expect(isSignalCovered(e)).toBe(false);
    expect(uncoveredSignals(Date.now())).not.toContain(e); // (not registered — sanity: fn operates on the real registry)
  });

  it('isSignalCovered: neither actor nor waiver does not cover', () => {
    const e: SignalActorEntry = { id: 'x', description: 'd', source: 's' };
    expect(isSignalCovered(e)).toBe(false);
  });

  it('defineSignal rejects a duplicate id', () => {
    expect(() => defineSignal({ id: 'liveness-alarm', description: 'dup', source: 's' })).toThrow(/duplicate signal id/);
  });
});
