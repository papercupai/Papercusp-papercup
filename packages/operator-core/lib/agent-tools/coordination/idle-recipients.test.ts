/**
 * idle-recipients.test.ts — coord:send no-wake idle-recipient REPORTING
 * (coord-dispatch-reliability-2026-06-21 P-001).
 *
 * Two layers, mirroring recipient-resolve.test.ts:
 *  1. PURE core — `classifyRecipientLiveness` (no I/O, exhaustive disposition).
 *  2. Host probe — `reportIdleRecipients`, with `listPresence` (the roster) and
 *     `listActiveAwaitsForKey` (the NON-FIRING watcher probe) mocked. The
 *     await-event ENGINE (emitAwaitedEvent) is mocked too, ASSERTED never called
 *     — the whole point of the default path is report-only, never a wake
 *     (invariant a).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./presence', () => ({ listPresence: vi.fn() }));
vi.mock('../../events/await/store', () => ({ listActiveAwaitsForKey: vi.fn() }));
// The probe must NEVER wake — mock the engine so a stray emit would be a loud,
// asserted failure rather than a live PG hit.
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
// WI-5994: the loop-schedule signal the idle→dormant-scheduled reclassification
// consults. Default: no loop for anyone (every idle candidate stays plain idle,
// preserving pre-WI-5994 behavior) unless a test opts a recipient in.
vi.mock('../../harness/routines/loop', () => ({ getLoopStatuses: vi.fn().mockResolvedValue(new Map()) }));
// EI-19937974676482462: the shared liveness-oracle cross-check the remaining
// idle→aliveNotWakeable reclassification consults (dynamically imported inside
// reportIdleRecipients — see its own header comment on why it must be lazy).
// Default: no verdict for anyone (every idle candidate stays plain idle,
// preserving pre-fix behavior) unless a test opts a recipient in.
vi.mock('./liveness-oracle', () => ({ resolveSessionStates: vi.fn().mockResolvedValue(new Map()) }));

import {
  classifyRecipientLiveness,
  classifyDormantSchedule,
  reportIdleRecipients,
  inboxWakeKey,
} from './inbox-wake';
import { listPresence } from './presence';
import { listActiveAwaitsForKey } from '../../events/await/store';
import { emitAwaitedEvent } from '../../events/await/engine';
import { getLoopStatuses } from '../../harness/routines/loop';
import type { LoopStatus } from '../../harness/routines/loop';
import { resolveSessionStates } from './liveness-oracle';
import type { LivenessVerdict } from './liveness-oracle';

/** A minimal LoopStatus fixture — only the fields classifyDormantSchedule reads matter. */
function loopStatus(overrides: Partial<LoopStatus> = {}): LoopStatus {
  return {
    name: 'test-loop',
    ownerId: 'su-x',
    harnessSlug: 'papercusp',
    active: true,
    intervalSec: 60,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    monitor: null,
    monitorStanddown: null,
    standdown: null,
    goal: null,
    fireCount: 1,
    firesSinceArm: 1,
    expectedFiresSinceArm: null,
    effectiveIntervalSec: null,
    cadenceRatio: null,
    longestObservedGapSec: null,
    cadenceDrift: false,
    parked: false,
    nextFireAt: null,
    lastFiredAt: null,
    armedAt: null,
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    fireStarved: false,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: null,
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    lastWakeAt: null,
    lastWakeError: null,
    lastTurnAt: null,
    lastRealTurnAt: null,
    turnsStalled: false,
    parkedForSec: null,
    lifecycleBackoff: null,
    ...overrides,
  };
}

const presence = (...ownerIds: string[]) => ownerIds.map((ownerId) => ({ ownerId })) as never;
/** One fake active watcher row — only the array LENGTH matters to the probe. */
const watchers = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i })) as never;

describe('classifyRecipientLiveness (pure core)', () => {
  it('flags a local recipient with ZERO active watchers as idle', () => {
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 0 }),
    ).toBe('idle');
  });

  it('does NOT flag a local recipient that HAS an active watcher (live)', () => {
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 1 }),
    ).toBe('live');
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 3 }),
    ).toBe('live');
  });

  it('does NOT flag a recipient outside the local roster (federated/unknown) as idle', () => {
    // A federated recipient has zero LOCAL watchers but is NOT idle — its watchers
    // live on its home instance (invariant c).
    expect(
      classifyRecipientLiveness({ ownerId: 'su-remote', inRoster: false, activeWatchers: 0 }),
    ).toBe('unknown');
  });
});

describe('reportIdleRecipients (host probe — report-only, fail-soft)', () => {
  beforeEach(() => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-bee-1', 'su-bee-2'));
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
  });
  afterEach(() => vi.clearAllMocks());
  beforeEach(() => {
    vi.mocked(getLoopStatuses).mockResolvedValue(new Map());
  });

  it('NEVER fires a wake — report-only (invariant a)', async () => {
    await reportIdleRecipients(['su-bee-1'], {});
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('flags a local recipient with no active watcher as idle', async () => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.idle).toEqual(['su-bee-1']);
    expect(r.live).toEqual([]);
    expect(r.degraded).toBe(false);
    // probed the EXACT inbox-wake key (the rendezvous), not a wildcard.
    expect(vi.mocked(listActiveAwaitsForKey).mock.calls[0][0]).toBe(inboxWakeKey('su-bee-1'));
  });

  it('does NOT flag a local recipient with an active watcher', async () => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(2));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.idle).toEqual([]);
    expect(r.live).toEqual(['su-bee-1']);
  });

  it('does NOT flag a federated/unknown recipient (not in the local roster)', async () => {
    // su-remote is not in the roster → unknown, never idle. We must not even
    // probe its watchers (they aren't ours).
    const r = await reportIdleRecipients(['su-remote'], {});
    expect(r.idle).toEqual([]);
    expect(r.unknown).toEqual(['su-remote']);
    expect(listActiveAwaitsForKey).not.toHaveBeenCalled();
  });

  it('skips non-wakeable targets ("*"/"human"/empty) and audience selectors (invariant b)', async () => {
    const r = await reportIdleRecipients(['*', 'human', '', '@plan:x', '@role:bee'], {});
    expect(r).toMatchObject({ idle: [], live: [], dormantScheduled: [], unknown: [], degraded: false, aliveNotWakeable: [] });
    expect(listActiveAwaitsForKey).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('classifies a MIXED send: idle + live + federated, skipping selectors', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-idle', 'su-live'));
    vi.mocked(listActiveAwaitsForKey).mockImplementation((async (key: string) =>
      key === inboxWakeKey('su-live') ? watchers(1) : watchers(0)) as never);
    const r = await reportIdleRecipients(['su-idle', 'su-live', 'su-remote', '*'], {});
    expect(r.idle).toEqual(['su-idle']);
    expect(r.live).toEqual(['su-live']);
    expect(r.unknown).toEqual(['su-remote']);
    expect(r.degraded).toBe(false);
  });

  it('probes concrete recipients concurrently and preserves recipient order', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-bee-1', 'su-bee-2'));
    let active = 0;
    let maxActive = 0;
    const release = new Map<string, (value: unknown) => void>();
    vi.mocked(listActiveAwaitsForKey).mockImplementation((async (key: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return await new Promise<unknown>((resolve) => {
        release.set(key, (value) => {
          active -= 1;
          resolve(value);
        });
      });
    }) as never);

    const pending = reportIdleRecipients(['su-bee-1', 'su-bee-2'], {});
    // Let reportIdleRecipients finish its roster read and start both independent
    // watcher probes before releasing either one.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maxActive).toBe(2);

    release.get(inboxWakeKey('su-bee-1'))?.(watchers(0));
    release.get(inboxWakeKey('su-bee-2'))?.(watchers(1));
    await expect(pending).resolves.toMatchObject({
      idle: ['su-bee-1'],
      live: ['su-bee-2'],
      degraded: false,
    });
  });

  it('DEGRADES to an empty report (send still ok) when the ROSTER read throws (invariant c)', async () => {
    // The degrade path logs a single advisory warn — expected, so spy it out (the
    // repo fails tests on un-asserted console.warn).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listPresence).mockRejectedValue(new Error('roster down'));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.degraded).toBe(true);
    expect(r.idle).toEqual([]); // never a FALSE idle on a read hiccup
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('DEGRADES to an empty report when an AWAIT-STORE read throws (invariant c)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listActiveAwaitsForKey).mockRejectedValue(new Error('await store down'));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.degraded).toBe(true);
    expect(r.idle).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns a clean empty (NOT degraded) report when there are no concrete recipients', async () => {
    const r = await reportIdleRecipients(['*', 'human'], {});
    expect(r).toEqual({ idle: [], live: [], dormantScheduled: [], unknown: [], degraded: false, aliveNotWakeable: [], confirmedDead: [] });
    expect(listPresence).not.toHaveBeenCalled();
  });
});

describe('reportIdleRecipients — EI-19937974676482462 aliveNotWakeable reclassification', () => {
  beforeEach(() => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
    vi.mocked(getLoopStatuses).mockResolvedValue(new Map());
  });
  afterEach(() => vi.clearAllMocks());

  const verdict = (sessionState: LivenessVerdict['sessionState']): LivenessVerdict => ({
    ownerId: 'su-cup-1',
    sessionState,
    wakeable: false,
    liveTurn: sessionState === 'live',
    confirmLiveness: sessionState === null ? null : sessionState === 'draining' || sessionState === 'suspect',
    heartbeatFresh: true,
  });

  it('the exact repro: zero wake-watchers but the oracle confirms `recorded` (session-log alive) → aliveNotWakeable, NOT idle/dead', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
    vi.mocked(resolveSessionStates).mockResolvedValue(new Map([['su-cup-1', verdict('recorded')]]));
    const r = await reportIdleRecipients(['su-cup-1'], {});
    expect(r.idle).toEqual([]);
    expect(r.aliveNotWakeable).toEqual(['su-cup-1']);
    expect(resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-cup-1' }],
      { hydratePerId: true, psuHostPositiveAuthority: true },
    );
  });

  it('a `live` verdict (mid-turn, EI-12699) also reclassifies out of idle', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
    vi.mocked(resolveSessionStates).mockResolvedValue(new Map([['su-cup-1', verdict('live')]]));
    const r = await reportIdleRecipients(['su-cup-1'], {});
    expect(r.idle).toEqual([]);
    expect(r.aliveNotWakeable).toEqual(['su-cup-1']);
  });

  it('a genuinely `ended` verdict stays idle (real dead, not reclassified)', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
    vi.mocked(resolveSessionStates).mockResolvedValue(new Map([['su-cup-1', verdict('ended')]]));
    const r = await reportIdleRecipients(['su-cup-1'], {});
    expect(r.idle).toEqual(['su-cup-1']);
    expect(r.aliveNotWakeable).toEqual([]);
    expect(r.confirmedDead).toEqual(['su-cup-1']);
  });

  it.each(['parked', 'draining', 'suspect', null] as const)(
    'does not confirm %s as dead even though the recipient remains idle',
    async (sessionState) => {
      vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
      const state = sessionState as LivenessVerdict['sessionState'];
      vi.mocked(resolveSessionStates).mockResolvedValue(new Map([['su-cup-1', verdict(state)]]));
      const r = await reportIdleRecipients(['su-cup-1'], {});
      expect(r.idle).toEqual(['su-cup-1']);
      expect(r.confirmedDead).toEqual([]);
    },
  );

  it('an oracle hiccup degrades to plain idle (never invents a false alive verdict)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
    vi.mocked(resolveSessionStates).mockRejectedValue(new Error('oracle down'));
    const r = await reportIdleRecipients(['su-cup-1'], {});
    expect(r.idle).toEqual(['su-cup-1']);
    expect(r.aliveNotWakeable).toEqual([]);
    expect(r.confirmedDead).toEqual([]);
    expect(r.degraded).toBe(false); // the OVERALL probe still succeeded — only the oracle enrichment degraded
    warn.mockRestore();
  });

  it('does not confirm dead when the loop-schedule probe fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listPresence).mockResolvedValue(presence('su-cup-1'));
    vi.mocked(getLoopStatuses).mockRejectedValueOnce(new Error('loop status down'));
    vi.mocked(resolveSessionStates).mockResolvedValue(new Map([['su-cup-1', verdict('ended')]]));
    const r = await reportIdleRecipients(['su-cup-1'], {});
    expect(r.idle).toEqual(['su-cup-1']);
    expect(r.confirmedDead).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('never consults the oracle when there are no idle candidates (all live watchers)', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-live'));
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(1));
    const r = await reportIdleRecipients(['su-live'], {});
    expect(r.live).toEqual(['su-live']);
    expect(resolveSessionStates).not.toHaveBeenCalled();
  });
});

describe('reportIdleRecipients — roster-absent confirmed-dead evidence', () => {
  afterEach(() => vi.clearAllMocks());

  const verdict = (sessionState: LivenessVerdict['sessionState']): LivenessVerdict => ({
    ownerId: 'su-roster-missing',
    sessionState,
    wakeable: false,
    liveTurn: false,
    confirmLiveness: sessionState === null ? null : sessionState === 'draining' || sessionState === 'suspect',
    heartbeatFresh: false,
  });

  it('keeps the roster classification unknown but exposes a measured ended session with no self-wake', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence());
    vi.mocked(resolveSessionStates).mockResolvedValue(
      new Map([['su-roster-missing', { ...verdict('ended'), selfWake: 'none' }]]),
    );

    const r = await reportIdleRecipients(['su-roster-missing'], {});

    expect(r.unknown).toEqual(['su-roster-missing']);
    expect(r.idle).toEqual([]);
    expect(r.confirmedDead).toEqual(['su-roster-missing']);
    expect(resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-roster-missing' }],
      { hydrateBatch: true, psuHostPositiveAuthority: true, selfWake: true },
    );
  });

  it.each([
    ['active loop', 'loop'],
    ['standing event', 'event'],
    ['missing self-wake measurement', undefined],
  ] as const)('does not confirm an unrostered ended session with %s', async (_label, selfWake) => {
    vi.mocked(listPresence).mockResolvedValue(presence());
    vi.mocked(resolveSessionStates).mockResolvedValue(
      new Map([['su-roster-missing', { ...verdict('ended'), ...(selfWake ? { selfWake } : {}) }]]),
    );

    const r = await reportIdleRecipients(['su-roster-missing'], {});

    expect(r.unknown).toEqual(['su-roster-missing']);
    expect(r.confirmedDead).toEqual([]);
  });

  it('does not confirm a roster-absent id when the ended verdict lacks positive liveness evidence', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence());
    vi.mocked(resolveSessionStates).mockResolvedValue(
      new Map([[
        'su-roster-missing',
        { ...verdict('ended'), selfWake: 'none', confirmLiveness: true, signalMissing: true },
      ]]),
    );

    const r = await reportIdleRecipients(['su-roster-missing'], {});

    expect(r.unknown).toEqual(['su-roster-missing']);
    expect(r.confirmedDead).toEqual([]);
  });
});

describe('classifyDormantSchedule (pure core — WI-5994)', () => {
  it('is null (plain idle) when there is no loop at all', () => {
    expect(classifyDormantSchedule(null)).toBeNull();
    expect(classifyDormantSchedule(undefined)).toBeNull();
  });

  it('is null when the loop is inactive (ended)', () => {
    expect(classifyDormantSchedule(loopStatus({ active: false, nextFireAt: new Date(Date.now() + 60_000).toISOString() }))).toBeNull();
  });

  it('is null when the loop is STALLED — a broken dead-man switch is not a promise of delivery', () => {
    expect(classifyDormantSchedule(loopStatus({ stalled: true, nextFireAt: new Date(Date.now() + 60_000).toISOString() }))).toBeNull();
  });

  it('is null when nextFireAt is in the PAST (should have fired already — genuinely stuck, not scheduled)', () => {
    expect(classifyDormantSchedule(loopStatus({ nextFireAt: new Date(Date.now() - 60_000).toISOString() }))).toBeNull();
  });

  it('reports dormant-scheduled with the ETA when active + a future nextFireAt', () => {
    const eta = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(classifyDormantSchedule(loopStatus({ nextFireAt: eta }))).toEqual({ parked: false, nextFireAt: eta });
  });

  it('reports dormant-scheduled (parked, no ETA) when the loop is mid-turn right now', () => {
    expect(classifyDormantSchedule(loopStatus({ parked: true, nextFireAt: null }))).toEqual({
      parked: true,
      nextFireAt: null,
    });
  });
});

describe('reportIdleRecipients — WI-5994 dormant-scheduled reclassification', () => {
  beforeEach(() => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
    // Reset to the no-verdict default — an earlier describe block's oracle
    // mock IMPLEMENTATION survives `clearAllMocks` (it only clears calls/results),
    // so without this a later block can inherit a prior test's rejection.
    vi.mocked(resolveSessionStates).mockResolvedValue(new Map());
  });
  afterEach(() => vi.clearAllMocks());

  it('the exact WI-5994 repro: an agent with zero wake-watchers but a future nextFireAt is dormantScheduled, NOT idle', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-055aef7f'));
    const eta = new Date(Date.now() + 9 * 60_000).toISOString();
    vi.mocked(getLoopStatuses).mockResolvedValue(new Map([['su-055aef7f', loopStatus({ nextFireAt: eta })]]));
    const r = await reportIdleRecipients(['su-055aef7f'], {});
    expect(r.idle).toEqual([]);
    expect(r.dormantScheduled).toEqual([{ ownerId: 'su-055aef7f', parked: false, nextFireAt: eta }]);
  });

  it('a genuinely dead recipient (no loop at all) stays idle', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-dead'));
    vi.mocked(getLoopStatuses).mockResolvedValue(new Map());
    const r = await reportIdleRecipients(['su-dead'], {});
    expect(r.idle).toEqual(['su-dead']);
    expect(r.dormantScheduled).toEqual([]);
  });

  it('a STALLED loop does not save an idle recipient from being reported idle', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-stalled-loop'));
    vi.mocked(getLoopStatuses).mockResolvedValue(
      new Map([['su-stalled-loop', loopStatus({ stalled: true, nextFireAt: new Date(Date.now() + 60_000).toISOString() })]]),
    );
    const r = await reportIdleRecipients(['su-stalled-loop'], {});
    expect(r.idle).toEqual(['su-stalled-loop']);
    expect(r.dormantScheduled).toEqual([]);
  });

  it('a loop-status read hiccup degrades to plain idle (never invents a false dormant-scheduled)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listPresence).mockResolvedValue(presence('su-bee-1'));
    vi.mocked(getLoopStatuses).mockRejectedValue(new Error('loop status down'));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.idle).toEqual(['su-bee-1']);
    expect(r.dormantScheduled).toEqual([]);
    expect(r.degraded).toBe(false); // the OVERALL probe still succeeded — only the loop enrichment degraded
    warn.mockRestore();
  });

  it('never calls getLoopStatuses when there are no idle candidates (all live)', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-live'));
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(1));
    const r = await reportIdleRecipients(['su-live'], {});
    expect(r.live).toEqual(['su-live']);
    expect(getLoopStatuses).not.toHaveBeenCalled();
  });
});
