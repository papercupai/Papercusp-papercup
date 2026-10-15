/**
 * red-inflow-repair-first.test.ts — the pure half of red-gate inflow control
 * (green-main-cycle-time-2026-10-08 P-017, design D-032 / D-033).
 *
 * The claim behaviour itself (who moves, onto what, before what) is proven against real
 * Postgres in scheduler/red-inflow-repair-first.integration.test.ts. This file pins the
 * pieces that test cannot see:
 *   - the member-share hash is stable across hosts (fixed FNV-1a vectors) and actually
 *     splits a fleet roughly in half;
 *   - the repair-item prefix set matches its PRODUCERS, so a renamed condition key fails
 *     here instead of silently emptying the repair set;
 *   - the behaviour sits behind a registered, default-ON flag;
 *   - the stamp a moved member reads says why.
 */
import { describe, expect, it } from 'vitest';
import { FLAG_DEFAULTS, FLAGS, DARK_FLAGS } from '@papercusp/flags';
import {
  GATE_RED_STREAK_CONDITION_PREFIX,
  RED_INFLOW_REPAIR_CONDITION_PREFIXES,
  RED_INFLOW_REPAIR_FIRST_HOURS,
  RED_INFLOW_REPAIR_SHARE_PCT,
  STOP_THE_LINE_RED_HOURS,
  SYNC_DELTA_RED_CONDITION_PREFIX,
  redInflowMemberSelected,
  redInflowShareBucket,
  redInflowStamp,
} from './work-items-admission';
import {
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
  FROZEN_REPAIR_LEG_CONDITION_PREFIX,
} from './coord/actionable-conditions';
import { conditionKeyForRed } from './release/sync-batch-delta-check';

const HOUR_MS = 3_600_000;

describe('P-017 red-inflow share selection', () => {
  it('buckets by 32-bit FNV-1a mod 100, so every host picks the same members', () => {
    // Standard FNV-1a test vectors: '' -> 0x811c9dc5, 'a' -> 0xe40c292c.
    expect(redInflowShareBucket('')).toBe(0x811c9dc5 % 100);
    expect(redInflowShareBucket('a')).toBe(0xe40c292c % 100);
    const id = 'su-cb24e308-bc28-44ac-821f-84573580ab82';
    expect(redInflowShareBucket(id)).toBe(redInflowShareBucket(id));
  });

  it('keeps every bucket in 0..99', () => {
    for (let i = 0; i < 500; i += 1) {
      const b = redInflowShareBucket(`su-${i}-${'x'.repeat(i % 37)}`);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('moves roughly half of a fleet at the default share', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `su-${i.toString(16).padStart(8, '0')}-member`);
    const moved = ids.filter((id) => redInflowMemberSelected(id)).length / ids.length;
    expect(RED_INFLOW_REPAIR_SHARE_PCT).toBe(50);
    expect(moved).toBeGreaterThan(0.4);
    expect(moved).toBeLessThan(0.6);
  });

  it('honours the share bounds and never selects an anonymous caller', () => {
    expect(redInflowMemberSelected('')).toBe(false);
    const ids = Array.from({ length: 200 }, (_, i) => `member-${i}`);
    expect(ids.some((id) => redInflowMemberSelected(id, 0))).toBe(false);
    expect(ids.every((id) => redInflowMemberSelected(id, 100))).toBe(true);
    for (const id of ids) {
      expect(redInflowMemberSelected(id)).toBe(redInflowShareBucket(id) < RED_INFLOW_REPAIR_SHARE_PCT);
    }
  });
});

describe('P-017 repair-item set', () => {
  it('matches the per-sync red producer key', () => {
    expect(conditionKeyForRed('packages/x/y.test.ts').startsWith(SYNC_DELTA_RED_CONDITION_PREFIX)).toBe(true);
    expect(RED_INFLOW_REPAIR_CONDITION_PREFIXES).toContain(SYNC_DELTA_RED_CONDITION_PREFIX);
  });

  it('includes the per-failing-leg items', () => {
    expect(RED_INFLOW_REPAIR_CONDITION_PREFIXES).toContain(FROZEN_REPAIR_LEG_CONDITION_PREFIX);
  });

  it('excludes the long-lived-owner items (D-028)', () => {
    for (const reserved of [FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX, GATE_RED_STREAK_CONDITION_PREFIX, 'green-stall:']) {
      expect(RED_INFLOW_REPAIR_CONDITION_PREFIXES.some((p) => reserved.startsWith(p) || p.startsWith(reserved))).toBe(false);
    }
  });

  it('is the earlier, gentler rung below stop-the-line', () => {
    expect(RED_INFLOW_REPAIR_FIRST_HOURS).toBe(8);
    expect(RED_INFLOW_REPAIR_FIRST_HOURS).toBeLessThan(STOP_THE_LINE_RED_HOURS);
  });
});

describe('P-017 flag', () => {
  it('is registered and defaults ON (not dark)', () => {
    expect(FLAGS.RED_INFLOW_REPAIR_FIRST).toBe('papercusp-red-inflow-repair-first');
    expect(DARK_FLAGS.has(FLAGS.RED_INFLOW_REPAIR_FIRST)).toBe(false);
    expect(FLAG_DEFAULTS[FLAGS.RED_INFLOW_REPAIR_FIRST]).toBe(true);
  });
});

describe('P-017 redInflow stamp', () => {
  const now = 1_800_000_000_000;

  it('reports the red age, threshold and share when a repair item was served', () => {
    const stamp = redInflowStamp(true, now - 9 * HOUR_MS, now);
    expect(stamp).toMatchObject({
      applied: true,
      redSinceHours: 9,
      thresholdHours: RED_INFLOW_REPAIR_FIRST_HOURS,
      sharePct: RED_INFLOW_REPAIR_SHARE_PCT,
    });
    expect(stamp.reason).toContain('red 9h');
    expect(stamp.reason).toContain('before new backlog');
  });

  it('says backlog was served when no repair item was claimable', () => {
    const stamp = redInflowStamp(false, now - 12.34 * HOUR_MS, now);
    expect(stamp.applied).toBe(false);
    expect(stamp.redSinceHours).toBe(12.3);
    expect(stamp.reason).toContain('no repair item');
    expect(stamp.reason).toContain('backlog was served');
  });
});
