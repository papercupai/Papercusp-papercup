/**
 * enrich-busy — unit coverage for the file-lock contention enrichment.
 *
 * When a peer is blocked acquiring a file lock, enrichBusy augments the busy rows
 * with the HOLDER's declared coord intent + focus (from presence) — that's what a
 * blocked peer reads to decide whether to wait or pivot. getPresence is mocked
 * (deterministic; no live coord/PG).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ getPresence: vi.fn() }));
vi.mock('../coordination/presence', () => ({ getPresence: h.getPresence }));

import { busyToJson, enrichBusy, intentsDiverged } from './enrich-busy';
import type { AcquireBusy } from './su-lock-store';

const busy = (over: Partial<AcquireBusy> = {}): AcquireBusy =>
  ({
    path: 'apps/a.ts',
    owner: 'peer-1',
    owner_label: 'res:peer-1',
    intent: 'PreToolUse:Edit',
    expires_ts: new Date('2026-06-22T00:00:00.000Z'),
    ...over,
  }) as AcquireBusy;

beforeEach(() => h.getPresence.mockReset());

describe('busyToJson', () => {
  it('maps an AcquireBusy row to JSON with an ISO expiry (no enrichment)', () => {
    expect(busyToJson(busy())).toEqual({
      path: 'apps/a.ts',
      owner: 'peer-1',
      owner_label: 'res:peer-1',
      intent: 'PreToolUse:Edit',
      expires_ts: '2026-06-22T00:00:00.000Z',
    });
  });
});

describe('enrichBusy', () => {
  it("adds the holder's declared coord intent + focus from presence", async () => {
    h.getPresence.mockResolvedValue({ intent: 'refactoring the sync resolver', currentFiles: ['apps/a.ts'] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBe('refactoring the sync resolver');
    expect(row.holder_focused).toBe(true);
  });

  it('treats the OMP placeholder intent as "nothing declared" (not surfaced)', async () => {
    h.getPresence.mockResolvedValue({ intent: '(active — see coord:presence for current work)', currentFiles: [] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBeUndefined();
  });

  it('ignores an empty / whitespace-only intent (focus is independent)', async () => {
    h.getPresence.mockResolvedValue({ intent: '   ', currentFiles: ['apps/a.ts'] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBe(true);
  });

  it('leaves a row unenriched on a presence MISS (holder has no presence → getPresence null)', async () => {
    h.getPresence.mockResolvedValue(null); // no presence row for this owner
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBeUndefined();
    expect(row.owner).toBe('peer-1'); // the base mapping is still present
  });

  it('does NOT set holder_focused when the holder is not focused on THIS path', async () => {
    h.getPresence.mockResolvedValue({ intent: 'editing elsewhere', currentFiles: ['apps/other.ts'] });
    const [row] = await enrichBusy([busy({ path: 'apps/a.ts' })]);
    expect(row.holder_focused).toBeUndefined();
    expect(row.holder_intent).toBe('editing elsewhere');
  });

  it('calls getPresence ONCE per distinct holder (dedup), enriching all that holder\'s rows', async () => {
    h.getPresence.mockResolvedValue({ intent: 'big refactor', currentFiles: ['apps/a.ts', 'apps/b.ts'] });
    const rows = await enrichBusy([
      busy({ path: 'apps/a.ts', owner: 'peer-1' }),
      busy({ path: 'apps/b.ts', owner: 'peer-1' }),
    ]);
    expect(h.getPresence).toHaveBeenCalledTimes(1); // one lookup for the shared owner
    expect(rows.every((r) => r.holder_intent === 'big refactor')).toBe(true);
    expect(rows.every((r) => r.holder_focused === true)).toBe(true);
  });

  // EI-10433: the orphaned-lock signal. A lock acquired for one task whose
  // holder has since declared a DIFFERENT coord intent (without releasing) is
  // stale, not actively contended — surface it so a blocked peer needn't
  // cross-reference coord:presence by hand or wait out the ~20min TTL.
  it('flags holder_intent_diverged when the holder moved to an unrelated intent (the EI-10433 case)', async () => {
    h.getPresence.mockResolvedValue({
      intent: 'WI-1819/WI-1812 drain-loop picks',
      intentDeclaredAt: '2026-06-21T23:59:01.000Z',
      currentFiles: ['apps/other.ts'],
    });
    const [row] = await enrichBusy([busy({
      intent: 'WI-4138: add prReviewerSettings.byHarness named-query entry',
      acquired_ts: new Date('2026-06-21T23:59:00.000Z'),
    })]);
    expect(row.holder_intent_diverged).toBe(true);
  });

  it('does NOT flag a divergent intent declared before the lock was acquired', async () => {
    h.getPresence.mockResolvedValue({
      intent: 'P001 broad drain coordination',
      intentDeclaredAt: '2026-11-02T05:26:00.000Z',
      currentFiles: [],
    });
    const lock = {
      ...busy({ intent: 'EI-276715 share writer/reader progress validation' }),
      acquired_ts: new Date('2026-11-02T14:10:34.000Z'),
    };
    const [row] = await enrichBusy([lock]);
    expect(row.holder_intent_diverged).toBeUndefined();
  });

  it('does NOT flag divergence when the lock acquisition time is unknown', async () => {
    h.getPresence.mockResolvedValue({
      intent: 'WI-1819/WI-1812 drain-loop picks',
      intentDeclaredAt: '2026-06-22T00:10:00.000Z',
      currentFiles: ['apps/other.ts'],
    });
    const [row] = await enrichBusy([busy({ intent: 'WI-4138: the named-query entry' })]);
    expect(row.holder_intent_diverged).toBeUndefined();
  });

  it('does NOT flag divergence while the holder is still focused on THIS path', async () => {
    h.getPresence.mockResolvedValue({ intent: 'WI-1819 something else entirely', currentFiles: ['apps/a.ts'] });
    const [row] = await enrichBusy([busy({ path: 'apps/a.ts', intent: 'WI-4138: the named-query entry' })]);
    expect(row.holder_focused).toBe(true);
    expect(row.holder_intent_diverged).toBeUndefined();
  });

  it('does NOT flag divergence when the holder still cites the same work-item ref', async () => {
    h.getPresence.mockResolvedValue({ intent: 'still on WI-4138, now writing the tests', currentFiles: ['apps/other.ts'] });
    const [row] = await enrichBusy([busy({ intent: 'WI-4138: add prReviewerSettings.byHarness named-query entry' })]);
    expect(row.holder_intent_diverged).toBeUndefined();
  });

  it('does NOT flag divergence for an uninformative (hook-stamped) lock intent', async () => {
    // The common per-edit lock's intent is 'PreToolUse:Edit' / 'capability:edit' —
    // it identifies nothing to compare against, so divergence is uncomputable.
    h.getPresence.mockResolvedValue({ intent: 'WI-1819 unrelated work', currentFiles: ['apps/other.ts'] });
    const [edit] = await enrichBusy([busy({ intent: 'PreToolUse:Edit' })]);
    expect(edit.holder_intent_diverged).toBeUndefined();
    const [cap] = await enrichBusy([busy({ intent: 'capability:edit' })]);
    expect(cap.holder_intent_diverged).toBeUndefined();
  });

  it('does NOT flag divergence when the holder has no meaningful declared intent', async () => {
    h.getPresence.mockResolvedValue({ intent: '(active — see coord:presence for current work)', currentFiles: [] });
    const [row] = await enrichBusy([busy({ intent: 'WI-4138: the named-query entry' })]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_intent_diverged).toBeUndefined();
  });
});

describe('intentsDiverged', () => {
  it('is true for two clearly different threads with no shared ref', () => {
    expect(intentsDiverged('WI-4138: named-query entry', 'WI-1819/WI-1812 drain-loop picks')).toBe(true);
    expect(intentsDiverged('refactoring the sync resolver', 'writing the release notes')).toBe(true);
  });

  it('is false when the intents share a work-item ref', () => {
    expect(intentsDiverged('WI-4138: named-query entry', 'still on WI-4138, now the tests')).toBe(false);
  });

  it('is false for equal or substring-related intents', () => {
    expect(intentsDiverged('add the named-query entry', 'add the named-query entry')).toBe(false);
    expect(intentsDiverged('add the named-query entry', 'add the named-query entry (part 2)')).toBe(false);
  });

  it('is false for an uninformative or empty lock intent', () => {
    expect(intentsDiverged('PreToolUse:Edit', 'anything else')).toBe(false);
    expect(intentsDiverged('capability:write', 'anything else')).toBe(false);
    expect(intentsDiverged('', 'anything else')).toBe(false);
  });

  it('is false when the holder intent is empty', () => {
    expect(intentsDiverged('WI-4138: real intent', '   ')).toBe(false);
  });
});
