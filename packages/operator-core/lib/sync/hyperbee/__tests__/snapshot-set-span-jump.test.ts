/**
 * snapshot-set-span-jump.test.ts — p2p-join-catchup-speed-2026-09-23 P-533 (D-028 #2).
 *
 * A cursor that SKIPS a snapshot set (it already folded the set's prefix op by op) must
 * not download the set just to skip it:
 *   1. The fold reads the first chunk it meets and the set's LAST block, then crosses the
 *      rest in one step and lands exactly where the chunk-by-chunk skip lands.
 *   2. A last block that is not the set's last chunk (so something else sits inside the
 *      span) refuses the jump; a last block that does not arrive in time stops the pass
 *      one past the chunk it skipped; a pass budget inside the set clamps the jump.
 *   3. A set the cursor OWES, or one met after an unreadable chunk 0, still applies row by
 *      row, reading every chunk.
 *   4. The look-ahead cancels its reads of a skipped set's span, keeping the two blocks the
 *      jump reads, and cancels nothing for a set the cursor owes.
 *   5. The pass's EI-92 range never streams a skipped set: a pass that opens on one starts
 *      its range at the set's end, and a jump withdraws a range that overlaps the set and
 *      re-opens it where the jump lands. A set the cursor owes keeps its range (rig
 *      2026-09-25 08:07Z: the range fetched about 2 GB for a two-chunk crossing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshotOps, type SnapshotPayload } from '../log-snapshot';
import {
  STORED_ORDER_PEEK_CONCURRENCY,
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  type AdmittedLog,
  type CancellableRead,
  type IncrementalMergeOpts,
  type IncrementalMergeResult,
  type MergeCursor,
  type PrefetchRange,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';

const KEY = 'cd'.repeat(32);

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function put(hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table: 'queue', hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

interface SpanLog extends AdmittedLog {
  ops: PeerLogOp[];
  /** Every non-snapshot op, in log order: what the history-only oracle folds. */
  history: PeerLogOp[];
  /** Positions the FOLD read with `get`, in order. */
  reads: number[];
  /** Look-ahead reads (`getCancellable`) that delivered their block, and that were cancelled. */
  fetched: Set<number>;
  cancelled: Set<number>;
  /** Every position a look-ahead read was ISSUED for (WI-10005291: issued, not fetched). */
  requested: Set<number>;
  getCancellable?(i: number): CancellableRead;
  /** Ranged prefetches (EI-92) requested, in order, and whether each was withdrawn. */
  ranges: { start: number; end: number; cancelled: boolean }[];
  prefetch?(start: number, end: number): PrefetchRange | undefined;
}

interface SpanLogOpts {
  /** Reads of these positions resolve null (a version-gated drop). */
  unreadable?: Set<number>;
  /** The first `get` of each position here takes that many ms. */
  slowOnce?: Map<number, number>;
  /** Offer `getCancellable`, as a RemoteLog does. Its blocks arrive in position order. */
  cancellable?: boolean;
  /** Offer a withdrawable ranged `prefetch`, as a RemoteLog does. */
  prefetchable?: boolean;
  /** Chunk size for the set `logWithSet` builds (default 2,000 bytes: a few chunks). */
  maxChunkBytes?: number;
}

function spanLog(opts: SpanLogOpts = {}): SpanLog {
  const read = (i: number): PeerLogOp | null => (opts.unreadable?.has(i) ? null : (log.ops[i] ?? null));
  const log: SpanLog = {
    ops: [],
    history: [],
    reads: [],
    fetched: new Set(),
    cancelled: new Set(),
    requested: new Set(),
    ranges: [],
    get keyHex() {
      return KEY;
    },
    get length() {
      return log.ops.length;
    },
    async get(i: number) {
      log.reads.push(i);
      const ms = opts.slowOnce?.get(i);
      if (ms !== undefined) {
        opts.slowOnce!.delete(i);
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return read(i);
    },
  };
  if (opts.cancellable) {
    log.getCancellable = (i: number): CancellableRead => {
      log.requested.add(i);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reject: (err: Error) => void = () => {};
      const op = new Promise<PeerLogOp | null>((resolve, rej) => {
        reject = rej;
        timer = setTimeout(() => {
          log.fetched.add(i);
          resolve(read(i));
        }, 1);
      });
      return {
        op,
        cancel() {
          if (log.fetched.has(i) || log.cancelled.has(i)) return;
          clearTimeout(timer);
          log.cancelled.add(i);
          reject(new Error('REQUEST_CANCELLED'));
        },
      };
    };
  }
  if (opts.prefetchable) {
    log.prefetch = (start: number, end: number): PrefetchRange => {
      const r = { start, end, cancelled: false };
      log.ranges.push(r);
      return {
        cancel() {
          r.cancelled = true;
        },
      };
    };
  }
  return log;
}

/** 200 live keys, a multi-chunk set over them, then a 10-op tail. */
function logWithSet(opts: SpanLogOpts = {}): { log: SpanLog; c: number; n: number; rows: number } {
  const log = spanLog(opts);
  const append = (op: PeerLogOp): void => {
    log.ops.push(op);
    log.history.push(op);
  };
  for (let i = 0; i < 200; i++) append(put(`K${i}`, { v: i }, 1 + i));
  const c = log.ops.length;
  const set = buildSnapshotOps({
    ops: log.history,
    coversUpTo: c,
    author_pubkey: 'me',
    ts: 1_000_000,
    schema_version: 1,
    maxChunkBytes: opts.maxChunkBytes ?? 2_000,
  });
  log.ops.push(...set);
  for (let i = 0; i < 10; i++) append(put(`T${i}`, { v: i }, 10_000 + i));
  const rows = set.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
  return { log, c, n: set.length, rows };
}

type Pg = Map<string, unknown>;

async function fold(
  log: AdmittedLog,
  cursor: MergeCursor,
  pg: Pg,
  extra: Partial<IncrementalMergeOpts> = {},
): Promise<IncrementalMergeResult & { applies: number }> {
  let applies = 0;
  const res = await mergeAdmittedLogsIncremental([log], cursor, {
    getTimeoutMs: 0,
    applyImpl: (async (env: { table?: string; hbKey?: string; type: string; value?: unknown }) => {
      applies++;
      const k = `${env.table}::${env.hbKey}`;
      if (env.type === 'del') pg.delete(k);
      else pg.set(k, env.value);
      return true;
    }) as never,
    ...extra,
  });
  return { ...res, applies };
}

/** The history-only oracle: every non-snapshot op folded from 0, no set involved. */
async function historyOracle(log: SpanLog): Promise<Record<string, unknown>> {
  const bare = spanLog();
  bare.ops.push(...log.history);
  const pg: Pg = new Map();
  await fold(bare, createMergeCursor(), pg);
  return Object.fromEntries(pg);
}

/** A reader converged on `[0, c)`: it folded the prefix op by op, so the set is redundant. */
async function converged(log: SpanLog, c: number, extra: Partial<IncrementalMergeOpts> = {}): Promise<{ cursor: MergeCursor; pg: Pg }> {
  const cursor = createMergeCursor();
  const pg: Pg = new Map();
  await fold(log, cursor, pg, { ...extra, maxOpsPerPass: c });
  expect(cursor.positions.get(KEY)).toBe(c);
  log.reads.length = 0;
  log.fetched.clear();
  log.cancelled.clear();
  log.requested.clear();
  log.ranges.length = 0;
  return { cursor, pg };
}

/** The same reader after a restart: its position survives, its in-memory winners do not,
 *  so set rows are not dropped as stale against them. `owes` marks the set as owed. */
function restarted(c: number, owes: boolean): MergeCursor {
  const cursor = createMergeCursor();
  cursor.positions.set(KEY, c);
  if (owes) cursor.snapshotApplyThrough = new Map([[KEY, c]]);
  return cursor;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, k) => from + k);
const logged = (spy: ReturnType<typeof vi.spyOn>, text: string): boolean =>
  spy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

describe('P-533: a skipped set is crossed in one step', () => {
  it('reads only the first and last chunk, and lands where the chunk-by-chunk skip lands', async () => {
    const { log, c, n } = logWithSet();
    expect(n).toBeGreaterThanOrEqual(5);
    const { cursor, pg } = await converged(log, c);

    const res = await fold(log, cursor, pg);
    expect(log.reads.filter((p) => p >= c && p < c + n)).toEqual([c, c + n - 1]);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(res.applies).toBe(10); // the tail only; no set row
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(logged(infoSpy, `set@${c}: SKIPPED ${n} chunk(s) (${n - 1} crossed in one step, P-533)`)).toBe(true);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a set the cursor OWES still applies row by row, reading every chunk', async () => {
    const { log, c, n, rows } = logWithSet();
    const { pg } = await converged(log, c);
    const cursor = restarted(c, true);

    const res = await fold(log, cursor, pg);
    expect(res.snapshotChunksJumped).toBe(0);
    expect(log.reads.filter((p) => p >= c && p < c + n)).toEqual(range(c, c + n));
    expect(res.applies).toBe(rows + 10);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a set whose chunk 0 is unreadable is applied from chunk 1 on, not jumped', async () => {
    const { log, c, n } = logWithSet();
    const { pg } = await converged(log, c);
    const cursor = restarted(c, false);
    const unreadable = new Set([c]);
    const gated: AdmittedLog = {
      keyHex: KEY,
      get length() {
        return log.length;
      },
      get: async (i: number) => (unreadable.has(i) ? (log.reads.push(i), null) : log.get(i)),
    };

    const res = await fold(gated, cursor, pg);
    expect(res.snapshotChunksJumped).toBe(0);
    expect(log.reads.filter((p) => p >= c && p < c + n)).toEqual(range(c, c + n));
    expect(res.applies).toBeGreaterThan(10); // chunks 1..n-1 applied (the hole promotes the set)
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('an op inside the claimed span refuses the jump, and that op is applied', async () => {
    const { log, c, n } = logWithSet();
    const intruder = put('X', { v: 'inside' }, 50_000);
    log.ops.splice(c + 2, 0, intruder); // the set now spans c+n+1 positions
    log.history.splice(200, 0, intruder);
    const { cursor, pg } = await converged(log, c);

    const res = await fold(log, cursor, pg);
    expect(res.snapshotChunksJumped).toBe(0);
    expect(pg.get('queue::X')).toEqual({ v: 'inside' });
    expect(logged(warnSpy, 'P-533 jump refused')).toBe(true);
    expect(log.reads.filter((p) => p >= c && p <= c + n)).toContain(c + 2);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a last chunk that does not arrive in time stops the pass one past the skipped chunk; the next pass jumps', async () => {
    const { log, c, n } = logWithSet({ slowOnce: new Map() });
    const { cursor, pg } = await converged(log, c);
    const slow = spanLog({ slowOnce: new Map([[c + n - 1, 300]]) });
    slow.ops = log.ops;
    slow.history = log.history;

    const first = await fold(slow, cursor, pg, { getTimeoutMs: 50 });
    expect(first.snapshotChunksJumped).toBe(0);
    expect(first.caughtUp).toBe(false);
    expect(cursor.positions.get(KEY)).toBe(c + 1);
    expect(logged(infoSpy, `its last chunk #${c + n - 1} was not read`)).toBe(true);

    const second = await fold(slow, cursor, pg, { getTimeoutMs: 50 });
    expect(second.snapshotChunksJumped).toBe(n - 2);
    expect(cursor.positions.get(KEY)).toBe(slow.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a pass budget that ends inside the set clamps the jump; the next pass finishes the set', async () => {
    const { log, c, n } = logWithSet();
    const { cursor, pg } = await converged(log, c);

    const first = await fold(log, cursor, pg, { maxOpsPerPass: 2 });
    expect(first.snapshotChunksJumped).toBe(1);
    expect(cursor.positions.get(KEY)).toBe(c + 2);
    expect(first.applies).toBe(0);

    const second = await fold(log, cursor, pg);
    expect(second.snapshotChunksJumped).toBe(n - 3);
    expect(log.reads.filter((p) => p >= c && p < c + n)).toEqual([c, c + n - 1, c + 2, c + n - 1]);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });
});

describe('P-533: the look-ahead does not fetch a skipped set', () => {
  const lookAhead: Partial<IncrementalMergeOpts> = { skipSuperseded: () => true };

  it('cancels its reads of the span, keeping the fold\'s next chunk and the set\'s last block', async () => {
    const { log, c, n } = logWithSet({ cancellable: true });
    const { cursor, pg } = await converged(log, c, lookAhead);

    const res = await fold(log, cursor, pg, lookAhead);
    expect([...log.cancelled].sort((a, b) => a - b)).toEqual(range(c + 1, c + n - 1));
    expect([...log.fetched].filter((p) => p >= c && p < c + n).sort((a, b) => a - b)).toEqual([c, c + n - 1]);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('CONTROL: for a set the cursor owes it cancels nothing (the reads are the crossing\'s prefetch)', async () => {
    const { log, c, n, rows } = logWithSet({ cancellable: true });
    const { pg } = await converged(log, c, lookAhead);
    const cursor = restarted(c, true);

    const res = await fold(log, cursor, pg, lookAhead);
    expect(log.cancelled.size).toBe(0);
    expect([...log.fetched].filter((p) => p >= c && p < c + n)).toHaveLength(n);
    expect(res.applies).toBe(rows + 10);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  // WI-10005291: cancelling withdraws only a network request. On a LOCAL log (the own log)
  // an issued read is a storage read, so the bound is on what the look-ahead ISSUES: the
  // tower read ~4 GB per skipped set when the whole 2048-op window went out at once.
  it('a LOCAL log (no cancellable reads): the look-ahead issues at most the concurrency bound into a skipped span', async () => {
    const { log, c, n } = logWithSet({ maxChunkBytes: 1 });
    expect(n - 2).toBeGreaterThan(4 * STORED_ORDER_PEEK_CONCURRENCY); // the fixture can tell bounded from unbounded
    const { cursor, pg } = await converged(log, c, lookAhead);

    const res = await fold(log, cursor, pg, lookAhead);
    const inSpan = log.reads.filter((p) => p > c && p < c + n - 1);
    expect(inSpan.length).toBeLessThanOrEqual(STORED_ORDER_PEEK_CONCURRENCY);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a REMOTE log: reads it never issues need no cancelling; at most the bound reach the span', async () => {
    const { log, c, n } = logWithSet({ cancellable: true, maxChunkBytes: 1 });
    expect(n - 2).toBeGreaterThan(4 * STORED_ORDER_PEEK_CONCURRENCY);
    const { cursor, pg } = await converged(log, c, lookAhead);

    const res = await fold(log, cursor, pg, lookAhead);
    const span = range(c + 1, c + n - 1);
    expect(span.filter((p) => log.requested.has(p)).length).toBeLessThanOrEqual(STORED_ORDER_PEEK_CONCURRENCY);
    expect(span.filter((p) => log.fetched.has(p))).toEqual([]);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('CONTROL: the bound does not shrink coverage: every op of a window with no set is still peeked', async () => {
    const { log, c, n } = logWithSet({ cancellable: true });
    const { cursor, pg } = await converged(log, c, lookAhead);
    await fold(log, cursor, pg, lookAhead);
    // The look-ahead opened at c and covered the whole tail past the set.
    expect(range(c + n, log.length).every((p) => log.requested.has(p))).toBe(true);
  });
});

describe('P-533: the pass range does not stream a skipped set', () => {
  it('a converged cursor that meets the set first opens its range at the set\'s end', async () => {
    const { log, c, n } = logWithSet({ prefetchable: true });
    const { cursor, pg } = await converged(log, c);

    const res = await fold(log, cursor, pg);
    expect(log.ranges).toEqual([{ start: c + n, end: log.length, cancelled: false }]);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('a cursor a few ops behind withdraws the range the jump crosses and re-opens it where it lands', async () => {
    const { log, c, n } = logWithSet({ prefetchable: true });
    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    await fold(log, cursor, pg, { maxOpsPerPass: c - 3 });
    log.ranges.length = 0;

    const res = await fold(log, cursor, pg);
    expect(log.ranges).toEqual([
      { start: c - 3, end: log.length, cancelled: true },
      { start: c + n, end: log.length, cancelled: false },
    ]);
    expect(res.snapshotChunksJumped).toBe(n - 1);
    expect(cursor.positions.get(KEY)).toBe(log.length);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('CONTROL: a set the cursor owes keeps one range over the whole window', async () => {
    const { log, c, rows } = logWithSet({ prefetchable: true });
    const { pg } = await converged(log, c);
    const cursor = restarted(c, true);

    const res = await fold(log, cursor, pg);
    expect(log.ranges).toEqual([{ start: c, end: log.length, cancelled: false }]);
    expect(res.applies).toBe(rows + 10);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });
});
