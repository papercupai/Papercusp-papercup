import { describe, it, expect, vi, afterEach } from 'vitest';
import { produceLogSnapshot } from '../log-snapshot';
import {
  createMergeCursor,
  findLatestCompleteSnapshotDetailed,
  findLatestSnapshotIndex,
  mergeAdmittedLogsIncremental,
  pinUnknownDurableState,
  seedCursorFromSnapshots,
  SNAPSHOT_JUMP_MIN_BACKLOG_OPS,
  SNAPSHOT_SCAN_LOOKBACK,
  SNAPSHOT_UNREADABLE_RETRY_MS,
  type AdmittedLog,
  type MergeApplyFailure,
  type MergeCursor,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * p2p-join-catchup-speed-2026-09-23 P-004 — bars R-4 and R-5.
 *
 * R-4: the reader finds the newest complete snapshot set at ANY distance from the
 * tail (the old 4,000-op window made an older set invisible), and a cursor far
 * behind that set jumps forward to it when that is safe instead of replaying.
 *
 * R-5: every join path lands on the SAME PG state as a full-history replay. The
 * oracle in every equivalence case below is a single fresh cursor folding every
 * log from index 0.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function put(hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table: 'queue', hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}
function del(hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table: 'queue', hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

interface CountingLog extends OwnLog {
  reads: number[];
  prefetches: Array<[number, number]>;
}

/** In-memory OwnLog + AdmittedLog that records every get and ranged prefetch. */
function memLog(keyHex: string): CountingLog {
  const ops: PeerLogOp[] = [];
  const log: CountingLog = {
    reads: [],
    prefetches: [],
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      log.reads.push(i);
      return ops[i] ?? null;
    },
  };
  (log as unknown as { prefetch(s: number, e: number): void }).prefetch = (s, e) => {
    log.prefetches.push([s, e]);
  };
  return log;
}

type Pg = Map<string, unknown>;
function pgSink(pg: Pg) {
  return async (env: { table?: string; hbKey?: string; type: string; value?: unknown }) => {
    const k = `${env.table}::${env.hbKey}`;
    if (env.type === 'del') pg.delete(k);
    else pg.set(k, env.value);
    return true;
  };
}

/** Fold `logs` into `pg` through `cursor`, `budget` ops per log (0 = everything). */
async function fold(logs: AdmittedLog[], cursor: MergeCursor, pg: Pg, budget = 0): Promise<void> {
  await mergeAdmittedLogsIncremental(logs, cursor, {
    getTimeoutMs: 0,
    maxOpsPerPass: budget,
    applyImpl: pgSink(pg) as never,
  });
}

/** The R-5 oracle: one fresh cursor, every log folded from index 0. */
async function fullReplay(logs: AdmittedLog[]): Promise<Record<string, unknown>> {
  const pg: Pg = new Map();
  await fold(logs, createMergeCursor(), pg);
  return Object.fromEntries(pg);
}

async function appendFiller(log: OwnLog, n: number, tsStart: number, prefix = 'F'): Promise<number> {
  const batch: PeerLogOp[] = [];
  for (let i = 0; i < n; i++) batch.push(put(`${prefix}${i % 50}`, { i }, tsStart + i));
  await log.appendBatch!(batch);
  return tsStart + n;
}

describe('P-004 R-4 — the reader finds a complete set at any distance from the tail', () => {
  it('the default lookback has no floor', () => {
    expect(SNAPSHOT_SCAN_LOOKBACK).toBe(0);
  });

  it('finds a set 10,000 ops behind the tail with the default lookback (the old 4,000-op window missed it)', async () => {
    const log = memLog('a0'.repeat(32));
    await log.append(put('A', { v: 1 }, 1));
    await log.append(put('B', { v: 2 }, 2));
    await produceLogSnapshot(log, { now: 3, schemaVersion: 1 }); // set at index 2
    await appendFiller(log, 10_000, 10);

    // The old bound, passed explicitly, is exactly what used to hide it.
    expect(await findLatestSnapshotIndex(log, 4_000, 0)).toBeNull();
    // Default arguments: unbounded.
    expect(await findLatestSnapshotIndex(log)).toBe(2);

    // A fresh cursor seeded with defaults starts at the set, not at 0, and folds to the oracle.
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor);
    expect(cursor.positions.get(log.keyHex)).toBe(2);
    const pg: Pg = new Map();
    await fold([log], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(await fullReplay([log]));
  });

  it('streams prefetch windows ahead of its reads and never GETs a block below the set it seeds from', async () => {
    const log = memLog('a1'.repeat(32));
    await appendFiller(log, 3_000, 1, 'P');
    const snapAt = log.length;
    await produceLogSnapshot(log, { now: 5_000, schemaVersion: 1, maxChunkBytes: 600 });
    await appendFiller(log, 2_000, 6_000, 'T');
    log.reads.length = 0;
    log.prefetches.length = 0;

    const r = await findLatestCompleteSnapshotDetailed(log);
    expect(r.kind).toBe('found');
    // A sparse joiner has no block below the set, so the scan must never GET one
    // (a speculative get there stalls on a fetch or a timeout).
    expect(Math.min(...log.reads)).toBeGreaterThanOrEqual(snapAt);
    // Speed comes from ranged prefetch hints: growing windows, overshooting the set by
    // at most one max window.
    expect(log.prefetches.length).toBeGreaterThan(1);
    const sizes = log.prefetches.map(([s, e]) => e - s);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
    expect(Math.min(...log.prefetches.map(([s]) => s))).toBeGreaterThanOrEqual(snapAt - 256);
  });

  it('a seed scan that runs out of its time budget RESUMES where it stopped (P-522: the log is held, not folded from 0, meanwhile)', async () => {
    const log = memLog('a3'.repeat(32));
    await log.append(put('A', { v: 1 }, 1));
    await log.append(put('B', { v: 2 }, 2));
    await produceLogSnapshot(log, { now: 3, schemaVersion: 1 }); // set at index 2
    await appendFiller(log, 3_000, 10);
    const tail = log.length;
    // A slow link: every get costs a macrotask.
    const slow: AdmittedLog = {
      keyHex: log.keyHex,
      get length() {
        return log.length;
      },
      get: async (i) => {
        await new Promise<void>((r) => setImmediate(r));
        return log.get(i);
      },
    };
    log.reads.length = 0;
    // The pending line is info (a fresh joiner routinely needs several passes); only a give-up warns.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cursor = createMergeCursor();
    let calls = 0;
    while (!cursor.positions.has(log.keyHex) && calls < 5_000) {
      await seedCursorFromSnapshots([slow], cursor, { getTimeoutMs: 0, scanBudgetMs: 2 });
      calls++;
    }
    expect(calls).toBeGreaterThan(1); // the budget really cut the scan short
    expect(cursor.positions.get(log.keyHex)).toBe(2);
    expect(info.mock.calls.some((c) => String(c[0]).includes('P-522 snapshot seed pending'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('P-522 snapshot seed GAVE UP'))).toBe(false);
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
    // Resume, not restart: every index above the set was read exactly once across all calls.
    const seen = new Map<number, number>();
    for (const i of log.reads) seen.set(i, (seen.get(i) ?? 0) + 1);
    for (let i = 3; i < tail; i++) expect(seen.get(i) ?? 0, `index ${i}`).toBe(1);
  });

  it('the floor option confines the scan: no set at or above the floor → none-in-window', async () => {
    const log = memLog('a2'.repeat(32));
    await log.append(put('A', { v: 1 }, 1));
    await produceLogSnapshot(log, { now: 2, schemaVersion: 1 }); // set at index 1
    await appendFiller(log, 50, 10);
    log.reads.length = 0; // drop the producer's own reads
    const r = await findLatestCompleteSnapshotDetailed(log, 0, 0, { floor: 2 });
    expect(r.kind).toBe('none-in-window');
    expect(Math.min(...log.reads)).toBeGreaterThanOrEqual(2);
  });
});

describe('P-004 R-4 — a far-behind cursor jumps to a complete set ahead of it', () => {
  /**
   * Log A: a prefix with an update and a delete, a snapshot set, then a tail. Log B:
   * a late STALE put for the deleted key (the H-Z1 resurrection shape), so the jump
   * must carry A's tombstone to keep the key absent.
   */
  async function scenario() {
    const a = memLog('b1'.repeat(32));
    await a.append(put('K1', { v: 1 }, 1));
    await a.append(put('GONE', { v: 'x' }, 2));
    let ts = await appendFiller(a, 1_500, 10);
    await a.append(put('K1', { v: 11 }, ts++)); // updated inside the part the jump skips
    await a.append(del('GONE', ts++)); // deleted inside the part the jump skips
    const setAt = a.length;
    await produceLogSnapshot(a, { now: ts++, schemaVersion: 1, maxChunkBytes: 700 });
    ts = await appendFiller(a, 300, ts, 'TAIL');

    const b = memLog('b2'.repeat(32));
    await b.append(put('GONE', { v: 'STALE' }, 5)); // lower clock than A's delete
    await b.append(put('K2', { v: 2 }, 6));
    return { a, b, setAt };
  }

  it('jumps a cursor that folded only a prefix, and lands on the full-replay state', async () => {
    const { a, b, setAt } = await scenario();
    const oracle = await fullReplay([a, b]);
    expect(oracle['queue::GONE']).toBeUndefined();
    expect(oracle['queue::K1']).toEqual({ v: 11 });

    // A peer that folded 100 ops of A and then fell far behind.
    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    await fold([a], cursor, pg, 100);
    expect(cursor.positions.get(a.keyHex)).toBe(100);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(setAt); // jumped
    expect(warn.mock.calls.some((c) => String(c[0]).includes('P-004 snapshot jump'))).toBe(true);

    a.reads.length = 0;
    await fold([a, b], cursor, pg);
    // It did NOT replay the skipped ops [100, setAt).
    expect(a.reads.filter((i) => i >= 100 && i < setAt)).toEqual([]);
    expect(Object.fromEntries(pg)).toEqual(oracle);
  });

  it('CONTROL: a WRONG jump (one past chunk 0) does not match the oracle — the equivalence check has teeth', async () => {
    const { a, b, setAt } = await scenario();
    const oracle = await fullReplay([a, b]);
    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    await fold([a], cursor, pg, 100);
    cursor.positions.set(a.keyHex, setAt + 1); // skips chunk 0's rows: what an off-by-one jump would do
    await fold([a, b], cursor, pg);
    expect(Object.fromEntries(pg)).not.toEqual(oracle);
  });

  it('jumps a cursor pinned at 0 by a clean durable row (lifecycle-created), fold equals the oracle', async () => {
    const { a, b, setAt } = await scenario();
    const oracle = await fullReplay([a, b]);
    const cursor = createMergeCursor();
    cursor.positions.set(a.keyHex, 0); // a clean PG row at 0: no failure recorded
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(setAt);
    const pg: Pg = new Map();
    await fold([a, b], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(oracle);
  });

  it('clears read bookkeeping for positions it skipped, keeps it for positions it did not', async () => {
    const { a, b, setAt } = await scenario();
    const cursor = createMergeCursor();
    cursor.positions.set(a.keyHex, 40);
    cursor.readStalls = new Map([
      [`${a.keyHex}:40`, 7],
      [`${a.keyHex}:${setAt + 5}`, 1],
    ]);
    cursor.readThrows = new Map([[`${a.keyHex}:40`, 2]]);
    cursor.lateReadResults = new Map([[`${a.keyHex}:40`, { kind: 'op', op: null }]]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(setAt);
    expect([...cursor.readStalls.keys()]).toEqual([`${a.keyHex}:${setAt + 5}`]);
    expect(cursor.readThrows.size).toBe(0);
    expect(cursor.lateReadResults.size).toBe(0);
  });

  describe('refuses to jump when it is not safe or not useful', () => {
    it('an unresolved apply failure holds the cursor (it must resolve on the normal path)', async () => {
      const { a, b } = await scenario();
      const cursor = createMergeCursor();
      cursor.positions.set(a.keyHex, 100);
      const failure = {
        position: 100,
        groupKey: 'queue::F3',
        kind: 'retryable',
        reason: 'pg blip',
        attempts: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
      } as unknown as MergeApplyFailure;
      cursor.applyFailures = new Map([[a.keyHex, failure]]);
      await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      expect(cursor.positions.get(a.keyHex)).toBe(100);
    });

    it('an unknown durable failure state (F4 pin) is never skipped, fresh or positioned', async () => {
      const { a, b } = await scenario();
      const cursor = createMergeCursor();
      pinUnknownDurableState(cursor, [a.keyHex, b.keyHex]);
      expect(cursor.positions.get(a.keyHex)).toBe(0);
      expect(cursor.snapshotSkipUnsafe?.has(a.keyHex)).toBe(true);
      await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      expect(cursor.positions.get(a.keyHex)).toBe(0);
    });

    it('pinUnknownDurableState leaves an already-positioned log alone', () => {
      const cursor = createMergeCursor();
      cursor.positions.set('k', 55);
      pinUnknownDurableState(cursor, ['k']);
      expect(cursor.positions.get('k')).toBe(55);
      expect(cursor.snapshotSkipUnsafe?.has('k') ?? false).toBe(false);
    });

    it('a set that EXCLUDES tables (the release-cut head snapshot) is never jumped to; forcing it would lose rows', async () => {
      const a = memLog('b3'.repeat(32));
      await a.append(put('K1', { v: 1 }, 1));
      let ts = await appendFiller(a, 1_200, 10);
      await a.append({ type: 'put', table: 'secret', hbKey: 'S1', value: { s: 1 }, ts: ts++, schema_version: 1, author_pubkey: 'me' });
      const setAt = a.length;
      await produceLogSnapshot(a, { now: ts++, schemaVersion: 1, excludeTables: ['secret'] });
      await appendFiller(a, 1_100, ts, 'T');
      const oracle = await fullReplay([a]);
      expect(oracle['secret::S1']).toEqual({ s: 1 });

      const cursor = createMergeCursor();
      const pg: Pg = new Map();
      await fold([a], cursor, pg, 50);
      await seedCursorFromSnapshots([a], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      expect(cursor.positions.get(a.keyHex)).toBe(50); // refused
      await fold([a], cursor, pg);
      expect(Object.fromEntries(pg)).toEqual(oracle);

      // CONTROL: the jump it refused really would have dropped the excluded row.
      const forced = createMergeCursor();
      const pgForced: Pg = new Map();
      await fold([a], forced, pgForced, 50);
      forced.positions.set(a.keyHex, setAt);
      await fold([a], forced, pgForced);
      expect(pgForced.has('secret::S1')).toBe(false);
    });

    it('a skipped range older than half the tombstone horizon is not jumped over; forcing it would resurrect a deleted row', async () => {
      const DAY = 24 * 60 * 60 * 1000;
      const T0 = 1_700_000_000_000;
      const a = memLog('b4'.repeat(32));
      await a.append(put('K', { v: 'old' }, T0)); // the cursor will have applied this
      const batch: PeerLogOp[] = [];
      for (let i = 0; i < 1_200; i++) batch.push(put(`F${i % 50}`, { i }, T0 + 1 + i));
      await a.appendBatch!(batch);
      await a.append(del('K', T0 + 5_000)); // deleted inside the range a jump would skip
      const setAt = a.length;
      // Produced 15 days later: the DEL's tombstone is past the 14-day horizon and GC'd.
      await produceLogSnapshot(a, { now: T0 + 15 * DAY, schemaVersion: 1 });
      const oracle = await fullReplay([a]);
      expect(oracle['queue::K']).toBeUndefined();

      const cursor = createMergeCursor();
      const pg: Pg = new Map();
      await fold([a], cursor, pg, 1);
      expect(pg.get('queue::K')).toEqual({ v: 'old' });
      await seedCursorFromSnapshots([a], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      expect(cursor.positions.get(a.keyHex)).toBe(1); // refused
      await fold([a], cursor, pg);
      expect(Object.fromEntries(pg)).toEqual(oracle);

      // CONTROL: the jump it refused really would have kept the deleted row.
      const forced = createMergeCursor();
      const pgForced: Pg = new Map();
      await fold([a], forced, pgForced, 1);
      forced.positions.set(a.keyHex, setAt);
      await fold([a], forced, pgForced);
      expect(pgForced.get('queue::K')).toEqual({ v: 'old' });
    });

    it('jumpFarBehind:false restores the fresh-only contract', async () => {
      const { a, b } = await scenario();
      const cursor = createMergeCursor();
      cursor.positions.set(a.keyHex, 100);
      await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpFarBehind: false });
      expect(cursor.positions.get(a.keyHex)).toBe(100);
    });

    it('the DEFAULT threshold: a backlog just under it does not even scan; at it, the cursor jumps', async () => {
      // Ordinary live lag through a write burst is left to the fold. Only a genuinely
      // far-behind cursor (four cadence windows) looks for a set ahead of it.
      expect(SNAPSHOT_JUMP_MIN_BACKLOG_OPS).toBe(4_000);
      const a = memLog('b5'.repeat(32));
      let ts = await appendFiller(a, 500, 1);
      const setAt = a.length;
      await produceLogSnapshot(a, { now: ts++, schemaVersion: 1 });
      await appendFiller(a, SNAPSHOT_JUMP_MIN_BACKLOG_OPS, ts, 'T');
      const cursor = createMergeCursor();
      const near = a.length - (SNAPSHOT_JUMP_MIN_BACKLOG_OPS - 1);
      cursor.positions.set(a.keyHex, near);
      a.reads.length = 0;
      await seedCursorFromSnapshots([a], cursor, { getTimeoutMs: 0 });
      expect(cursor.positions.get(a.keyHex)).toBe(near);
      expect(a.reads).toEqual([]);

      const far = createMergeCursor();
      far.positions.set(a.keyHex, 10);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seedCursorFromSnapshots([a], far, { getTimeoutMs: 0 });
      expect(far.positions.get(a.keyHex)).toBe(setAt);
    });

    it('never rewinds: a cursor already past the newest set stays put', async () => {
      const { a, b, setAt } = await scenario();
      const cursor = createMergeCursor();
      cursor.positions.set(a.keyHex, setAt + 1);
      await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      expect(cursor.positions.get(a.keyHex)).toBe(setAt + 1);
    });
  });

  it('memoizes: a later pass reads only the ops appended since the last scan', async () => {
    const { a, b, setAt } = await scenario();
    const cursor = createMergeCursor();
    cursor.positions.set(a.keyHex, 100);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(setAt);

    // The cursor catches up a little, the writer appends a little. No new set.
    cursor.positions.set(a.keyHex, setAt + 10);
    const before = a.length;
    await appendFiller(a, 20, 90_000, 'NEW');
    a.reads.length = 0;
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(setAt + 10);
    expect(a.reads.length).toBeGreaterThan(0);
    expect(Math.min(...a.reads)).toBeGreaterThanOrEqual(before);

    // Nothing appended at all: no reads.
    a.reads.length = 0;
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(a.reads).toEqual([]);
  });

  it('finds a NEWER set that appears later while the cursor is still behind', async () => {
    const { a, b } = await scenario();
    const cursor = createMergeCursor();
    cursor.positions.set(a.keyHex, 100);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    const firstJump = cursor.positions.get(a.keyHex)!;

    let ts = 200_000;
    ts = await appendFiller(a, 1_200, ts, 'MORE');
    await a.append(put('K1', { v: 111 }, ts++));
    const secondSet = a.length;
    await produceLogSnapshot(a, { now: ts++, schemaVersion: 1, maxChunkBytes: 700 });
    await appendFiller(a, 50, ts, 'END');

    await seedCursorFromSnapshots([a, b], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get(a.keyHex)).toBe(secondSet);
    expect(secondSet).toBeGreaterThan(firstJump);

    const pg: Pg = new Map();
    // Replay what the jumping peer would already hold (prefix up to 100), then fold on.
    const prefixCursor = createMergeCursor();
    await fold([a], prefixCursor, pg, 100);
    await fold([a, b], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(await fullReplay([a, b]));
  });

  it('an unreadable tail block: no jump, no retry for SNAPSHOT_UNREADABLE_RETRY_MS even as the log grows, then it jumps', async () => {
    const { a, b, setAt } = await scenario();
    let hang = a.length - 1;
    const gated: AdmittedLog = {
      keyHex: a.keyHex,
      get length() {
        return a.length;
      },
      get: (i) => (i === hang ? new Promise<PeerLogOp | null>(() => {}) : a.get(i)),
    };
    const cursor = createMergeCursor();
    cursor.positions.set(a.keyHex, 100);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { getTimeoutMs: 20, jumpMinBacklogOps: 1 };
    await seedCursorFromSnapshots([gated, b], cursor, opts);
    expect(cursor.positions.get(a.keyHex)).toBe(100);

    // A log still being written grows every pass. Growth alone must not re-pay the timeout.
    hang = -1;
    await a.append(put('LATE', { v: 1 }, 999_999));
    a.reads.length = 0;
    await seedCursorFromSnapshots([gated, b], cursor, opts);
    expect(a.reads).toEqual([]);
    expect(cursor.positions.get(a.keyHex)).toBe(100);

    // Past the retry interval it scans again and jumps.
    const later = Date.now() + SNAPSHOT_UNREADABLE_RETRY_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await seedCursorFromSnapshots([gated, b], cursor, opts);
    expect(cursor.positions.get(a.keyHex)).toBe(setAt);
  });
});

describe('P-004 R-5 — seeded fuzz: every start position folds to the full-replay state', () => {
  /** Tiny deterministic PRNG (mulberry32) so a failure names a reproducible seed. */
  function rng(seed: number) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const logs = [memLog(`c${seed % 10}`.repeat(32).slice(0, 64)), memLog(`d${seed % 10}`.repeat(32).slice(0, 64))];
      // One global clock, increasing within every log (a single writer's HLC is monotonic),
      // interleaved across logs so cross-log LWW is exercised.
      let ts = 1;
      for (let step = 0; step < 2_400; step++) {
        const log = logs[rand() < 0.6 ? 0 : 1]!;
        const key = `K${Math.floor(rand() * 40)}`;
        if (rand() < 0.2) await log.append(del(key, ts++));
        else await log.append(put(key, { step, by: log.keyHex.slice(0, 2) }, ts++));
        if (rand() < 0.002) await produceLogSnapshot(log, { now: ts++, schemaVersion: 1, maxChunkBytes: 900 });
      }
      for (const log of logs) await produceLogSnapshot(log, { now: ts++, schemaVersion: 1, maxChunkBytes: 900 });
      for (let step = 0; step < 150; step++) {
        const log = logs[rand() < 0.5 ? 0 : 1]!;
        await log.append(put(`K${Math.floor(rand() * 40)}`, { tail: step }, ts++));
      }

      const oracle = await fullReplay(logs);

      // A peer that folded a random prefix of each log, then fell behind and jumps.
      const cursor = createMergeCursor();
      const pg: Pg = new Map();
      for (const log of logs) await fold([log], cursor, pg, 1 + Math.floor(rand() * 300));
      const before = logs.map((l) => cursor.positions.get(l.keyHex)!);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seedCursorFromSnapshots(logs, cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
      const after = logs.map((l) => cursor.positions.get(l.keyHex)!);
      expect(after.some((p, i) => p > before[i]!)).toBe(true); // at least one log really jumped
      await fold(logs, cursor, pg);
      expect(Object.fromEntries(pg)).toEqual(oracle);

      // A fresh joiner seeded from the newest sets also matches.
      const fresh = createMergeCursor();
      const pgFresh: Pg = new Map();
      await seedCursorFromSnapshots(logs, fresh, { getTimeoutMs: 0 });
      await fold(logs, fresh, pgFresh);
      expect(Object.fromEntries(pgFresh)).toEqual(oracle);
    });
  }
});
