/**
 * fleet-brief-delta.test — P-022 / D-011, the wake-to-wake delta.
 *
 * The two properties under test are the ones the plan itself is about, so they are tested
 * with controls rather than only with happy paths:
 *
 *  1. `delta: null` (unknown) and `delta: 0` (measured, nothing moved) must never collapse
 *     into each other. The zero case is the CONTROL — without it, a module that returned
 *     null for everything would pass every "does not fake a zero" assertion.
 *  2. Reading the brief twice inside one wake must not zero the delta.
 */

import { describe, it, expect } from 'vitest';
import {
  rotateBriefSnapshot,
  differenceAxis,
  computeFleetBriefDelta,
  describeFleetBriefDelta,
  type FleetBriefObservation,
  type FleetBriefSnapshotRow,
} from './fleet-brief-delta';

const obs = (over: Partial<FleetBriefObservation> = {}): FleetBriefObservation => ({
  at: '2026-08-09T20:00:00.000Z',
  rosterSize: 11,
  countedMembers: 9,
  specRevision: 7,
  poolFactor: 0.66,
  ...over,
});

const row = (over: Partial<FleetBriefSnapshotRow> = {}): FleetBriefSnapshotRow => ({
  fireCount: 50,
  baseline: null,
  observation: obs(),
  ...over,
});

describe('rotateBriefSnapshot', () => {
  it('a first sighting has no baseline and rotates', () => {
    const r = rotateBriefSnapshot(null, obs(), 51);
    expect(r.baseline).toBeNull();
    expect(r.boundary).toBe('first');
    expect(r.rotated).toBe(true);
    expect(r.next.fireCount).toBe(51);
  });

  it('a NEW wake takes the previous wake observation as its baseline', () => {
    const prev = obs({ at: '2026-08-09T19:00:00.000Z', rosterSize: 9 });
    const r = rotateBriefSnapshot(row({ fireCount: 50, observation: prev }), obs(), 51);
    expect(r.baseline).toEqual(prev);
    expect(r.boundary).toBe('wake');
    expect(r.rotated).toBe(true);
    expect(r.next.baseline).toEqual(prev);
  });

  // The anti-blinding property. A second read inside one wake must not consume the baseline.
  it('a re-read INSIDE the same wake reuses the baseline and does NOT rewrite', () => {
    const baseline = obs({ at: '2026-08-09T19:00:00.000Z', rosterSize: 9 });
    const stored = row({ fireCount: 51, baseline, observation: obs() });
    const r = rotateBriefSnapshot(stored, obs({ rosterSize: 12 }), 51);
    expect(r.rotated).toBe(false);
    expect(r.baseline).toEqual(baseline);
    expect(r.next).toBe(stored);
  });

  it('two reads in one wake produce the SAME delta rather than a zeroed second one', () => {
    const baseline = obs({ at: '2026-08-09T19:00:00.000Z', rosterSize: 9 });
    let stored: FleetBriefSnapshotRow | null = row({ fireCount: 50, observation: baseline });

    const first = rotateBriefSnapshot(stored, obs({ rosterSize: 11 }), 51);
    stored = first.next;
    const second = rotateBriefSnapshot(stored, obs({ rosterSize: 11 }), 51);

    const d1 = differenceAxis(first.baseline?.rosterSize, 11, first.baseline !== null);
    const d2 = differenceAxis(second.baseline?.rosterSize, 11, second.baseline !== null);
    expect(d1.delta).toBe(2);
    expect(d2.delta).toBe(2);
    expect(d2).toEqual(d1);
  });

  it('with no armed loop the boundary is a READ, not a wake, and rotates every time', () => {
    const prev = obs({ at: '2026-08-09T19:00:00.000Z' });
    const r = rotateBriefSnapshot(row({ fireCount: null, observation: prev }), obs(), null);
    expect(r.boundary).toBe('read');
    expect(r.rotated).toBe(true);
    expect(r.baseline).toEqual(prev);
  });

  it('a fireCount that moved BACKWARD (a re-armed loop) is a new boundary, not a re-read', () => {
    const prev = obs({ at: '2026-08-09T19:00:00.000Z' });
    const r = rotateBriefSnapshot(row({ fireCount: 50, observation: prev }), obs(), 1);
    expect(r.rotated).toBe(true);
    expect(r.baseline).toEqual(prev);
  });

  it('a same-wake re-read that never had a baseline still reports first, not wake', () => {
    const stored = row({ fireCount: 51, baseline: null });
    expect(rotateBriefSnapshot(stored, obs(), 51).boundary).toBe('first');
  });
});

describe('differenceAxis', () => {
  it('no baseline yields delta NULL, never 0', () => {
    const a = differenceAxis(undefined, 5, false);
    expect(a.delta).toBeNull();
    expect(a.available).toBe(false);
    expect(a.reason).toBe('no-baseline');
    expect(a.current).toBe(5);
  });

  // CONTROL: a genuine no-change must remain reportable as a real, available zero —
  // otherwise "never fakes a zero" would also be satisfied by never reporting one.
  it('an unchanged axis reports an AVAILABLE zero, distinguishable from unknown', () => {
    const a = differenceAxis(7, 7, true);
    expect(a.delta).toBe(0);
    expect(a.available).toBe(true);
    expect(a.reason).toBeUndefined();
  });

  it('distinguishes a previously-unobserved axis from a currently-unobservable one', () => {
    expect(differenceAxis(null, 3, true).reason).toBe('not-observed-previously');
    expect(differenceAxis(3, null, true).reason).toBe('not-observed-now');
  });

  it('differences negatives and zero-crossings correctly', () => {
    expect(differenceAxis(11, 9, true).delta).toBe(-2);
    expect(differenceAxis(0, 4, true).delta).toBe(4);
  });
});

describe('computeFleetBriefDelta', () => {
  const baseline = obs({
    at: '2026-08-09T19:00:00.000Z',
    rosterSize: 9,
    countedMembers: 9,
    specRevision: 7,
    poolFactor: 1,
  });

  it('reports every axis as unavailable on a first read — no axis fakes a zero', () => {
    const d = computeFleetBriefDelta({
      baseline: null,
      observation: obs(),
      boundary: 'first',
      churn: null,
      closes: { delta: null, isFloor: false },
    });
    expect(d.since).toBeNull();
    for (const axis of [d.members, d.closes, d.specRevision, d.poolFactor]) {
      expect(axis.delta).toBeNull();
      expect(axis.available).toBe(false);
    }
    expect(d.members.reason).toBe('no-baseline');
  });

  it('differences all four axes against a baseline', () => {
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs({ rosterSize: 11, specRevision: 8, poolFactor: 0.66 }),
      boundary: 'wake',
      churn: { joined: 3, left: 1, neverActive: 1, pending: 0 },
      closes: { delta: 12, isFloor: false },
    });
    expect(d.since).toBe('2026-08-09T19:00:00.000Z');
    expect(d.members.delta).toBe(2);
    expect(d.members.joined).toBe(3);
    expect(d.members.left).toBe(1);
    expect(d.members.neverActive).toBe(1);
    expect(d.members.bootPending).toBe(0);
    expect(d.closes.delta).toBe(12);
    expect(d.specRevision.previous).toBe(7);
    expect(d.specRevision.current).toBe(8);
    expect(d.poolFactor.delta).toBeCloseTo(-0.34);
  });

  it('keeps roster movement separate from shown-count movement', () => {
    // Two members went stale-idle: the roster is unchanged, the SHOWN count fell.
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs({ rosterSize: 9, countedMembers: 7 }),
      boundary: 'wake',
      churn: { joined: 0, left: 0, neverActive: 0, pending: 0 },
      closes: { delta: 0, isFloor: false },
    });
    expect(d.members.delta).toBe(0);
    expect(d.members.counted.delta).toBe(-2);
  });

  it('an explicit since overrides the baseline timestamp', () => {
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs(),
      boundary: 'explicit',
      churn: { joined: 0, left: 0, neverActive: 0, pending: 0 },
      closes: { delta: 4, isFloor: false },
      since: '2026-08-09T12:00:00.000Z',
    });
    expect(d.since).toBe('2026-08-09T12:00:00.000Z');
  });

  it('carries the closes FLOOR marker so a floor is never read as a total', () => {
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs(),
      boundary: 'wake',
      churn: { joined: 0, left: 0, neverActive: 0, pending: 0 },
      closes: { delta: 5, isFloor: true },
    });
    expect(d.closes.isFloor).toBe(true);
    expect(d.closes.delta).toBe(5);
  });

  it('an unreadable closes count is unavailable, not zero', () => {
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs(),
      boundary: 'wake',
      churn: { joined: 0, left: 0, neverActive: 0, pending: 0 },
      closes: { delta: null, isFloor: false },
    });
    expect(d.closes.delta).toBeNull();
    expect(d.closes.available).toBe(false);
  });
});

describe('describeFleetBriefDelta', () => {
  const baseline = obs({ at: '2026-08-09T19:00:00.000Z', rosterSize: 9, specRevision: 7, poolFactor: 1 });

  it('renders the shape P-022 asked for', () => {
    const line = describeFleetBriefDelta(
      computeFleetBriefDelta({
        baseline,
        observation: obs({ rosterSize: 11, specRevision: 8, poolFactor: 0.66 }),
        boundary: 'wake',
        churn: { joined: 2, left: 0, neverActive: 0, pending: 0 },
        closes: { delta: 12, isFloor: false },
      }),
    );
    expect(line).toContain('members +2');
    expect(line).toContain('closes +12');
    expect(line).toContain('spec rev 7→8');
    expect(line).toContain('pool factor 1→0.66');
  });

  it('surfaces churn the net difference cannot show', () => {
    // Three joined and three left: net 0, but six real membership events.
    const line = describeFleetBriefDelta(
      computeFleetBriefDelta({
        baseline,
        observation: obs({ rosterSize: 9 }),
        boundary: 'wake',
        churn: { joined: 3, left: 3, neverActive: 0, pending: 0 },
        closes: { delta: 0, isFloor: false },
      }),
    );
    expect(line).toContain('members 0 (3 joined / 3 left)');
  });

  // EI-27031443048618869: psu records the join before boot, so a refused launch is a join.
  it('names dead launches even when the net difference already accounts for every join', () => {
    // +5 net, 5 joined, 0 left: the old rule printed no breakdown, hiding that 4 never booted.
    const line = describeFleetBriefDelta(
      computeFleetBriefDelta({
        baseline,
        observation: obs({ rosterSize: 14 }),
        boundary: 'wake',
        churn: { joined: 5, left: 0, neverActive: 4, pending: 0 },
        closes: { delta: 0, isFloor: false },
      }),
    );
    expect(line).toContain('members +5 (5 joined, 4 never made a call / 0 left)');
  });

  it('an unmeasured activation split prints no dead-launch claim', () => {
    const d = computeFleetBriefDelta({
      baseline,
      observation: obs({ rosterSize: 9 }),
      boundary: 'wake',
      churn: { joined: 3, left: 3, neverActive: null, pending: null },
      closes: { delta: 0, isFloor: false },
    });
    expect(d.members.neverActive).toBeNull();
    const line = describeFleetBriefDelta(d);
    expect(line).toContain('members 0 (3 joined / 3 left)');
    expect(line).not.toContain('never made a call');
  });

  it('says an axis is unknown rather than dropping it', () => {
    const line = describeFleetBriefDelta(
      computeFleetBriefDelta({
        baseline: null,
        observation: obs(),
        boundary: 'first',
        churn: null,
        closes: { delta: null, isFloor: false },
      }),
    );
    expect(line).toContain('no prior boundary');
    for (const axis of ['members', 'closes', 'spec rev', 'pool factor']) {
      expect(line).toContain(`${axis} ? (no baseline)`);
    }
  });

  it('marks a floor count as a floor', () => {
    const line = describeFleetBriefDelta(
      computeFleetBriefDelta({
        baseline,
        observation: obs(),
        boundary: 'wake',
        churn: { joined: 0, left: 0, neverActive: 0, pending: 0 },
        closes: { delta: 5, isFloor: true },
      }),
    );
    expect(line).toContain('closes +5 (floor)');
  });
});
