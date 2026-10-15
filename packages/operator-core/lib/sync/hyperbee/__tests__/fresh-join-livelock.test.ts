import { isDeepStrictEqual } from 'node:util';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { produceLogSnapshot } from '../log-snapshot';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  rewindMergeCursor,
  seedCursorFromSnapshots,
  SNAPSHOT_SEED_DEFER_MAX_MS,
  SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS,
  SNAPSHOT_UNREADABLE_RETRY_MS,
  type AdmittedLog,
  type MergeCursor,
} from '../read-merge';
import { DeferralEvictionReFold } from '../eviction-refold';
import { PendingEpochContent } from '../pending-epoch-content';
import { PendingMembershipContent } from '../pending-membership-content';
import { drainQueuedEpochContent, type DrainedEpoch } from '../hive-epoch-op-gate';
import type { OwnLog, PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * p2p-join-catchup-speed-2026-09-23 P-522 (WI-10002899): the fresh-join livelock found by
 * P-007 run #1 on the Mac VM. Two halves, each pinned here against the behaviour it
 * replaced:
 *
 *  (a) A fresh log whose seed scan runs out of budget used to start folding at 0. Once
 *      positioned, only the P-004 jump can reach a set, and the jump refuses a skipped
 *      range older than half the tombstone horizon, so the seed was lost for good.
 *  (b) A content-deferral eviction used to reset the cursor on the very next pass. A
 *      joiner whose epoch key sits near the tail defers more than the buffer holds on
 *      every pass, so it restarted forever and never reached the key.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function op(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'tower' };
}

interface CountingLog extends OwnLog {
  reads: number[];
}

function memLog(keyHex: string): CountingLog {
  const ops: PeerLogOp[] = [];
  const log: CountingLog = {
    reads: [],
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(o: PeerLogOp) {
      ops.push(o);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      log.reads.push(i);
      return ops[i] ?? null;
    },
  };
  return log;
}

/** Every get costs a macrotask, so a small scan budget really runs out (a remote link). */
function slowView(log: CountingLog): AdmittedLog {
  return {
    keyHex: log.keyHex,
    get length() {
      return log.length;
    },
    get: async (i) => {
      await new Promise<void>((r) => setImmediate(r));
      return log.get(i);
    },
  };
}

type Pg = Map<string, unknown>;

async function fullReplay(log: AdmittedLog): Promise<Record<string, unknown>> {
  const pg: Pg = new Map();
  await mergeAdmittedLogsIncremental([log], createMergeCursor(), {
    getTimeoutMs: 0,
    maxOpsPerPass: 0,
    applyImpl: (async (env: OpEnvelope) => {
      pg.set(`${env.table}::${env.hbKey}`, env.value);
      return true;
    }) as never,
  });
  return Object.fromEntries(pg);
}

/**
 * A tower log shaped like 5b00878b: an OLD prefix (August), a complete set produced 15
 * days later (so the prefix is past half the tombstone horizon), then a tail.
 */
async function towerWithOldPrefix(keyHex: string, prefixOps: number, tailOps: number) {
  const log = memLog(keyHex);
  const batch: PeerLogOp[] = [];
  for (let i = 0; i < prefixOps; i++) batch.push(op('queue', `P${i % 40}`, { i }, T0 + i));
  await log.appendBatch!(batch);
  const setAt = log.length;
  await produceLogSnapshot(log, { now: T0 + 15 * DAY, schemaVersion: 1, maxChunkBytes: 700 });
  const tail: PeerLogOp[] = [];
  for (let i = 0; i < tailOps; i++) tail.push(op('queue', `T${i % 20}`, { i }, T0 + 15 * DAY + 1 + i));
  await log.appendBatch!(tail);
  return { log, setAt };
}

describe('P-522 (a): an inconclusive fresh seed scan holds the log instead of folding it from 0', () => {
  /** Boot's pass order: seed (budgeted), then fold (budgeted). Returns the passes run. */
  async function joinPasses(view: AdmittedLog, cursor: MergeCursor, pg: Pg, seedDeferMaxMs?: number) {
    const applyImpl = (async (env: OpEnvelope) => {
      pg.set(`${env.table}::${env.hbKey}`, env.value);
      return true;
    }) as never;
    let passes = 0;
    while (passes < 400) {
      await seedCursorFromSnapshots([view], cursor, {
        getTimeoutMs: 0,
        scanBudgetMs: 2,
        ...(seedDeferMaxMs !== undefined ? { seedDeferMaxMs } : {}),
      });
      const r = await mergeAdmittedLogsIncremental([view], cursor, { getTimeoutMs: 0, maxOpsPerPass: 100, applyImpl });
      passes++;
      if (r.caughtUp && cursor.positions.get(view.keyHex) === view.length) break;
    }
    return passes;
  }

  it('the held log seeds at the complete set once the resumed scan finds it, and never folds a prefix op', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log, setAt } = await towerWithOldPrefix('e1'.repeat(32), 600, 1_500);
    const view = slowView(log);
    const oracle = await fullReplay(log);
    log.reads.length = 0;

    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    const passes = await joinPasses(view, cursor, pg);

    expect(passes).toBeGreaterThan(1); // the budget really cut the scan short at least once
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0); // released once conclusive
    expect(Math.min(...log.reads)).toBeGreaterThanOrEqual(setAt); // no op below the set was read
    expect(Object.fromEntries(pg)).toEqual(oracle);
  });

  it('CONTROL (the pre-P-522 behaviour, seedDeferMaxMs 0): the same join folds from 0 and the seed is lost for good', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log, setAt } = await towerWithOldPrefix('e2'.repeat(32), 600, 1_500);
    const view = slowView(log);
    const oracle = await fullReplay(log);
    log.reads.length = 0;

    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    await joinPasses(view, cursor, pg, 0);

    // It replayed the whole prefix op by op: the jump was refused (prefix older than half
    // the tombstone horizon), so the set it scanned for bought nothing.
    const foldedPrefix = new Set(log.reads.filter((i) => i < setAt));
    expect(foldedPrefix.size).toBe(setAt);
    expect(Object.fromEntries(pg)).toEqual(oracle); // correct, just the slow way
  });

  it('a held log is skipped by the fold (it gets no position and the pass is not caught up)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { log } = await towerWithOldPrefix('e3'.repeat(32), 300, 1_500);
    const view = slowView(log);
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([view], cursor, { getTimeoutMs: 0, scanBudgetMs: 1 });
    expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true);
    log.reads.length = 0;
    const r = await mergeAdmittedLogsIncremental([view], cursor, {
      getTimeoutMs: 0,
      applyImpl: (async () => true) as never,
    });
    expect(cursor.positions.has(log.keyHex)).toBe(false);
    expect(log.reads).toEqual([]);
    expect(r.caughtUp).toBe(false);
  });

  it('a CONCLUSIVE "no complete set" folds from 0 at once (nothing is held)', async () => {
    const log = memLog('e4'.repeat(32));
    await log.appendBatch!(Array.from({ length: 200 }, (_, i) => op('queue', `N${i % 10}`, { i }, T0 + i)));
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor, { getTimeoutMs: 0 });
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
    expect(cursor.positions.has(log.keyHex)).toBe(false); // unpositioned but NOT held
    await mergeAdmittedLogsIncremental([log], cursor, { getTimeoutMs: 0, applyImpl: (async () => true) as never });
    expect(cursor.positions.get(log.keyHex)).toBe(200);
  });

  it('a tail op that READS as null (the version gate dropped it) is conclusive: an old peer folds from 0 at once, not held', async () => {
    const log = memLog('e6'.repeat(32));
    await log.appendBatch!(Array.from({ length: 50 }, (_, i) => op('queue', `V${i % 10}`, { i }, T0 + i)));
    await produceLogSnapshot(log, { now: T0 + 100, schemaVersion: 1 });
    // An old build's version gate drops the newer-schema snapshot op: it reads as null.
    const gated: AdmittedLog = {
      keyHex: log.keyHex,
      get length() {
        return log.length;
      },
      get: async (i) => (i >= 50 ? null : log.get(i)),
    };
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([gated], cursor, { getTimeoutMs: 0 });
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
    // Still conclusive when the unreadable memo answers the next pass.
    await seedCursorFromSnapshots([gated], cursor, { getTimeoutMs: 0 });
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
    await mergeAdmittedLogsIncremental([gated], cursor, { getTimeoutMs: 0, applyImpl: (async () => true) as never });
    expect(cursor.positions.get(log.keyHex)).toBe(log.length);
  });

  it('a scan stuck on an UNREADABLE block gives up after the shorter bound and folds from 0', async () => {
    expect(SNAPSHOT_SEED_DEFER_MAX_MS).toBe(30 * 60_000);
    expect(SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS).toBe(3 * 60_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = memLog('e5'.repeat(32));
    await log.appendBatch!(Array.from({ length: 100 }, (_, i) => op('queue', `G${i % 10}`, { i }, T0 + i)));
    // The tail block never answers: every scan is `unreadable`, never conclusive.
    const view: AdmittedLog = {
      keyHex: log.keyHex,
      get length() {
        return log.length;
      },
      get: (i) => (i === log.length - 1 ? new Promise<PeerLogOp | null>(() => {}) : log.get(i)),
    };
    const cursor = createMergeCursor();
    const opts = { getTimeoutMs: 5 }; // default seedDeferMaxMs (30 min)
    await seedCursorFromSnapshots([view], cursor, opts);
    expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true);

    const start = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(start + SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS - 1_000); // still inside the bound
    await seedCursorFromSnapshots([view], cursor, opts);
    expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true);
    now.mockReturnValue(start + SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS + 1);
    await seedCursorFromSnapshots([view], cursor, opts);
    expect(cursor.snapshotSeedPending?.has(log.keyHex) ?? false).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('P-522 snapshot seed GAVE UP'))).toBe(true);
    await mergeAdmittedLogsIncremental([view], cursor, {
      getTimeoutMs: 5,
      maxOpsPerPass: 10,
      applyImpl: (async () => true) as never,
    });
    expect(cursor.positions.get(log.keyHex)).toBe(10); // folding from 0
  });

  /** A view whose reads of the indices in `hangOnce` never answer, once each (a timeout). */
  function hangingOnceView(log: CountingLog, slow: boolean): { view: AdmittedLog; hangOnce: Set<number> } {
    const hangOnce = new Set<number>();
    const view: AdmittedLog = {
      keyHex: log.keyHex,
      get length() {
        return log.length;
      },
      get: async (i) => {
        if (hangOnce.delete(i)) return new Promise<PeerLogOp | null>(() => {});
        if (slow) await new Promise<void>((r) => setImmediate(r));
        return log.get(i);
      },
    };
    return { view, hangOnce };
  }

  /** `Date.now` running at real speed plus a settable offset (the budget still needs a live clock). */
  function offsetClock() {
    const realNow = Date.now.bind(Date);
    const clock = { offset: 0 };
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock.offset);
    return clock;
  }

  /**
   * Run seed passes until `view` seeds, at most `maxPasses` of them.
   *
   * These tests pair a 5 ms wall-clock read timeout with the offset clock above. On a loaded
   * machine an ordinary read can miss its 5 ms bound with no hang at all (WI-10008296: the
   * gate's lane-stateful leg failed this way at 35bdf177 while it passed locally). The miss
   * parks that block for SNAPSHOT_UNREADABLE_RETRY_MS. The offset clock moves only at real
   * speed, so it never reaches that retry by itself, and every later pass does nothing.
   * So whenever a pass stops on an unreadable block, move the clock past one retry, which is
   * what production time would do. The 3-min stuck bound counts only repeats on the SAME
   * block, so a stray miss on another block does not move a test toward a give-up.
   */
  async function seedUntilSeeded(
    view: AdmittedLog,
    cursor: ReturnType<typeof createMergeCursor>,
    opts: Parameters<typeof seedCursorFromSnapshots>[2],
    clock: { offset: number },
    maxPasses = 400,
  ): Promise<void> {
    for (let pass = 0; pass < maxPasses && !cursor.positions.has(view.keyHex); pass++) {
      await seedCursorFromSnapshots([view], cursor, opts);
      if (cursor.snapshotScans?.get(view.keyHex)?.unreadableAtLength !== undefined) {
        clock.offset += SNAPSHOT_UNREADABLE_RETRY_MS + 1_000;
      }
    }
  }

  it('P-007 run #2: ONE read timeout after a long budget-only hold does not give up (the hold age is not a stuck block)', async () => {
    // Measured on mac-vm 08:25:05-08:29:04Z: the hold engaged on the 30-min bound (budget),
    // one scan read then missed its 5 s bound, and the 3-min UNREADABLE bound, measured from
    // the start of the hold (239 s), gave up at once. The joiner folded 7.76M ops from 0.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log, setAt } = await towerWithOldPrefix('e7'.repeat(32), 600, 1_500);
    const { view, hangOnce } = hangingOnceView(log, true);
    const cursor = createMergeCursor();
    const opts = { getTimeoutMs: 5, scanBudgetMs: 2 };
    const clock = offsetClock();

    await seedCursorFromSnapshots([view], cursor, opts);
    expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true); // budget-inconclusive: held
    const resumeBelow = cursor.snapshotScans?.get(log.keyHex)?.resumeBelow;
    expect(resumeBelow).toBeGreaterThan(setAt); // the set is still below the scan

    clock.offset = 4 * 60_000; // past the 3-min unreadable bound, inside the 30-min one
    hangOnce.add(resumeBelow! - 1); // the very next block the resumed scan reads times out once
    // From here on the budget is unbounded. The hold above is already a budget hold, and a
    // 2 ms budget checked before the first read can stop a pass before it reaches the hanging
    // block on a loaded machine (WI-10008296).
    const resumeOpts = { ...opts, scanBudgetMs: 0 };
    await seedCursorFromSnapshots([view], cursor, resumeOpts);
    expect(cursor.snapshotScans?.get(log.keyHex)?.unreadableAtLength).toBeDefined(); // it WAS unreadable
    expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true); // ...and still held
    expect(warn.mock.calls.some((c) => String(c[0]).includes('P-522 snapshot seed GAVE UP'))).toBe(false);
    // The hold reports how far the scan got, and the block it stopped on (run #2 had neither).
    const progress = info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('P-522 snapshot seed scan:'));
    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain(`scanned down to #${resumeBelow}`);
    expect(progress[0]).toContain(`stopped on unreadable #${resumeBelow! - 1}`);

    clock.offset += SNAPSHOT_UNREADABLE_RETRY_MS + 1_000; // the block now reads on the retry
    await seedUntilSeeded(view, cursor, resumeOpts, clock);
    expect(cursor.positions.get(log.keyHex)).toBe(setAt); // seeded at the set, not folded from 0
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
  });

  it('a SLOW store (a different block times out on each retry, past 3 min) stays held and seeds at the set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { log, setAt } = await towerWithOldPrefix('e8'.repeat(32), 300, 400);
    const { view, hangOnce } = hangingOnceView(log, false);
    const cursor = createMergeCursor();
    const opts = { getTimeoutMs: 5, scanBudgetMs: 0 }; // unbounded: only the timeouts stop a pass
    const clock = offsetClock();

    // Each round the scan reads past the block that timed out last round, then times out on
    // one 10 blocks further down. 9 rounds span 4.5 min, all above the set.
    for (let round = 0; round < 9; round++) {
      hangOnce.add(log.length - 1 - 10 * (round + 1));
      await seedCursorFromSnapshots([view], cursor, opts);
      expect(cursor.snapshotScans?.get(log.keyHex)?.unreadableAtLength).toBeDefined();
      expect(cursor.snapshotSeedPending?.has(log.keyHex)).toBe(true);
      clock.offset += SNAPSHOT_UNREADABLE_RETRY_MS + 1_000;
    }
    expect(clock.offset).toBeGreaterThan(SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('P-522 snapshot seed GAVE UP'))).toBe(false);

    await seedUntilSeeded(view, cursor, opts, clock); // nothing hangs now: the scan concludes
    expect(cursor.positions.get(log.keyHex)).toBe(setAt);
    expect(cursor.snapshotSeedPending?.size ?? 0).toBe(0);
  });
});

describe('P-522 (b): a deferral eviction re-folds only once the fold has settled, and only back to the floor', () => {
  /**
   * A joiner whose epoch key is the LAST op of the tower log (the VM device's wrapped-key
   * rows were written at 03:56Z, near the tail). Content ops defer until the key applies,
   * through the real PendingEpochContent with a tiny cap, and drain after the pass, as
   * boot.ts does. `policy` is what an eviction triggers.
   */
  async function runJoin(opts: {
    policy: 'next-pass-reset' | 'settled-rewind';
    seeded: boolean;
    maxPasses: number;
  }) {
    const log = memLog(opts.seeded ? 'f1'.repeat(32) : 'f2'.repeat(32));
    const content: PeerLogOp[] = [];
    for (let i = 0; i < 60; i++) content.push(op('content', `C${i % 25}`, { i }, T0 + i));
    await log.appendBatch!(content);
    let setAt = 0;
    if (opts.seeded) {
      setAt = log.length;
      await produceLogSnapshot(log, { now: T0 + 1_000, schemaVersion: 1, maxChunkBytes: 400 });
      const more: PeerLogOp[] = [];
      for (let i = 0; i < 40; i++) more.push(op('content', `D${i % 15}`, { i }, T0 + 2_000 + i));
      await log.appendBatch!(more);
    }
    await log.append(op('keys', 'epoch0:device', { wrapped: 'k' }, T0 + 5_000));
    const oracle = await fullReplay(log);

    const pending = new PendingEpochContent(5);
    const refold = new DeferralEvictionReFold();
    const pg: Pg = new Map();
    let keyPresent = false;
    const applyImpl = async (env: OpEnvelope): Promise<boolean> => {
      if (env.table === 'content' && !keyPresent) {
        pending.defer(env, 'pot', 0);
        return false; // what the epoch gate returns on a defer
      }
      if (env.table === 'keys') keyPresent = true;
      pg.set(`${env.table}::${env.hbKey}`, env.value);
      return true;
    };

    let cursor = createMergeCursor();
    let minPositionAfterSeed = Infinity;
    let rewinds = 0;
    let passes = 0;
    for (; passes < opts.maxPasses; passes++) {
      const evicted = pending.consumeEvictionSignal();
      if (opts.policy === 'next-pass-reset') {
        if (evicted) cursor = createMergeCursor();
      } else {
        if (evicted) refold.noteEviction();
        const action = refold.settle(cursor);
        if (action.kind === 'reset') cursor = createMergeCursor();
        if (action.kind === 'rewound') rewinds++;
      }
      await seedCursorFromSnapshots([log], cursor, { getTimeoutMs: 0 });
      refold.markFloors(cursor, pending.size() > 0);
      const pos = cursor.positions.get(log.keyHex);
      if (pos !== undefined) minPositionAfterSeed = Math.min(minPositionAfterSeed, pos);
      const before = new Map(cursor.positions);
      await mergeAdmittedLogsIncremental([log], cursor, {
        getTimeoutMs: 0,
        maxOpsPerPass: 12,
        applyImpl: applyImpl as never,
      });
      refold.noteFold([log], cursor, before);
      if (keyPresent) for (const d of pending.drainEpoch('pot', 0)) await applyImpl(d.op);
      if (keyPresent && pending.size() === 0 && cursor.positions.get(log.keyHex) === log.length && !refold.isOwed) {
        if (isDeepStrictEqual(Object.fromEntries(pg), oracle)) break;
      }
    }
    return { pg: Object.fromEntries(pg), oracle, passes, keyPresent, setAt, minPositionAfterSeed, rewinds };
  }

  it('CONTROL (the pre-P-522 behaviour): resetting on the next pass livelocks; the fold never reaches the key', async () => {
    const r = await runJoin({ policy: 'next-pass-reset', seeded: false, maxPasses: 60 });
    expect(r.keyPresent).toBe(false);
    expect(r.pg).not.toEqual(r.oracle);
  });

  it('the settled rewind reaches the key, re-reads the evicted ops and converges to the full-replay state', async () => {
    const r = await runJoin({ policy: 'settled-rewind', seeded: false, maxPasses: 60 });
    expect(r.keyPresent).toBe(true);
    expect(r.rewinds).toBeGreaterThanOrEqual(1);
    expect(r.pg).toEqual(r.oracle);
    expect(r.passes).toBeLessThan(20);
  });

  it('CONTROL (pre-P-522) with a snapshot seed: the reset re-seeds and re-applies the set forever', async () => {
    const r = await runJoin({ policy: 'next-pass-reset', seeded: true, maxPasses: 60 });
    expect(r.keyPresent).toBe(false);
    expect(r.pg).not.toEqual(r.oracle);
  });

  it('under a seeded cursor the rewind never goes below the seed, and the join converges', async () => {
    const r = await runJoin({ policy: 'settled-rewind', seeded: true, maxPasses: 60 });
    expect(r.setAt).toBeGreaterThan(0);
    expect(r.minPositionAfterSeed).toBeGreaterThanOrEqual(r.setAt);
    expect(r.rewinds).toBeGreaterThanOrEqual(1);
    expect(r.pg).toEqual(r.oracle);
  });
});

describe('P-522 (b): DeferralEvictionReFold and rewindMergeCursor', () => {
  const K = 'ab'.repeat(32);
  const lengthOf = (n: number): AdmittedLog => ({ keyHex: K, length: n, get: async () => null });

  it('an owed re-fold waits while the fold is still advancing, then rewinds to the floor', () => {
    const refold = new DeferralEvictionReFold();
    const cursor = createMergeCursor();
    cursor.positions.set(K, 100);
    refold.markFloors(cursor, false); // floor 100
    refold.noteEviction();
    cursor.positions.set(K, 150);
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 100]])); // advanced, not at length
    expect(refold.settle(cursor)).toEqual({ kind: 'none' });
    expect(cursor.positions.get(K)).toBe(150);

    refold.markFloors(cursor, true); // owed: floors frozen
    expect(refold.floorOf(K)).toBe(100);
    cursor.positions.set(K, 1_000);
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 150]])); // at length: settled
    expect(refold.settle(cursor)).toEqual({ kind: 'rewound', moved: [{ keyHex: K, floor: 100 }] });
    expect(cursor.positions.get(K)).toBe(100);
    expect(refold.isOwed).toBe(false);
  });

  it('a log the pass could not move (a read stall or an apply hold) counts as settled', () => {
    const refold = new DeferralEvictionReFold();
    const cursor = createMergeCursor();
    cursor.positions.set(K, 40);
    refold.markFloors(cursor, false);
    refold.noteEviction();
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 40]]));
    expect(refold.settle(cursor).kind).toBe('rewound');
  });

  it('P-538: a stalled-behind log is settled but NOT caught up; only a log at its length is', () => {
    const refold = new DeferralEvictionReFold();
    expect(refold.isCaughtUp).toBe(false); // a fresh fold is catching up until a pass says otherwise
    const cursor = createMergeCursor();
    cursor.positions.set(K, 40);
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 40]])); // could not move
    expect(refold.isSettled).toBe(true);
    expect(refold.isCaughtUp).toBe(false);

    const unpositioned = createMergeCursor(); // a fresh log held for its seed scan
    refold.noteFold([lengthOf(1_000)], unpositioned, new Map());
    expect(refold.isCaughtUp).toBe(false);

    cursor.positions.set(K, 1_000);
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 40]]));
    expect(refold.isCaughtUp).toBe(true);
    refold.noteFold([lengthOf(1_200)], cursor, new Map([[K, 1_000]]));
    expect(refold.isCaughtUp).toBe(false);
    refold.noteIdle();
    expect(refold.isCaughtUp).toBe(true);
  });

  it('P-541: a log with ops but no position, or a paid rewind, puts the fold back to catching up', () => {
    const refold = new DeferralEvictionReFold();
    const cursor = createMergeCursor();
    refold.noteIdle(); // the last pass had nothing to fold
    refold.noteUnpositioned([lengthOf(0)], cursor); // an empty log has nothing to catch up on
    expect(refold.isCaughtUp).toBe(true);
    refold.noteUnpositioned([lengthOf(1_000)], cursor); // admitted since the last pass
    expect(refold.isCaughtUp).toBe(false);

    cursor.positions.set(K, 100);
    refold.markFloors(cursor, false); // floor 100
    refold.noteEviction();
    cursor.positions.set(K, 1_000);
    refold.noteFold([lengthOf(1_000)], cursor, new Map([[K, 100]]));
    refold.noteUnpositioned([lengthOf(1_000)], cursor); // positioned: no change
    expect(refold.isCaughtUp).toBe(true);
    expect(refold.settle(cursor)).toEqual({ kind: 'rewound', moved: [{ keyHex: K, floor: 100 }] });
    expect(refold.isCaughtUp).toBe(false);
  });

  it('a replaced cursor pays the debt (it re-reads from its seeds); its floors start over', () => {
    const refold = new DeferralEvictionReFold();
    const a = createMergeCursor();
    a.positions.set(K, 10);
    refold.markFloors(a, false);
    refold.noteEviction();
    refold.noteIdle();
    const b = createMergeCursor();
    expect(refold.settle(b)).toEqual({ kind: 'none' });
    expect(refold.isOwed).toBe(false);
  });

  it('deferrals buffered across a cursor replacement leave no trustworthy floor: an eviction then asks for a reset', () => {
    const refold = new DeferralEvictionReFold();
    const a = createMergeCursor();
    refold.markFloors(a, false);
    const b = createMergeCursor();
    b.positions.set(K, 500);
    refold.markFloors(b, true); // replaced while the buffers still hold deferrals
    refold.noteEviction();
    refold.noteIdle();
    expect(refold.settle(b)).toEqual({ kind: 'reset' });
    // Once the buffers drain at a pass start the floors are exact again.
    refold.markFloors(b, false);
    refold.noteEviction();
    refold.noteIdle();
    expect(refold.settle(b).kind).toBe('rewound');
  });

  it('a log positioned while floors are frozen gets its first position as its floor', () => {
    const refold = new DeferralEvictionReFold();
    const cursor = createMergeCursor();
    refold.markFloors(cursor, false);
    refold.noteEviction();
    cursor.positions.set(K, 7_000); // seeded at a set this pass
    refold.markFloors(cursor, true);
    expect(refold.floorOf(K)).toBe(7_000);
  });

  it('rewindMergeCursor moves only backward, drops winners, and keeps the log-describing state', () => {
    const cursor = createMergeCursor();
    cursor.positions.set('a', 50);
    cursor.positions.set('b', 5);
    cursor.winners.set('queue::X', { ts: 1, type: 'put', src: 'a' } as never);
    cursor.snapshotApplyThrough = new Map([['a', 20]]);
    cursor.snapshotScans = new Map([['a', { scannedTo: 60, set: null }]]);
    const moved = rewindMergeCursor(
      cursor,
      new Map([
        ['a', 20],
        ['b', 30],
      ]),
    );
    expect(moved).toEqual(['a']);
    expect(cursor.positions.get('a')).toBe(20);
    expect(cursor.positions.get('b')).toBe(5); // never forward
    expect(cursor.winners.size).toBe(0);
    expect(cursor.snapshotApplyThrough.get('a')).toBe(20);
    expect(cursor.snapshotScans.has('a')).toBe(true);
  });
});

describe('D-016: a dropped deferral owes a re-fold only when its blocker clears, from its own position', () => {
  /**
   * P-007 run #5's shape. The seeded set holds `cut` rows under an epoch this device never
   * gets a key for (a removed member's content), more of them than the buffer holds, so the
   * buffer is never empty at a pass start and the coarse floor stays at the set start. The
   * tail holds plain ops, then epoch-0 content whose key is the last op. The pass loop is
   * boot.ts's: drops are consumed at the top, the re-fold settles, floors are marked, the
   * fold runs, and the key-applied drain runs after it.
   */
  async function runJoin(opts: { policy: 'coarse' | 'd016'; maxPasses: number }) {
    const log = memLog('d1'.repeat(32));
    const prefix: PeerLogOp[] = [];
    for (let i = 0; i < 30; i++) prefix.push(op('plain', `P${i}`, { i }, T0 + i));
    for (let i = 0; i < 8; i++) prefix.push(op('cut', `X${i}`, { i }, T0 + 100 + i));
    await log.appendBatch!(prefix);
    const setAt = log.length;
    await produceLogSnapshot(log, { now: T0 + 1_000, schemaVersion: 1, maxChunkBytes: 400 });
    const setEnd = log.length;
    const tail: PeerLogOp[] = [];
    for (let i = 0; i < 30; i++) tail.push(op('plain', `Q${i}`, { i }, T0 + 2_000 + i));
    const contentAt = setEnd + tail.length;
    for (let i = 0; i < 10; i++) tail.push(op('content', `C${i}`, { i }, T0 + 3_000 + i));
    // Another device's epoch-1 key row: it fires the drain hook, but this device still has no key.
    tail.push(op('keys', 'epoch1:other', { wrapped: 'o' }, T0 + 4_000));
    tail.push(op('keys', 'epoch0:device', { wrapped: 'k' }, T0 + 5_000));
    await log.appendBatch!(tail);
    const oracle = await fullReplay(log);
    const expected = Object.fromEntries(Object.entries(oracle).filter(([k]) => !k.startsWith('cut::')));

    const pending = new PendingEpochContent(5);
    const refold = new DeferralEvictionReFold();
    const drainQueue: DrainedEpoch[] = [];
    const pg: Pg = new Map();
    let keyPresent = false;
    const applyImpl = async (env: OpEnvelope): Promise<boolean> => {
      if (env.table === 'cut') {
        pending.defer(env, 'pot', 1);
        return false;
      }
      if (env.table === 'content' && !keyPresent) {
        pending.defer(env, 'pot', 0);
        return false;
      }
      if (env.table === 'keys') {
        if (env.hbKey === 'epoch0:device') keyPresent = true;
        drainQueue.push({ potHomeSlug: 'pot', epoch: env.hbKey === 'epoch0:device' ? 0 : 1 });
      }
      pg.set(`${env.table}::${env.hbKey}`, env.value);
      return true;
    };

    let cursor = createMergeCursor();
    const rewoundTo: number[] = [];
    let passes = 0;
    for (; passes < opts.maxPasses; passes++) {
      const action = refold.settle(cursor);
      if (action.kind === 'reset') cursor = createMergeCursor();
      if (action.kind === 'rewound') for (const m of action.moved) rewoundTo.push(m.floor);
      await seedCursorFromSnapshots([log], cursor, { getTimeoutMs: 0 });
      refold.markFloors(cursor, pending.size() > 0 || pending.dropped.holdsSourceless);
      const before = new Map(cursor.positions);
      await mergeAdmittedLogsIncremental([log], cursor, {
        getTimeoutMs: 0,
        maxOpsPerPass: 12,
        applyImpl: applyImpl as never,
      });
      refold.noteFold([log], cursor, before);
      await drainQueuedEpochContent({
        pending,
        drainQueue,
        applyImpl,
        hasEpochKey: async (_pot, epoch) => epoch === 0 && keyPresent,
      });
      // boot.ts consumes these at the top of the next pass; the same point in this loop.
      if (opts.policy === 'coarse') {
        if (pending.consumeEvictionSignal()) refold.noteEviction();
      } else {
        const owed = pending.dropped.takeOwed();
        if (owed) refold.noteOwed(owed);
      }
      const atTail = cursor.positions.get(log.keyHex) === log.length;
      if (atTail && !refold.isOwed && isDeepStrictEqual(Object.fromEntries(pg), expected)) break;
    }
    return { pg: Object.fromEntries(pg), expected, passes, setAt, setEnd, contentAt, rewoundTo, pending };
  }

  it('CONTROL (the P-522 coarse policy): every crossing evicts a cut row and rewinds to the set start again', async () => {
    const r = await runJoin({ policy: 'coarse', maxPasses: 60 });
    expect(r.rewoundTo.length).toBeGreaterThanOrEqual(3);
    expect(r.rewoundTo.every((floor) => floor === r.setAt)).toBe(true);
    expect(r.passes).toBe(60);
  });

  it('D-016: one re-fold, from the first evicted content op in the tail, and the join converges', async () => {
    const r = await runJoin({ policy: 'd016', maxPasses: 60 });
    expect(r.pg).toEqual(r.expected);
    expect(r.rewoundTo).toHaveLength(1);
    // The fold read content from contentAt; the first op the buffer dropped sits at or after it.
    expect(r.rewoundTo[0]).toBeGreaterThanOrEqual(r.contentAt);
    expect(r.passes).toBeLessThan(60);
    // The cut rows' drops stay recorded, with their set-chunk positions, and owe nothing.
    expect(r.pending.hasEvicted('pot', 1)).toBe(true);
    expect(r.pending.dropped.holdsSourceless).toBe(false);
    expect(r.pending.dropped.takeOwed()).toBeNull();
  });
});

describe('P-541: a log admitted since the last pass folds its snapshot set with the member TTL held', () => {
  /**
   * P-007 run #15's shape. The log is admitted after a pass that had nothing to fold, so that
   * pass ended caught up. Its set holds member A's content; the long tail holds non-member B's
   * content, then A's member row. Every apply ticks the clock, and the TTL is shorter than the
   * tail, so with expiry live a B deferral sweeps A's entries before A's row arrives. The pass
   * loop is boot.ts's: drops and the top-of-pass hold, settle, (P-541) the re-decided hold,
   * seeding, floors, the fold, then the member drain.
   */
  async function runJoin(opts: { policy: 'top-only' | 'p541'; maxPasses: number }) {
    const log = memLog('e1'.repeat(32));
    const prefix: PeerLogOp[] = [];
    for (let i = 0; i < 20; i++) prefix.push(op('plain', `P${i}`, { i }, T0 + i));
    for (let i = 0; i < 6; i++) prefix.push(op('mc', `A${i}`, { i }, T0 + 100 + i));
    await log.appendBatch!(prefix);
    const setAt = log.length;
    await produceLogSnapshot(log, { now: T0 + 1_000, schemaVersion: 1, maxChunkBytes: 400 });
    const setEnd = log.length;
    const tail: PeerLogOp[] = [];
    for (let i = 0; i < 80; i++) tail.push(op('plain', `Q${i}`, { i }, T0 + 2_000 + i));
    for (let i = 0; i < 3; i++) tail.push(op('mc', `B${i}`, { i }, T0 + 3_000 + i));
    tail.push(op('members', 'A', { device: 'A' }, T0 + 4_000));
    await log.appendBatch!(tail);
    const oracle = await fullReplay(log);
    const expected = Object.fromEntries(Object.entries(oracle).filter(([k]) => !k.startsWith('mc::B')));

    const TTL = 40;
    let clock = 0;
    const pending = new PendingMembershipContent(5_000, TTL);
    const refold = new DeferralEvictionReFold();
    const members = new Set<string>();
    const drainQueue: string[] = [];
    const pg: Pg = new Map();
    const applyImpl = async (env: OpEnvelope): Promise<boolean> => {
      clock++;
      const key = env.hbKey ?? '';
      if (env.table === 'mc') {
        const author = key.slice(0, 1);
        if (!members.has(author)) {
          const reapply = async () => {
            await applyImpl(env);
          };
          pending.defer({ authorDevice: author, tableTag: 'mc', rowKey: key, reapply }, clock);
          return false;
        }
      }
      if (env.table === 'members') {
        members.add(key);
        drainQueue.push(key);
      }
      pg.set(`${env.table}::${key}`, env.value);
      return true;
    };

    let cursor = createMergeCursor();
    const rewoundTo: number[] = [];
    let expired = 0;
    let passes = 0;
    for (; passes < opts.maxPasses; passes++) {
      expired += pending.dropped.takeDropCounts().expired;
      const owed = pending.dropped.takeOwed();
      if (owed) refold.noteOwed(owed);
      pending.holdExpiry(!refold.isCaughtUp);
      const logs = passes === 0 ? [] : [log]; // admitted after the first pass
      const action = refold.settle(cursor);
      if (action.kind === 'reset') cursor = createMergeCursor();
      if (action.kind === 'rewound') for (const m of action.moved) rewoundTo.push(m.floor);
      if (opts.policy === 'p541') {
        refold.noteUnpositioned(logs, cursor);
        pending.holdExpiry(!refold.isCaughtUp);
      }
      await seedCursorFromSnapshots(logs, cursor, { getTimeoutMs: 0 });
      refold.markFloors(cursor, pending.size() > 0 || pending.dropped.holdsSourceless);
      if (logs.length === 0) {
        refold.noteIdle();
        continue;
      }
      const before = new Map(cursor.positions);
      await mergeAdmittedLogsIncremental(logs, cursor, {
        getTimeoutMs: 0,
        maxOpsPerPass: 0,
        applyImpl: applyImpl as never,
      });
      refold.noteFold(logs, cursor, before);
      while (drainQueue.length > 0) {
        for (const d of pending.drainForDevices([drainQueue.shift()!], clock)) await d.reapply();
      }
      const atTail = cursor.positions.get(log.keyHex) === log.length;
      if (atTail && !refold.isOwed && isDeepStrictEqual(Object.fromEntries(pg), expected)) break;
    }
    return { pg: Object.fromEntries(pg), expected, passes, setAt, setEnd, rewoundTo, expired };
  }

  it('CONTROL (the P-538 top-of-pass hold): the set runs with expiry live, A expires mid-join and the re-fold rewinds into the set', async () => {
    const r = await runJoin({ policy: 'top-only', maxPasses: 10 });
    expect(r.expired).toBeGreaterThan(0);
    expect(r.rewoundTo).toHaveLength(1);
    expect(r.rewoundTo[0]).toBeGreaterThanOrEqual(r.setAt);
    expect(r.rewoundTo[0]).toBeLessThan(r.setEnd);
  });

  it('P-541: the hold covers the pass that admits the log; nothing of A expires, nothing rewinds, and the join converges', async () => {
    const r = await runJoin({ policy: 'p541', maxPasses: 10 });
    expect(r.expired).toBe(0);
    expect(r.rewoundTo).toEqual([]);
    expect(r.pg).toEqual(r.expected);
    expect(r.passes).toBe(1);
  });
});
