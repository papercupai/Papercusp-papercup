import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  register: vi.fn(), recover: vi.fn(), watch: vi.fn(), reviews: vi.fn(), gates: vi.fn(), blockers: vi.fn(),
  backfill: vi.fn(), parkBackfill: vi.fn(), parkSweep: vi.fn(), contractlessStamp: vi.fn(), contractlessSweep: vi.fn(),
}));
vi.mock('../harness/routines/system-actions', () => ({ registerSystemAction: h.register }));
vi.mock('../owner-directive-recovery', () => ({ sweepOwnerDirectiveRecovery: h.recover }));
vi.mock('./gate-watch', () => ({ tickGateWatch: h.watch }));
vi.mock('./review-stall-reaper', () => ({ sweepOmittedReviews: h.reviews }));
vi.mock('./gate-reaper', () => ({ sweepSessionIndependentGates: h.gates }));
vi.mock('./work-item-blocker-reaper', () => ({
  sweepWorkItemBlockerDefaults: h.blockers, backfillUnprovableWaitRecheckDates: h.backfill,
}));
vi.mock('./durable-park-recheck', () => ({
  backfillUnprovableParkRecheckDates: h.parkBackfill, sweepDueParkRechecks: h.parkSweep,
}));
vi.mock('./contractless-park-recheck', () => ({
  stampContractlessParkRecheckDates: h.contractlessStamp, sweepDueContractlessParkRechecks: h.contractlessSweep,
}));
const { UNPROVABLE_WAIT_BACKFILL_EVERY_MS, resetUnprovableWaitBackfillThrottleForTest } = await import('./gate-watch-action');
const action = h.register.mock.calls.find(([name]) => name === 'gate-watcher-tick')?.[1];
const ctx = { workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  h.recover.mockReset().mockResolvedValue({ examined: 0, created: 0, retained: 0, errors: [] });
  h.watch.mockReset().mockResolvedValue({ scannedFiles: 0, roots: [], opened: 0, alreadyOpen: 0, closed: 0, errors: [] });
  h.reviews.mockReset().mockResolvedValue({ examined: 0, released: 0, errors: [] });
  h.gates.mockReset().mockResolvedValue({ examined: 0, closedAskerGone: 0, closedDefaultApplied: 0, skipped: {} });
  h.blockers.mockReset().mockResolvedValue({
    examined: 0, skipped: {}, recovered: { keys: 0, failed: 0 }, repaired: { reopened: 0, skipped: {} },
    malformed: { count: 0, sample: [], truncatedByLimit: false, failed: false },
  });
  h.backfill.mockReset().mockResolvedValue({
    items: 0, examined: 0, unprovable: 0, stamped: 0, provable: 0, skipped: {}, byReason: {}, truncatedByLimit: false,
  });
  h.parkBackfill.mockReset().mockResolvedValue({
    parks: 0, unprovable: 0, stamped: 0, provable: 0, skipped: {}, byReason: {}, nextAfterId: null, truncatedByLimit: false,
  });
  h.parkSweep.mockReset().mockResolvedValue({ examined: 0, escalated: 0, provable: 0, skipped: {}, truncatedByLimit: false });
  h.contractlessStamp.mockReset().mockResolvedValue({
    parks: 0, stamped: 0, wouldStamp: 0, skipped: {}, nextAfterId: null, truncatedByLimit: false,
  });
  h.contractlessSweep.mockReset().mockResolvedValue({ examined: 0, escalated: 0, dropped: {}, skipped: {}, truncatedByLimit: false });
  resetUnprovableWaitBackfillThrottleForTest();
});
describe('gate-watcher contract-less park re-check leg (WI-6554700010030449)', () => {
  it('stamps then sweeps on every tick, paging the stamp after the last park the previous tick read', async () => {
    h.contractlessStamp
      .mockResolvedValueOnce({ parks: 200, stamped: 200, wouldStamp: 0, skipped: {}, nextAfterId: 'WI-0200', truncatedByLimit: true })
      .mockResolvedValueOnce({ parks: 46, stamped: 46, wouldStamp: 0, skipped: {}, nextAfterId: null, truncatedByLimit: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await action(ctx);
      await action(ctx);
      await action(ctx);
      expect(h.contractlessStamp.mock.calls.map(([o]) => o.afterId)).toEqual([null, 'WI-0200', null]);
      expect(h.contractlessSweep).toHaveBeenCalledTimes(3);
      // The stamp lands before the sweep, so a park whose first date is already due escalates on the same tick.
      expect(h.contractlessStamp.mock.invocationCallOrder[0]).toBeLessThan(h.contractlessSweep.mock.invocationCallOrder[0]);
      expect(log.mock.calls.flat().join('\n')).toContain('[contractless-park-recheck] 200/200 park(s) stamped');
    } finally {
      log.mockRestore();
    }
  });
  it('isolates a failed contract-less leg from every other leg', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.contractlessStamp.mockRejectedValueOnce(new Error('listing failed'));
    try {
      await action(ctx);
      expect(warning).toHaveBeenCalledWith('[contractless-park-recheck]   ! pass skipped: listing failed');
      expect(h.parkSweep).toHaveBeenCalledOnce();
      expect(h.blockers).toHaveBeenCalledOnce();
      await action(ctx);
      expect(h.contractlessSweep).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});
describe('gate-watcher durable-park re-check legs (WI-6554700010030346)', () => {
  it('stamps unprovable parks inside the throttled backfill window and sweeps due parks on every tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-27T15:00:00Z');
      vi.setSystemTime(start);
      await action(ctx);
      expect(h.parkBackfill).toHaveBeenCalledOnce();
      expect(h.parkSweep).toHaveBeenCalledOnce();
      // The stamp lands before the sweep, so a park stamped `now` is escalated on the same tick.
      expect(h.parkBackfill.mock.invocationCallOrder[0]).toBeLessThan(h.parkSweep.mock.invocationCallOrder[0]);
      vi.setSystemTime(start + 2 * 60_000);
      await action(ctx);
      expect(h.parkBackfill).toHaveBeenCalledOnce();
      expect(h.parkSweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('pages the park backfill: each pass resumes after the last park the previous pass read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-27T15:00:00Z');
      h.parkBackfill
        .mockResolvedValueOnce({ parks: 100, unprovable: 0, stamped: 0, provable: 100, skipped: {}, byReason: {},
          nextAfterId: 'WI-0100', truncatedByLimit: true })
        .mockResolvedValueOnce({ parks: 7, unprovable: 0, stamped: 0, provable: 7, skipped: {}, byReason: {},
          nextAfterId: null, truncatedByLimit: false });
      vi.setSystemTime(start);
      await action(ctx);
      vi.setSystemTime(start + UNPROVABLE_WAIT_BACKFILL_EVERY_MS);
      await action(ctx);
      vi.setSystemTime(start + 2 * UNPROVABLE_WAIT_BACKFILL_EVERY_MS);
      await action(ctx);
      expect(h.parkBackfill.mock.calls.map(([o]) => o.afterId)).toEqual([null, 'WI-0100', null]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('isolates a failed park leg from every other leg', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.parkBackfill.mockRejectedValueOnce(new Error('park listing failed'));
    h.parkSweep.mockRejectedValueOnce(new Error('escalation store down'));
    try {
      await action(ctx);
      expect(warning).toHaveBeenCalledWith('[unprovable-park-backfill]   ! pass skipped: park listing failed');
      expect(warning).toHaveBeenCalledWith('[park-recheck]   ! sweep skipped: escalation store down');
      expect(h.backfill).toHaveBeenCalledOnce();
      expect(h.blockers).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});
describe('gate-watcher unprovable-wait backfill leg (WI-6554700010029948)', () => {
  it('stamps unprovable waits before the blocker sweep, so the sweep escalates them on the same tick', async () => {
    await action(ctx);
    expect(h.backfill).toHaveBeenCalledOnce();
    expect(h.blockers).toHaveBeenCalledOnce();
    expect(h.backfill.mock.invocationCallOrder[0]).toBeLessThan(h.blockers.mock.invocationCallOrder[0]);
  });
  it('throttles the full backfill pass but runs the sweep on every tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-27T15:00:00Z');
      vi.setSystemTime(start);
      await action(ctx);
      vi.setSystemTime(start + 2 * 60_000);
      await action(ctx);
      expect(h.backfill).toHaveBeenCalledOnce();
      expect(h.blockers).toHaveBeenCalledTimes(2);
      vi.setSystemTime(start + UNPROVABLE_WAIT_BACKFILL_EVERY_MS);
      await action(ctx);
      expect(h.backfill).toHaveBeenCalledTimes(2);
      expect(h.blockers).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('isolates a failed pass from the sweep and retries it on the next tick', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.backfill.mockRejectedValueOnce(new Error('ledger unavailable'));
    try {
      await action(ctx);
      expect(warning).toHaveBeenCalledWith('[unprovable-wait-backfill]   ! pass skipped: ledger unavailable');
      expect(h.blockers).toHaveBeenCalledOnce();
      await action(ctx);
      expect(h.backfill).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });
});
describe('gate-watcher malformed blocker report (WI-6554700010030445)', () => {
  it('warns with the sampled items when the sweep found malformed active blocker rows, and is quiet otherwise', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.blockers.mockResolvedValueOnce({
      examined: 0, skipped: {}, recovered: { keys: 0, failed: 0 }, repaired: { reopened: 0, skipped: {} },
      malformed: { count: 2, sample: ['papercusp/WI-a', 'papercusp/WI-b'], truncatedByLimit: true, failed: false },
    });
    try {
      await action(ctx);
      expect(warning).toHaveBeenCalledWith(
        '[blocker-recheck] ! 2+ item(s) parked by an active blocker row readExternalBlockers rejects, ' +
          'so nothing can release them: papercusp/WI-a, papercusp/WI-b',
      );
      warning.mockClear();
      await action(ctx);
      expect(warning.mock.calls.flat().join('\n')).not.toContain('[blocker-');
    } finally {
      warning.mockRestore();
    }
  });
});
describe('gate-watcher directive recovery scheduling', () => {
  it('recovers orphan directives before transcript failure can abort the tick', async () => {
    h.watch.mockRejectedValue(new Error('transcript unavailable'));
    await expect(action(ctx)).rejects.toThrow('transcript unavailable');
    expect(h.recover).toHaveBeenCalledWith({ workspaceId: 'ws', harness: 'papercusp' });
    expect(h.recover.mock.invocationCallOrder[0]).toBeLessThan(h.watch.mock.invocationCallOrder[0]);
  });
  it('isolates a recovery failure so independent checks still run', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.recover.mockRejectedValue(new Error('directive store unavailable'));
    try {
      await action(ctx);
      expect(warning).toHaveBeenCalledWith('[owner-directive-recovery] directive store unavailable');
      expect(h.watch).toHaveBeenCalledOnce();
      expect(h.reviews).toHaveBeenCalledOnce();
      expect(h.gates).toHaveBeenCalledOnce();
      expect(h.blockers).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});
