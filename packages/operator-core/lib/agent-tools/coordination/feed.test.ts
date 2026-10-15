/**
 * feed.test.ts — readCoordFeed, the cross-channel coordination firehose read.
 *
 * Pure/seamable: the only dependency is the `coordLog` seam (mocked here), so the
 * union → tag → filter → histogram → sort → page pipeline is exercised deterministically
 * with no PG. Each describe pins one behavior of the read.
 *
 * Surface→reader mapping under test (feed.ts, WI-3869/WI-3880): messages/plan-events ⇒
 * coordLog.readLinesBoundedCursor; escalations/handoffs ⇒ coordLog.readEventsBoundedCursor —
 * the id-CURSOR bounded methods (ORDER BY id DESC LIMIT n, optionally `id < beforeId`), not
 * the unbounded full-scan readLines/readEvents (WI-3869 replaced those call sites precisely
 * because the unbounded scan degraded coord:presence/fleet:status/coord:orient as the log
 * grows) and not the plain (non-cursor) readLinesBounded/readEventsBounded (WI-3880 switched
 * to the cursor variant so a `before_ts` page can walk deeper than the first window instead
 * of dead-ending there).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope, CoordKind } from '@papercusp/coordination/core';

// Mock the coordLog seam — also keeps the real ./log (and its getOrgPg/PG import) out of the test.
vi.mock('./log', () => ({
  coordLog: { readLinesBoundedCursor: vi.fn(), readEventsBoundedCursor: vi.fn() },
}));

import { readCoordFeed, type CoordSurface, DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT } from './feed';
import { coordLog } from './log';

const mockLog = coordLog as unknown as {
  readLinesBoundedCursor: ReturnType<typeof vi.fn>;
  readEventsBoundedCursor: ReturnType<typeof vi.fn>;
};

/** Wrap a flat envelope array into the `{ rows: [{id, envelope}], exhausted }`
 *  cursor-page shape a real backend would return for a single-round fetch that
 *  covers the surface's ENTIRE (test-sized) content — so `exhausted` is always
 *  `true`, matching a real backend once it has nothing older left. This means
 *  the WI-3880 deepening loop never fires an extra round against this mock
 *  (there IS nothing more to fetch), so every existing single-round assertion
 *  below still holds unchanged. `id` is assigned by ARRAY POSITION (ascending
 *  1..N) — irrelevant to these tests (none pass `beforeId` against this mock),
 *  just a value the shape requires. */
function cursorPage(data: CoordEnvelope[]): { rows: { id: number; envelope: CoordEnvelope }[]; exhausted: boolean } {
  return { rows: data.map((envelope, i) => ({ id: i + 1, envelope })), exhausted: true };
}

/** Configure the four surfaces' contents. messages/plan-events resolve via
 *  readLinesBoundedCursor, escalations/handoffs via readEventsBoundedCursor — a
 *  single per-surface map drives both (the mock ignores the bound options,
 *  same as the old unbounded double did — the pipeline behavior under test is
 *  identical, only the underlying seam call changed per WI-3869/WI-3880). */
function setSurfaces(data: Partial<Record<CoordSurface, CoordEnvelope[]>>): void {
  mockLog.readLinesBoundedCursor.mockImplementation(async (s: CoordSurface) => cursorPage(data[s] ?? []));
  mockLog.readEventsBoundedCursor.mockImplementation(async (s: CoordSurface) => cursorPage(data[s] ?? []));
}

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-06-23T12:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('union + surface tagging + broadcast flag', () => {
  it('tags each row with its origin surface and reads from the right seam method', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'a', kind: 'message' })],
      'plan-events': [env({ msg_id: 'b', kind: 'plan_event' })],
      escalations: [env({ msg_id: 'c', kind: 'escalation' })],
      handoffs: [env({ msg_id: 'd', kind: 'handoff' })],
    });
    const { rows, total } = await readCoordFeed();
    expect(total).toBe(4);
    const bySurface = Object.fromEntries(rows.map((r) => [r.msg_id, r.surface]));
    expect(bySurface).toEqual({ a: 'messages', b: 'plan-events', c: 'escalations', d: 'handoffs' });
    // line surfaces went through readLinesBoundedCursor; event surfaces through readEventsBoundedCursor
    expect(mockLog.readLinesBoundedCursor.mock.calls.map((c) => c[0]).sort()).toEqual(['messages', 'plan-events']);
    expect(mockLog.readEventsBoundedCursor.mock.calls.map((c) => c[0]).sort()).toEqual(['escalations', 'handoffs']);
  });

  it('WI-3869/WI-3880: every raw per-surface read is BOUNDED (never the unbounded full-scan) and pushes down kinds/since_ts/plan_slug', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'a' })],
      'plan-events': [env({ msg_id: 'b', kind: 'plan_event' })],
      escalations: [env({ msg_id: 'c', kind: 'escalation' })],
      handoffs: [env({ msg_id: 'd', kind: 'handoff' })],
    });
    await readCoordFeed({
      kinds: ['message', 'escalation'] as CoordKind[],
      since_ts: '2026-06-23T00:00:00.000Z',
      plan_slug: 'plan-a',
      before_ts: '2026-06-23T13:00:00.000Z',
    });
    // Every bounded call carries a numeric, non-unbounded limit — this is the
    // regression guard: a caller that reverts to coordLog.readLines/readEvents
    // (no `limit` arg at all) fails this assertion immediately.
    for (const call of [...mockLog.readLinesBoundedCursor.mock.calls, ...mockLog.readEventsBoundedCursor.mock.calls]) {
      const [, opts] = call as [CoordSurface, { limit?: number }];
      expect(typeof opts?.limit).toBe('number');
      expect(opts!.limit!).toBeGreaterThan(0);
    }
    // Line reads push down kinds + sinceTs + planSlug (readLinesBoundedCursor supports all three).
    const lineCall = mockLog.readLinesBoundedCursor.mock.calls.find((c) => c[0] === 'messages')!;
    expect(lineCall[1]).toMatchObject({
      kinds: ['message', 'escalation'],
      sinceTs: '2026-06-23T00:00:00.000Z',
      planSlug: 'plan-a',
      beforeTs: '2026-06-23T13:00:00.000Z',
    });
    // Event reads push down kinds only (readEventsBoundedCursor has no sinceTs/planSlug param).
    const eventCall = mockLog.readEventsBoundedCursor.mock.calls.find((c) => c[0] === 'escalations')!;
    expect(eventCall[1]).toMatchObject({ kinds: ['message', 'escalation'], beforeTs: '2026-06-23T13:00:00.000Z' });
    expect(eventCall[1]).not.toHaveProperty('sinceTs');
    expect(eventCall[1]).not.toHaveProperty('planSlug');
  });

  it('pushes the exact sender filter into every bounded feed surface read', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'm', from: 'zoe' })],
      'plan-events': [env({ msg_id: 'p', kind: 'plan_event', from: 'zoe' })],
      escalations: [env({ msg_id: 'e', kind: 'escalation', from: 'zoe' })],
      handoffs: [env({ msg_id: 'h', kind: 'handoff', from: 'zoe' })],
    });

    await readCoordFeed({ from: 'zoe' });

    for (const call of [...mockLog.readLinesBoundedCursor.mock.calls, ...mockLog.readEventsBoundedCursor.mock.calls]) {
      expect(call[1]).toMatchObject({ from: 'zoe' });
    }
  });

  it('derives broadcast from a ["*"] recipient', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'bc', to: ['*'] }),
        env({ msg_id: 'dm', to: ['bob'] }),
      ],
    });
    const { rows } = await readCoordFeed();
    expect(rows.find((r) => r.msg_id === 'bc')!.broadcast).toBe(true);
    expect(rows.find((r) => r.msg_id === 'dm')!.broadcast).toBe(false);
  });
});

describe('newest-first ordering (compareByTsThenId reversed)', () => {
  it('orders by ts descending', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'old', ts: '2026-06-23T10:00:00.000Z' }),
        env({ msg_id: 'new', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'mid', ts: '2026-06-23T11:00:00.000Z' }),
      ],
    });
    const { rows } = await readCoordFeed();
    expect(rows.map((r) => r.msg_id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks ts ties by msg_id descending', async () => {
    const ts = '2026-06-23T12:00:00.000Z';
    setSurfaces({ messages: [env({ msg_id: 'm1', ts }), env({ msg_id: 'm3', ts }), env({ msg_id: 'm2', ts })] });
    const { rows } = await readCoordFeed();
    expect(rows.map((r) => r.msg_id)).toEqual(['m3', 'm2', 'm1']);
  });
});

describe('limit clamp + nextCursor', () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    env({ msg_id: `m${i}`, ts: `2026-06-23T12:00:0${i}.000Z` }),
  );

  it('defaults to DEFAULT_FEED_LIMIT and returns null cursor when not capped', async () => {
    setSurfaces({ messages: five });
    const { rows, nextCursor, nextCursorMsgId, total } = await readCoordFeed();
    expect(DEFAULT_FEED_LIMIT).toBe(100);
    expect(rows).toHaveLength(5);
    expect(total).toBe(5);
    expect(nextCursor).toBeNull();
    expect(nextCursorMsgId).toBeNull();
  });

  it('caps to the requested limit and returns the oldest-of-page ts as the cursor', async () => {
    setSurfaces({ messages: five });
    const { rows, nextCursor, nextCursorMsgId, total } = await readCoordFeed({ limit: 2 });
    expect(rows.map((r) => r.msg_id)).toEqual(['m4', 'm3']); // newest two
    expect(total).toBe(5); // total counts the WHOLE filtered set, not the page
    expect(nextCursor).toBe('2026-06-23T12:00:03.000Z'); // ts of m3 (oldest on the page)
    expect(nextCursorMsgId).toBe('m3');
  });

  it('paginates across same-timestamp siblings with the composite cursor without loss or duplicates', async () => {
    const sharedTs = '2026-06-23T12:00:00.000Z';
    setSurfaces({
      messages: [
        env({ msg_id: 'm1', ts: sharedTs }),
        env({ msg_id: 'm3', ts: sharedTs }),
        env({ msg_id: 'm2', ts: sharedTs }),
        env({ msg_id: 'm0', ts: '2026-06-23T11:59:59.999Z' }),
      ],
    });

    const first = await readCoordFeed({ limit: 2 });
    expect(first.rows.map((r) => r.msg_id)).toEqual(['m3', 'm2']);
    expect(first.nextCursor).toBe(sharedTs);
    expect(first.nextCursorMsgId).toBe('m2');

    const second = await readCoordFeed({
      limit: 2,
      before_ts: first.nextCursor!,
      before_msg_id: first.nextCursorMsgId!,
    });
    expect(second.rows.map((r) => r.msg_id)).toEqual(['m1', 'm0']);
    expect(second.nextCursor).toBeNull();
    expect(second.nextCursorMsgId).toBeNull();

    // Existing timestamp-only callers retain their strict-earlier behavior;
    // the companion id is what makes new callers lossless at this boundary.
    const legacySecond = await readCoordFeed({ limit: 2, before_ts: first.nextCursor! });
    expect(legacySecond.rows.map((r) => r.msg_id)).toEqual(['m0']);
  });

  it('clamps a 0/negative limit up to 1', async () => {
    setSurfaces({ messages: five });
    expect((await readCoordFeed({ limit: 0 })).rows).toHaveLength(1);
    expect((await readCoordFeed({ limit: -7 })).rows).toHaveLength(1);
  });

  it('clamps an over-max limit down to MAX_FEED_LIMIT', async () => {
    expect(MAX_FEED_LIMIT).toBe(500);
    const many = Array.from({ length: 600 }, (_, i) =>
      env({ msg_id: `m${String(i).padStart(3, '0')}`, ts: `2026-06-23T12:00:00.${String(i).padStart(3, '0')}Z` }),
    );
    setSurfaces({ messages: many });
    const { rows, nextCursor, total } = await readCoordFeed({ limit: 9999 });
    expect(rows).toHaveLength(500);
    expect(total).toBe(600);
    expect(nextCursor).not.toBeNull(); // capped → more remain
  });
});

describe('filters', () => {
  it('returns only system-origin envelopes when system_only is set', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'agent', from: 'architect' }),
        env({ msg_id: 'system-colon', from: 'system:watchdog' }),
        env({ msg_id: 'system-dash', from: 'system-release' }),
      ],
      handoffs: [env({ msg_id: 'human', from: 'human' })],
    });
    const { rows, total } = await readCoordFeed({ system_only: true });
    expect(rows.map((row) => row.msg_id)).toEqual(['system-dash', 'system-colon']);
    expect(total).toBe(2);
  });

  it('kind filter keeps only the requested kinds', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'msg', kind: 'message' }), env({ msg_id: 'ack', kind: 'ack' })],
      escalations: [env({ msg_id: 'esc', kind: 'escalation' })],
    });
    const { rows } = await readCoordFeed({ kinds: ['escalation', 'ack'] as CoordKind[] });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['ack', 'esc']);
  });

  it('owner filter matches from, an addressed recipient, OR a broadcast', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'fromZoe', from: 'zoe', to: ['x'] }),
        env({ msg_id: 'toZoe', from: 'x', to: ['zoe'] }),
        env({ msg_id: 'bcast', from: 'x', to: ['*'] }),
        env({ msg_id: 'other', from: 'x', to: ['y'] }),
      ],
    });
    const { rows } = await readCoordFeed({ owner: 'zoe' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['bcast', 'fromZoe', 'toZoe']);
  });

  it('from filter is STRICT sender-only — matches from===this, NOT recipients or broadcasts-by-others (EI-7018)', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'fromZoe', from: 'zoe', to: ['x'] }), // zoe SENT it → included
        env({ msg_id: 'toZoe', from: 'x', to: ['zoe'] }), // zoe is a RECIPIENT → excluded (unlike owner)
        env({ msg_id: 'bcastX', from: 'x', to: ['*'] }), // broadcast by someone else → excluded (unlike owner)
        env({ msg_id: 'zoeBcast', from: 'zoe', to: ['*'] }), // zoe's OWN broadcast → included
      ],
    });
    const { rows, total } = await readCoordFeed({ from: 'zoe' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['fromZoe', 'zoeBcast']);
    expect(total).toBe(2); // the summary/histogram is scoped to the filter, not the raw stream
  });

  it('from + owner compose (AND) — sender is zoe AND the envelope involves bob', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'zoe_to_bob', from: 'zoe', to: ['bob'] }), // from zoe, involves bob → kept
        env({ msg_id: 'zoe_to_cat', from: 'zoe', to: ['cat'] }), // from zoe, not bob → dropped by owner
        env({ msg_id: 'ann_to_bob', from: 'ann', to: ['bob'] }), // involves bob, not from zoe → dropped by from
      ],
    });
    const { rows } = await readCoordFeed({ from: 'zoe', owner: 'bob' });
    expect(rows.map((r) => r.msg_id)).toEqual(['zoe_to_bob']);
  });

  it('plan_slug filter is exact-match', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'p1', plan_slug: 'plan-a' }),
        env({ msg_id: 'p2', plan_slug: 'plan-b' }),
        env({ msg_id: 'p3' }),
      ],
    });
    const { rows } = await readCoordFeed({ plan_slug: 'plan-a' });
    expect(rows.map((r) => r.msg_id)).toEqual(['p1']);
  });

  it('q is a case-insensitive substring over summary/body/from/to/plan_slug/event/detail', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'sum', summary: 'Deploy FAILED on staging' }),
        env({ msg_id: 'bod', body: 'see the failed run' }),
        env({ msg_id: 'fro', from: 'failed-bot' }),
        env({ msg_id: 'det', detail: 'root cause: FAILED migration' }),
        env({ msg_id: 'no', summary: 'all green' }),
      ],
    });
    const { rows } = await readCoordFeed({ q: 'failed' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['bod', 'det', 'fro', 'sum']);
  });

  it('since_ts is strictly-later and before_ts strictly-earlier (boundaries excluded)', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 't09', ts: '2026-06-23T09:00:00.000Z' }),
        env({ msg_id: 't10', ts: '2026-06-23T10:00:00.000Z' }),
        env({ msg_id: 't11', ts: '2026-06-23T11:00:00.000Z' }),
        env({ msg_id: 't12', ts: '2026-06-23T12:00:00.000Z' }),
      ],
    });
    const { rows } = await readCoordFeed({
      since_ts: '2026-06-23T10:00:00.000Z', // excludes t10
      before_ts: '2026-06-23T12:00:00.000Z', // excludes t12
    });
    expect(rows.map((r) => r.msg_id)).toEqual(['t11']);
  });
});

describe('WI-3880: before_ts deepening past the first RAW_SURFACE_FETCH_CAP window', () => {
  /** Drive `readLinesBoundedCursor` from a per-surface sequence of pages, keyed
   *  on CALL INDEX per surface — robust to whatever order the four surfaces
   *  happen to be invoked in within a round (unlike chained
   *  `mockImplementationOnce`, which is a single FIFO queue shared across every
   *  surface calling the same mock function). The last page in a surface's
   *  sequence repeats for any further calls (defaults to empty+exhausted for a
   *  surface with no sequence at all). */
  function setLineRounds(
    rounds: Partial<Record<CoordSurface, { rows: { id: number; envelope: CoordEnvelope }[]; exhausted: boolean }[]>>,
  ): void {
    const callIndex = new Map<CoordSurface, number>();
    mockLog.readLinesBoundedCursor.mockImplementation(async (s: CoordSurface) => {
      const pages = rounds[s] ?? [{ rows: [], exhausted: true }];
      const i = callIndex.get(s) ?? 0;
      callIndex.set(s, i + 1);
      return pages[Math.min(i, pages.length - 1)]!;
    });
  }

  it('walks a surface past its first window when the assembled page is still short of limit', async () => {
    const m3 = env({ msg_id: 'm3', ts: '2026-06-23T12:00:03.000Z' });
    const m2 = env({ msg_id: 'm2', ts: '2026-06-23T12:00:02.000Z' });
    const m1 = env({ msg_id: 'm1', ts: '2026-06-23T12:00:01.000Z' });
    setLineRounds({
      messages: [
        { rows: [{ id: 3, envelope: m3 }, { id: 2, envelope: m2 }], exhausted: false }, // round 1: not exhausted
        { rows: [{ id: 1, envelope: m1 }], exhausted: true }, // round 2 (beforeId=2): exhausted
      ],
    });
    mockLog.readEventsBoundedCursor.mockImplementation(async () => ({ rows: [], exhausted: true }));

    const { rows, total } = await readCoordFeed({ limit: 3, before_ts: '2026-06-24T00:00:00.000Z' });

    expect(rows.map((r) => r.msg_id)).toEqual(['m3', 'm2', 'm1']); // all 3, newest-first
    expect(total).toBe(3);
    // messages was fetched TWICE (round 1 + the deepening round); plan-events
    // (exhausted:true from its very first call) was fetched only once.
    const messagesCalls = mockLog.readLinesBoundedCursor.mock.calls.filter((c) => c[0] === 'messages');
    expect(messagesCalls).toHaveLength(2);
    expect(messagesCalls[0]![1]).not.toHaveProperty('beforeId'); // round 1: no cursor yet
    expect(messagesCalls[1]![1]).toMatchObject({ beforeId: 2 }); // round 2: walks past round 1's oldest id
    const planEventsCalls = mockLog.readLinesBoundedCursor.mock.calls.filter((c) => c[0] === 'plan-events');
    expect(planEventsCalls).toHaveLength(1);
  });

  it('pushes before_ts down before the bounded cursor-round cap can be consumed by newer rows', async () => {
    const beforeTs = '2026-06-24T00:00:00.000Z';
    const rawRows = Array.from({ length: 10_001 }, (_, i) => ({
      id: 10_002 - i,
      envelope: env({ msg_id: `newer-${i}`, from: 'another-agent', ts: '2026-06-25T00:00:00.000Z' }),
    }));
    rawRows.push({
      id: 1,
      envelope: env({ msg_id: 'known-delivery-marker', from: 'system:delivery-ladder', ts: '2026-06-23T12:10:34.505Z' }),
    });
    rawRows.sort((a, b) => b.id - a.id);
    mockLog.readLinesBoundedCursor.mockImplementation(async (surface: CoordSurface, opts: { beforeId?: number; beforeTs?: string }) => {
      if (surface !== 'messages') return { rows: [], exhausted: true };
      const beforeMs = opts.beforeTs ? Date.parse(opts.beforeTs) : null;
      const candidates = rawRows.filter(
        (row) =>
          (opts.beforeId === undefined || row.id < opts.beforeId) &&
          (beforeMs === null || Date.parse(row.envelope.ts) < beforeMs),
      );
      return { rows: candidates.slice(0, 1000), exhausted: candidates.length <= 1000 };
    });
    mockLog.readEventsBoundedCursor.mockImplementation(async () => ({ rows: [], exhausted: true }));

    const { rows } = await readCoordFeed({ from: 'system:delivery-ladder', before_ts: beforeTs, limit: 1 });

    expect(rows.map((row) => row.msg_id)).toEqual(['known-delivery-marker']);
    expect(mockLog.readLinesBoundedCursor.mock.calls.find((call) => call[0] === 'messages')?.[1]).toMatchObject({
      beforeTs,
    });
  });

  it('gives up after MAX_CURSOR_ROUNDS rather than looping forever on a surface that never satisfies the limit', async () => {
    // Every call returns exactly one row, never exhausted — a pathological
    // surface that could in principle loop forever chasing `limit`.
    let nextId = 1000;
    mockLog.readLinesBoundedCursor.mockImplementation(async (s: CoordSurface) => {
      if (s !== 'messages') return { rows: [], exhausted: true };
      const id = nextId--;
      return { rows: [{ id, envelope: env({ msg_id: `m${id}`, ts: '2026-06-23T12:00:00.000Z' }) }], exhausted: false };
    });
    mockLog.readEventsBoundedCursor.mockImplementation(async () => ({ rows: [], exhausted: true }));

    const { rows } = await readCoordFeed({ limit: 500, before_ts: '2026-06-24T00:00:00.000Z' });

    // Bounded by MAX_CURSOR_ROUNDS (10): the initial fetchRound() + 9 more
    // deepening iterations of the for-loop, never an unbounded chase of `limit`.
    const messagesCalls = mockLog.readLinesBoundedCursor.mock.calls.filter((c) => c[0] === 'messages');
    expect(messagesCalls).toHaveLength(10);
    expect(rows).toHaveLength(10);
  });

  it('returns a cursor when the bounded deepening ceiling leaves older raw history', async () => {
    const ts = (second: number) => `2026-06-23T12:00:${String(second).padStart(2, '0')}.000Z`;
    const firstPages = Array.from({ length: 10 }, (_, i) => ({
      rows: [{ id: 100 - i, envelope: env({ msg_id: `m${10 - i}`, ts: ts(10 - i) }) }],
      exhausted: false,
    }));
    setLineRounds({ messages: firstPages });
    mockLog.readEventsBoundedCursor.mockImplementation(async () => ({ rows: [], exhausted: true }));

    const first = await readCoordFeed({ limit: 50, before_ts: '2026-06-24T00:00:00.000Z' });

    expect(first.rows.map((r) => r.msg_id)).toEqual([
      'm10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1',
    ]);
    expect(first.total).toBe(10); // shorter than the requested limit; the raw scan is not exhausted
    expect(first.nextCursor).toBe(ts(1));
    expect(first.nextCursorMsgId).toBe('m1');

    // The returned time cursor lets the next request reach the older message
    // that was outside the bounded scan window.
    setLineRounds({ messages: [{ rows: [{ id: 90, envelope: env({ msg_id: 'm0', ts: ts(0) }) }], exhausted: true }] });
    const second = await readCoordFeed({
      limit: 50,
      before_ts: first.nextCursor!,
      before_msg_id: first.nextCursorMsgId!,
    });
    expect(second.rows.map((r) => r.msg_id)).toEqual(['m0']);
    expect(second.nextCursor).toBeNull();
  });

  it('never enters the deepening path when before_ts is omitted, even if a surface reports itself unexhausted', async () => {
    mockLog.readLinesBoundedCursor.mockImplementation(async (s: CoordSurface) =>
      s === 'messages'
        ? { rows: [{ id: 1, envelope: env({ msg_id: 'only' }) }], exhausted: false }
        : { rows: [], exhausted: true },
    );
    mockLog.readEventsBoundedCursor.mockImplementation(async () => ({ rows: [], exhausted: true }));

    await readCoordFeed({ limit: 500 }); // no before_ts

    // Exactly one round total — the common (no before_ts) path never re-checks
    // `exhausted` or re-fetches, matching its pre-WI-3880 cost profile.
    expect(mockLog.readLinesBoundedCursor.mock.calls.filter((c) => c[0] === 'messages')).toHaveLength(1);
  });
});

describe('byKind histogram', () => {
  it('counts the WHOLE filtered set before the page cap', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'a', kind: 'message', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'b', kind: 'message', ts: '2026-06-23T12:00:01.000Z' }),
        env({ msg_id: 'c', kind: 'ack', ts: '2026-06-23T12:00:02.000Z' }),
      ],
    });
    const { rows, byKind, total } = await readCoordFeed({ limit: 1 });
    expect(rows).toHaveLength(1); // page capped
    expect(total).toBe(3);
    expect(byKind).toEqual({ message: 2, ack: 1 }); // histogram unaffected by the cap
  });
});

describe('empty', () => {
  it('returns an empty page + null cursor when no surface has rows', async () => {
    setSurfaces({});
    const { rows, nextCursor, total, byKind } = await readCoordFeed();
    expect(rows).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(total).toBe(0);
    expect(byKind).toEqual({});
  });
});

describe('retraction suppression (coord:retract, WI-4176)', () => {
  const RETRACTS_FIELD = 'retracts'; // mirror of ./retraction — a rename must fail here too

  it('a retracted message disappears from rows/total/byKind; the notice row survives', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'm-bad', summary: 'WRONG directive', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'm-ok', ts: '2026-06-23T12:00:01.000Z' }),
        env({
          msg_id: 'n-1',
          from: 'system:coord-retract',
          related_msg_id: 'm-bad',
          ts: '2026-06-23T12:00:02.000Z',
          [RETRACTS_FIELD]: 'm-bad',
        }),
      ],
    });
    const { rows, total, byKind } = await readCoordFeed();
    expect(rows.map((r) => r.msg_id)).toEqual(['n-1', 'm-ok']); // newest-first, m-bad gone
    expect(total).toBe(2);
    expect(byKind).toEqual({ message: 2 }); // the histogram matches what is shown
  });

  it('includeRetracted:true is the forensic escape hatch — both rows visible', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'm-bad', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'n-1', ts: '2026-06-23T12:00:01.000Z', [RETRACTS_FIELD]: 'm-bad' }),
      ],
    });
    const { rows, total } = await readCoordFeed({ includeRetracted: true });
    expect(rows.map((r) => r.msg_id)).toEqual(['n-1', 'm-bad']);
    expect(total).toBe(2);
  });

  it('markers are collected from the RAW window: a q filter that drops the notice still suppresses its target', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'm-bad', summary: 'the secret directive', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'n-1', summary: 'retraction notice', ts: '2026-06-23T12:00:01.000Z', [RETRACTS_FIELD]: 'm-bad' }),
      ],
    });
    // q matches only the ORIGINAL — the notice falls out of `filtered`, but its
    // marker (collected from the raw tagged window) still suppresses m-bad.
    const { rows, total } = await readCoordFeed({ q: 'secret' });
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});
