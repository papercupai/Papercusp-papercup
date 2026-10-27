import { describe, expect, it, vi } from 'vitest';
import {
  admitBatches, batchEditViolations, DEFAULT_CAMPAIGN_CONCURRENCY_CAP, DEFAULT_RECENT_EDIT_WINDOW_MS,
  type AdmissionDeps, type AdmissionInput, type PeerEdit, type PeerLock,
} from './admission';

const NOW = new Date('2026-10-27T05:00:00Z');
const SELF = 'su-runner';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function deps(over: { locks?: PeerLock[]; edits?: PeerEdit[]; contended?: string[] } = {}): AdmissionDeps & {
  acquire: ReturnType<typeof vi.fn>; liveLocks: ReturnType<typeof vi.fn>; editsSince: ReturnType<typeof vi.fn>;
} {
  return {
    liveLocks: vi.fn(async (paths: readonly string[]) => (over.locks ?? []).filter(l => paths.includes(l.path))),
    editsSince: vi.fn(async (paths: readonly string[], since: Date) =>
      (over.edits ?? []).filter(e => paths.includes(e.path) && e.at >= since)),
    acquire: vi.fn(async (batch: { id: string }) => over.contended?.includes(batch.id)
      ? { ok: false as const, detail: 'lock_contended' }
      : { ok: true as const, lockId: `lock-${batch.id}` }),
  };
}

function input(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    campaignId: 'camp-1', self: SELF, running: [], now: NOW,
    candidates: [
      { id: 'b1', targetFiles: ['a.ts', 'b.ts'] },
      { id: 'b2', targetFiles: ['c.ts'] },
      { id: 'b3', targetFiles: ['d.ts'] },
    ],
    ...over,
  };
}

describe('cleanup campaign batch admission (R-7)', () => {
  it('skips a batch whose target file holds another agent\'s live lock', async () => {
    const d = deps({ locks: [{ path: 'b.ts', owner: 'su-peer', expiresAt: new Date(NOW.getTime() + 60_000) }] });
    const r = await admitBatches(input(), d);
    expect(r.skipped).toContainEqual(expect.objectContaining({ batchId: 'b1', reason: 'peer-lock', paths: ['b.ts'] }));
    expect(r.admitted.map(a => a.batchId)).toEqual(['b2', 'b3']);
    expect(d.acquire).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }), expect.anything());
  });

  it('does not treat the runner\'s own lock or an expired peer lock as blocking', async () => {
    const d = deps({ locks: [
      { path: 'a.ts', owner: SELF, expiresAt: null },
      { path: 'b.ts', owner: 'su-peer', expiresAt: minutesAgo(1) },
    ] });
    const r = await admitBatches(input({ candidates: [{ id: 'b1', targetFiles: ['a.ts', 'b.ts'] }] }), d);
    expect(r.admitted.map(a => a.batchId)).toEqual(['b1']);
  });

  it('skips a batch whose target file another agent edited inside the recency window', async () => {
    const d = deps({ edits: [{ path: 'c.ts', owner: 'su-peer', at: minutesAgo(29) }] });
    const r = await admitBatches(input(), d);
    expect(r.skipped).toContainEqual(expect.objectContaining({ batchId: 'b2', reason: 'peer-recent-edit', paths: ['c.ts'] }));
    expect(r.admitted.map(a => a.batchId)).toEqual(['b1', 'b3']);
  });

  it('admits a batch whose peer edit is older than the window, or is the runner\'s own edit', async () => {
    const d = deps({ edits: [
      { path: 'c.ts', owner: 'su-peer', at: minutesAgo(31) },
      { path: 'a.ts', owner: SELF, at: minutesAgo(1) },
    ] });
    const r = await admitBatches(input({ candidates: [{ id: 'b1', targetFiles: ['a.ts'] }, { id: 'b2', targetFiles: ['c.ts'] }] }), d);
    expect(r.admitted.map(a => a.batchId)).toEqual(['b1', 'b2']);
    expect(d.editsSince).toHaveBeenCalledWith(expect.anything(), new Date(NOW.getTime() - DEFAULT_RECENT_EDIT_WINDOW_MS));
  });

  it('never admits more concurrent batches than the cap, counting batches already running', async () => {
    expect(DEFAULT_CAMPAIGN_CONCURRENCY_CAP).toBe(2);
    const fresh = await admitBatches(input(), deps());
    expect(fresh.admitted.map(a => a.batchId)).toEqual(['b1', 'b2']);
    expect(fresh.skipped).toContainEqual(expect.objectContaining({ batchId: 'b3', reason: 'cap-reached' }));

    const oneRunning = await admitBatches(input({ running: ['b0'] }), deps());
    expect(oneRunning.admitted.map(a => a.batchId)).toEqual(['b1']);

    const full = await admitBatches(input({ running: ['b0', 'bx'], cap: 2 }), deps());
    expect(full.admitted).toEqual([]);
    expect(full.skipped.every(s => s.reason === 'cap-reached')).toBe(true);
  });

  it('locks every target file of an admitted batch before it starts, and skips it when the lock is contended', async () => {
    const d = deps({ contended: ['b1'] });
    const r = await admitBatches(input(), d);
    expect(d.acquire).toHaveBeenCalledWith({ id: 'b1', targetFiles: ['a.ts', 'b.ts'] }, expect.stringContaining('camp-1'));
    expect(r.skipped).toContainEqual(expect.objectContaining({ batchId: 'b1', reason: 'lock-contended' }));
    expect(r.admitted).toEqual([
      { batchId: 'b2', lockId: 'lock-b2', targetFiles: ['c.ts'] },
      { batchId: 'b3', lockId: 'lock-b3', targetFiles: ['d.ts'] },
    ]);
  });

  it('does not admit two batches touching the same file in one round, nor a running or file-less batch', async () => {
    const r = await admitBatches(input({ cap: 5, running: ['b9'], candidates: [
      { id: 'b1', targetFiles: ['a.ts'] }, { id: 'b2', targetFiles: ['a.ts', 'z.ts'] },
      { id: 'b9', targetFiles: ['q.ts'] }, { id: 'b4', targetFiles: [] },
    ] }), deps());
    expect(r.admitted.map(a => a.batchId)).toEqual(['b1']);
    expect(r.skipped.map(s => [s.batchId, s.reason])).toEqual([
      ['b2', 'overlaps-admitted'], ['b9', 'already-running'], ['b4', 'no-target-files'],
    ]);
  });

  it('reads locks and edits once per round, not once per batch', async () => {
    const d = deps();
    await admitBatches(input({ cap: 3 }), d);
    expect(d.liveLocks).toHaveBeenCalledTimes(1);
    expect(d.editsSince).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-positive cap or window before reading anything', async () => {
    const d = deps();
    await expect(admitBatches(input({ cap: 0 }), d)).rejects.toThrow(/cap/);
    await expect(admitBatches(input({ recentEditWindowMs: -1 }), d)).rejects.toThrow(/recentEditWindowMs/);
    expect(d.liveLocks).not.toHaveBeenCalled();
  });

  it('names every file a batch edited outside its own lock', () => {
    expect(batchEditViolations({ targetFiles: ['a.ts', 'b.ts'] }, ['a.ts', 'x.ts', 'x.ts'])).toEqual(['x.ts']);
    expect(batchEditViolations({ targetFiles: ['a.ts'] }, ['a.ts'])).toEqual([]);
  });
});
