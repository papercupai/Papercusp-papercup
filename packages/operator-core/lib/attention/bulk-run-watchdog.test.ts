/**
 * P-002 — the bulk-run watchdog's rule and its sweep, tested against fakes.
 *
 * The two failures this guards are opposite in direction and both expensive:
 *
 *  - a FALSE strand abandons a resolver that was merely slow, and
 *  - a MISSED strand is the original defect (a dead resolver's items sit on
 *    `pending` forever, indistinguishable from work not yet reached).
 *
 * So every liveness state is asserted, not just the stale one, and the sweep is
 * asserted to record a strand ONLY when the guarded write actually took effect.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RunLiveness } from './bulk-run-store';
import { observeFallback } from '../degradation/fallback-observations';
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));
import {
  decideWatchdogVerdict,
  diffCounters,
  resolverKeepsRunAlive,
  runBulkRunWatchdog,
  strandReasonText,
  WATCHDOG_RESOLVER_MAX_SILENCE_MS,
  WATCHDOG_STALE_AFTER_MS,
  type BulkRunCounters,
  type WatchdogRunFacts,
} from './bulk-run-watchdog';

const ZERO: BulkRunCounters = { autoResolved: 0, recommended: 0, skipped: 0, failed: 0 };

function facts(over: Partial<WatchdogRunFacts> = {}): WatchdogRunFacts {
  return {
    runId: 'bulk-1',
    phase: 'running',
    liveness: { state: 'stale', ageMs: 900_000, measuredFrom: 'heartbeat' },
    undecided: 3,
    stored: { ...ZERO },
    derived: { ...ZERO },
    ...over,
  };
}

describe('decideWatchdogVerdict', () => {
  it('strands a stale executing run that still has undecided items', () => {
    const v = decideWatchdogVerdict(facts());
    expect(v.strand).toEqual({
      reason: 'stale-executing',
      undecided: 3,
      ageMs: 900_000,
      measuredFrom: 'heartbeat',
    });
  });

  it.each<[string, RunLiveness]>([
    ['live', { state: 'live', ageMs: 1_000, measuredFrom: 'heartbeat' }],
    ['not-executing (review)', { state: 'not-executing', phase: 'review' }],
    ['not-executing (complete)', { state: 'not-executing', phase: 'complete' }],
  ])('never strands a %s run — the false-strand direction', (_label, liveness) => {
    expect(decideWatchdogVerdict(facts({ liveness })).strand).toBeNull();
  });

  it('does NOT strand a stale run with nothing undecided — that is the settle path', () => {
    // Failing it here would relabel a run that finished its work as a failure,
    // and `deriveSettleOutcome` already owns the never-ran-vs-nothing-to-do rule.
    expect(decideWatchdogVerdict(facts({ undecided: 0 })).strand).toBeNull();
  });

  it('reports counter drift INDEPENDENTLY of phase — including on terminal runs', () => {
    // The measured motivating case (bulk-7d35ee41) is a run that already reached a
    // terminal phase carrying counters no write could have produced. Checking only
    // active runs would miss exactly the population where the drift is permanent.
    const v = decideWatchdogVerdict(
      facts({
        phase: 'complete',
        liveness: { state: 'not-executing', phase: 'complete' },
        stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
        derived: { ...ZERO },
      }),
    );
    expect(v.strand).toBeNull();
    expect(v.counterDrift).toEqual({
      stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
      derived: ZERO,
      fields: ['autoResolved', 'recommended'],
    });
  });

  it('reports no drift when the stored counters already match their rows', () => {
    const matched = { autoResolved: 2, recommended: 1, skipped: 0, failed: 0 };
    expect(diffCounters(matched, { ...matched })).toBeNull();
    expect(decideWatchdogVerdict(facts({ stored: matched, derived: { ...matched } })).counterDrift)
      .toBeNull();
  });

  it('a run can need BOTH a strand and a reconcile', () => {
    const v = decideWatchdogVerdict(
      facts({ stored: { ...ZERO, recommended: 4 }, derived: { ...ZERO } }),
    );
    expect(v.strand).not.toBeNull();
    expect(v.counterDrift).not.toBeNull();
  });
});

describe('strandReasonText', () => {
  it('distinguishes a resolver that never beat from one that stopped beating', () => {
    const never = strandReasonText({
      reason: 'stale-executing',
      undecided: 2,
      ageMs: 600_000,
      measuredFrom: 'start',
    });
    expect(never).toContain('never reported a heartbeat after launch');

    const stopped = strandReasonText({
      reason: 'stale-executing',
      undecided: 2,
      ageMs: 600_000,
      measuredFrom: 'heartbeat',
    });
    expect(stopped).toContain('stopped reporting');
    // Both must say how to recover; a terminal state with no next step is why an
    // owner would otherwise re-launch a whole new run and lose the decided items.
    for (const text of [never, stopped]) expect(text).toContain('restart the run');
  });
});

describe('runBulkRunWatchdog', () => {
  function deps(rows: WatchdogRunFacts[], over: Partial<Parameters<typeof runBulkRunWatchdog>[0]> = {}) {
    return {
      listRuns: vi.fn(async () => rows),
      strandRun: vi.fn(async () => ({ marked: 2 })),
      reconcileCounters: vi.fn(async () => {}),
      note: vi.fn(),
      ...over,
    };
  }

  it('strands, then reconciles — in that order, so the recompute sees the new rows', async () => {
    const order: string[] = [];
    const d = deps([facts()], {
      strandRun: vi.fn(async () => {
        order.push('strand');
        return { marked: 2 };
      }),
      reconcileCounters: vi.fn(async () => {
        order.push('reconcile');
      }),
    });
    const result = await runBulkRunWatchdog(d);
    expect(order).toEqual(['strand', 'reconcile']);
    expect(result.stranded).toEqual(['bulk-1']);
    expect(result.itemsMarked).toBe(2);
  });

  it('does NOT report a strand when the guarded write refused (marked: 0)', async () => {
    // `marked: 0` means the resolver heartbeated between the decision and the
    // write, so it won the race. Recording it as stranded would be a false
    // positive in the one direction that actually costs work.
    const d = deps([facts()], { strandRun: vi.fn(async () => ({ marked: 0 })) });
    const result = await runBulkRunWatchdog(d);
    expect(result.stranded).toEqual([]);
    expect(result.itemsMarked).toBe(0);
  });

  it('reconciles a drifted run that needs no strand', async () => {
    const d = deps([
      facts({
        liveness: { state: 'not-executing', phase: 'complete' },
        undecided: 0,
        stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
        derived: { ...ZERO },
      }),
    ]);
    const result = await runBulkRunWatchdog(d);
    expect(d.strandRun).not.toHaveBeenCalled();
    expect(result.countersReconciled).toEqual(['bulk-1']);
  });

  it('touches nothing when every run is healthy and consistent', async () => {
    const d = deps([facts({ liveness: { state: 'live', ageMs: 10, measuredFrom: 'heartbeat' } })]);
    const result = await runBulkRunWatchdog(d);
    expect(d.strandRun).not.toHaveBeenCalled();
    expect(d.reconcileCounters).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 1, stranded: [], countersReconciled: [] });
  });

  it('one run failing must not abort the sweep — the rest are why it exists', async () => {
    const d = deps([facts({ runId: 'bad' }), facts({ runId: 'good' })], {
      strandRun: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === 'bad') throw new Error('deadlock');
        return { marked: 1 };
      }),
    });
    const result = await runBulkRunWatchdog(d);
    expect(result.examined).toBe(2);
    expect(result.stranded).toEqual(['good']);
    expect(result.errors).toEqual([{ runId: 'bad', error: 'deadlock' }]);
  });

  it('records one tick for empty, healthy, healed, raced and failed sweeps', async () => {
    const observe = vi.fn();
    await runBulkRunWatchdog(deps([], { observe }));
    await runBulkRunWatchdog(deps([facts({ liveness: { state: 'live', ageMs: 1, measuredFrom: 'heartbeat' } })], { observe }));
    await runBulkRunWatchdog(deps([facts()], { observe }));
    await runBulkRunWatchdog(deps([facts()], { observe, strandRun: vi.fn(async () => ({ marked: 0 })) }));
    await runBulkRunWatchdog(deps([facts({ liveness: { state: 'not-executing', phase: 'complete' },
      stored: { ...ZERO, failed: 1 } })], { observe }));
    await runBulkRunWatchdog(deps([facts()], { observe, strandRun: vi.fn(async () => { throw new Error('write failed'); }) }));
    await expect(runBulkRunWatchdog(deps([], { observe,
      listRuns: vi.fn(async () => { throw new Error('read failed'); }) }))).rejects.toThrow('read failed');
    expect(observe.mock.calls.map(([row]) => row)).toEqual([
      { eligible: 1, applied: 1, reason: 'healthy', scope: 'sweep' },
      { eligible: 1, applied: 1, reason: 'healthy', scope: 'sweep' },
      { eligible: 1, applied: 0, reason: 'heal-strand', scope: 'sweep' },
      { eligible: 1, applied: 1, reason: 'healthy', scope: 'sweep' },
      { eligible: 1, applied: 0, reason: 'heal-counters', scope: 'sweep' },
      { eligible: 1, applied: 0, reason: 'effect-failed', scope: 'sweep' },
      { eligible: 1, applied: 0, reason: 'census-failed', scope: 'sweep' },
    ]);
    vi.mocked(observeFallback).mockClear();
    await runBulkRunWatchdog(deps([]));
    expect(observeFallback).toHaveBeenCalledExactlyOnceWith('bulk-run-watchdog',
      { eligible: 1, applied: 1, reason: 'healthy', scope: 'sweep' });
  });
});

/**
 * WI-10004887 — the heartbeat is one witness, not the only one. Both measured
 * false strands on 2026-10-01 had a resolver making tool calls every few
 * seconds through the strand: bulk-8df81e9e (classifying 200 items with non-run
 * tools, 12:49–12:55Z, failed 10s before its first report) and bulk-948a3af3
 * (polling coord:inbox every ~45s for a peer's reply, failed at 13:53:28Z).
 */
describe('resolver activity as evidence of life (WI-10004887)', () => {
  const NOW = Date.parse('2026-10-01T12:55:34Z');
  const busy = { ownerId: 'su-4d659446', lastActivityMs: NOW - 20_000 };

  it('pins its thresholds to the store constants', async () => {
    const storeConsts = await vi.importActual<typeof import('./bulk-run-store')>('./bulk-run-store');
    expect(WATCHDOG_STALE_AFTER_MS).toBe(storeConsts.RUN_HEARTBEAT_STALE_MS);
    expect(WATCHDOG_RESOLVER_MAX_SILENCE_MS).toBe(storeConsts.RESOLVER_ACTIVITY_MAX_SILENCE_MS);
  });

  it('defers a heartbeat-stale run whose resolver is still calling tools (the bulk-8df81e9e shape)', () => {
    const v = decideWatchdogVerdict(
      facts({ liveness: { state: 'stale', ageMs: 494_000, measuredFrom: 'heartbeat' }, undecided: 200, resolver: busy }),
      NOW,
    );
    expect(v.strand).toBeNull();
    expect(v.deferred).toEqual({
      reason: 'resolver-active',
      ownerId: 'su-4d659446',
      activityAgeMs: 20_000,
      heartbeatAgeMs: 494_000,
    });
  });

  it('still strands when the resolver has been quiet as long as the heartbeat threshold', () => {
    const v = decideWatchdogVerdict(
      facts({ resolver: { ownerId: 'su-x', lastActivityMs: NOW - WATCHDOG_STALE_AFTER_MS - 1 } }),
      NOW,
    );
    expect(v.deferred).toBeNull();
    expect(v.strand?.reason).toBe('stale-executing');
  });

  it('still strands a resolver that never acted at all (the walled-launch shape)', () => {
    const v = decideWatchdogVerdict(
      facts({
        liveness: { state: 'stale', ageMs: 540_000, measuredFrom: 'start' },
        resolver: { ownerId: 'su-f5350064', lastActivityMs: null },
      }),
      NOW,
    );
    expect(v.strand?.measuredFrom).toBe('start');
    expect(v.deferred).toBeNull();
  });

  it('stops rescuing once the run itself has been silent past the ceiling, however busy the resolver', () => {
    const v = decideWatchdogVerdict(
      facts({
        liveness: { state: 'stale', ageMs: WATCHDOG_RESOLVER_MAX_SILENCE_MS + 1, measuredFrom: 'heartbeat' },
        resolver: busy,
      }),
      NOW,
    );
    expect(v.deferred).toBeNull();
    expect(v.strand).not.toBeNull();
  });

  it('never lets resolver evidence touch a run that is live or not executing', () => {
    expect(
      decideWatchdogVerdict(facts({ liveness: { state: 'live', ageMs: 1_000, measuredFrom: 'heartbeat' }, resolver: busy }), NOW),
    ).toMatchObject({ strand: null, deferred: null });
    expect(
      decideWatchdogVerdict(facts({ liveness: { state: 'not-executing', phase: 'review' }, resolver: busy }), NOW),
    ).toMatchObject({ strand: null, deferred: null });
  });

  it('resolverKeepsRunAlive treats a future activity stamp (clock skew) as just now', () => {
    expect(
      resolverKeepsRunAlive({
        liveness: { state: 'stale', ageMs: 400_000, measuredFrom: 'heartbeat' },
        resolver: { ownerId: 'su-y', lastActivityMs: NOW + 5_000 },
        nowMs: NOW,
      }),
    ).toEqual({ ownerId: 'su-y', activityAgeMs: 0, heartbeatAgeMs: 400_000 });
  });

  it('the sweep reports a deferral, never calls strandRun for it, and still reconciles drift', async () => {
    const strandRun = vi.fn(async () => ({ marked: 3 }));
    const reconcileCounters = vi.fn(async () => {});
    const note = vi.fn();
    const result = await runBulkRunWatchdog({
      listRuns: async () => [
        facts({ runId: 'busy', resolver: busy, stored: { ...ZERO, failed: 1 } }),
        facts({ runId: 'dead', resolver: { ownerId: 'su-gone', lastActivityMs: null } }),
      ],
      strandRun,
      reconcileCounters,
      note,
      nowMs: () => NOW,
    });
    expect(result.deferred).toEqual(['busy']);
    expect(result.stranded).toEqual(['dead']);
    expect(strandRun).toHaveBeenCalledTimes(1);
    expect(strandRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'dead' }));
    expect(result.countersReconciled).toEqual(['busy', 'dead']);
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/^deferred busy: no run heartbeat for 900s, but resolver su-4d659446 was active 20s ago$/));
  });
});
