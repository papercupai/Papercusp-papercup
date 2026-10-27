import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  register: vi.fn(), recover: vi.fn(), watch: vi.fn(), reviews: vi.fn(), gates: vi.fn(), blockers: vi.fn(),
}));
vi.mock('../harness/routines/system-actions', () => ({ registerSystemAction: h.register }));
vi.mock('../owner-directive-recovery', () => ({ sweepOwnerDirectiveRecovery: h.recover }));
vi.mock('./gate-watch', () => ({ tickGateWatch: h.watch }));
vi.mock('./review-stall-reaper', () => ({ sweepOmittedReviews: h.reviews }));
vi.mock('./gate-reaper', () => ({ sweepSessionIndependentGates: h.gates }));
vi.mock('./work-item-blocker-reaper', () => ({ sweepWorkItemBlockerDefaults: h.blockers }));
await import('./gate-watch-action');
const action = h.register.mock.calls.find(([name]) => name === 'gate-watcher-tick')?.[1];
const ctx = { workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  h.recover.mockReset().mockResolvedValue({ examined: 0, created: 0, retained: 0, errors: [] });
  h.watch.mockReset().mockResolvedValue({ scannedFiles: 0, roots: [], opened: 0, alreadyOpen: 0, closed: 0, errors: [] });
  h.reviews.mockReset().mockResolvedValue({ examined: 0, released: 0, errors: [] });
  h.gates.mockReset().mockResolvedValue({ examined: 0, closedAskerGone: 0, closedDefaultApplied: 0, skipped: {} });
  h.blockers.mockReset().mockResolvedValue({ examined: 0, skipped: {}, recovered: { keys: 0, failed: 0 }, repaired: { reopened: 0, skipped: {} } });
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
