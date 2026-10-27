import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  register: vi.fn(), recover: vi.fn(), watch: vi.fn(), reviews: vi.fn(), gates: vi.fn(), blockers: vi.fn(),
  backfill: vi.fn(),
}));
vi.mock('../harness/routines/system-actions', () => ({ registerSystemAction: h.register }));
vi.mock('../owner-directive-recovery', () => ({ sweepOwnerDirectiveRecovery: h.recover }));
vi.mock('./gate-watch', () => ({ tickGateWatch: h.watch }));
vi.mock('./review-stall-reaper', () => ({ sweepOmittedReviews: h.reviews }));
vi.mock('./gate-reaper', () => ({ sweepSessionIndependentGates: h.gates }));
vi.mock('./work-item-blocker-reaper', () => ({
  sweepWorkItemBlockerDefaults: h.blockers, backfillUnprovableWaitRecheckDates: h.backfill,
}));
const { UNPROVABLE_WAIT_BACKFILL_EVERY_MS, resetUnprovableWaitBackfillThrottleForTest } = await import('./gate-watch-action');
const action = h.register.mock.calls.find(([name]) => name === 'gate-watcher-tick')?.[1];
const ctx = { workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  h.recover.mockReset().mockResolvedValue({ examined: 0, created: 0, retained: 0, errors: [] });
  h.watch.mockReset().mockResolvedValue({ scannedFiles: 0, roots: [], opened: 0, alreadyOpen: 0, closed: 0, errors: [] });
  h.reviews.mockReset().mockResolvedValue({ examined: 0, released: 0, errors: [] });
  h.gates.mockReset().mockResolvedValue({ examined: 0, closedAskerGone: 0, closedDefaultApplied: 0, skipped: {} });
  h.blockers.mockReset().mockResolvedValue({ examined: 0, skipped: {}, recovered: { keys: 0, failed: 0 }, repaired: { reopened: 0, skipped: {} } });
  h.backfill.mockReset().mockResolvedValue({
    items: 0, examined: 0, unprovable: 0, stamped: 0, provable: 0, skipped: {}, byReason: {}, truncatedByLimit: false,
  });
  resetUnprovableWaitBackfillThrottleForTest();
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
