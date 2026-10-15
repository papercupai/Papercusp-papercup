import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshotOps, type SnapshotPayload } from '../log-snapshot';
import {
  combineSnapshotApplyMarks,
  createMergeCursor,
  LEGACY_UNMARKED_FILTERED_SET_CUTOFF_MS,
  mergeAdmittedLogsIncremental,
  MERGE_PERSIST_EVERY_OPS,
  NO_SNAPSHOT_APPLY,
  persistCursor,
  seedCursorFromPg,
  seedCursorFromSnapshots,
  snapshotApplyMarkOf,
  snapshotApplyMarks,
  SNAPSHOT_JUMP_MIN_BACKLOG_OPS,
  type AdmittedLog,
  type MergeApplyFailure,
  type MergeCursor,
  type MergeCursorStore,
  type SnapshotApplyMark,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';

/**
 * p2p-join-catchup-speed-2026-09-23 P-008 (endgame D-060, WI-10002783 / WI-10002774).
 *
 * A reader that already folded a log's prefix op by op must apply ZERO rows when it
 * crosses that log's snapshot set. Measured before this change on the P-203 VM, a
 * restarted reader re-applied a 1.24M-row set at ~25 rows/s. A cursor that OWES a
 * set must still apply it: the set it was seeded or jumped at, and the next set
 * after it moved past an op it could not apply (the rolling-upgrade recovery).
 *
 * Every restart here goes through an in-memory store with the PG store's semantics
 * (`loadSnapshotMarks` returns a mark only when its stamp equals the row's current
 * position), and the restarted cursor has EMPTY winners, exactly as after a
 * bg-host restart. Each case checks both directions: the skip happens, and forcing
 * the other disposition changes the outcome.
 */

const KEY = 'ab'.repeat(32);

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function put(hbKey: string, value: unknown, ts: number, schema_version = 1): PeerLogOp {
  return { type: 'put', table: 'queue', hbKey, value, ts, schema_version, author_pubkey: 'me' };
}
function del(hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table: 'queue', hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

interface TestLog extends AdmittedLog {
  ops: PeerLogOp[];
  /** The non-snapshot ops, in order: what a producer folds into a set. */
  history: PeerLogOp[];
  append(...batch: PeerLogOp[]): void;
  /** Append one snapshot set over `history` at the current tail; returns its coversUpTo. */
  appendSet(opts?: {
    maxChunkBytes?: number;
    excludeTables?: string[];
    /** Mark the set as summarizing this log's own prefix (WI-10005425). */
    ownPrefix?: boolean;
    ts?: number;
    schemaVersion?: number;
  }): {
    coversUpTo: number;
    chunkCount: number;
    rowCount: number;
  };
}

function testLog(keyHex = KEY, knownSchemaVersion = Number.POSITIVE_INFINITY): TestLog {
  const log: TestLog = {
    ops: [],
    history: [],
    get keyHex() {
      return keyHex;
    },
    get length() {
      return log.ops.length;
    },
    async get(i: number) {
      const op = log.ops[i] ?? null;
      // The D-024 version gate (boot.ts versionGatedLog): an unknown-newer op reads as null.
      if (op && op.schema_version > knownSchemaVersion) return null;
      return op;
    },
    append(...batch: PeerLogOp[]) {
      for (const op of batch) {
        log.ops.push(op);
        log.history.push(op);
      }
    },
    appendSet(opts) {
      const coversUpTo = log.ops.length;
      const set = buildSnapshotOps({
        ops: log.history,
        coversUpTo,
        author_pubkey: 'me',
        ts: opts?.ts ?? 1_000_000,
        schema_version: opts?.schemaVersion ?? 1,
        ...(opts?.maxChunkBytes ? { maxChunkBytes: opts.maxChunkBytes } : {}),
        ...(opts?.excludeTables ? { excludeTables: opts.excludeTables } : {}),
        ...(opts?.ownPrefix ? { ownPrefix: true } : {}),
      });
      log.ops.push(...set);
      const rowCount = set.reduce((n, op) => n + (op.value as SnapshotPayload).rows.length, 0);
      return { coversUpTo, chunkCount: set.length, rowCount };
    },
  };
  return log;
}

/** The same log read by a peer on a different build (a different version gate). */
function readAs(log: TestLog, knownSchemaVersion: number): AdmittedLog {
  return {
    keyHex: log.keyHex,
    get length() {
      return log.ops.length;
    },
    async get(i: number) {
      const op = log.ops[i] ?? null;
      if (op && op.schema_version > knownSchemaVersion) return null;
      return op;
    },
  };
}

interface MemRow {
  position: number;
  mark: (SnapshotApplyMark & { at: number }) | null;
}

/** In-memory `MergeCursorStore` with the PG store's stamp semantics. */
function memStore(): MergeCursorStore & { rows: Map<string, MemRow> } {
  const rows = new Map<string, MemRow>();
  return {
    rows,
    async load() {
      return new Map([...rows].map(([k, r]) => [k, r.position]));
    },
    async loadApplyFailures() {
      return new Map<string, MergeApplyFailure>();
    },
    async loadSnapshotMarks() {
      const out = new Map<string, SnapshotApplyMark>();
      for (const [k, r] of rows) {
        if (r.mark && r.mark.at === r.position) out.set(k, { applyThrough: r.mark.applyThrough, hole: r.mark.hole });
      }
      return out;
    },
    async save(positions, _binding, _failures, marks) {
      for (const [k, position] of positions) {
        const prev = rows.get(k);
        const mark = marks?.get(k);
        rows.set(k, {
          position,
          // Mirrors the SQL: a save without marks leaves the old stamp in place.
          mark: marks ? (mark ? { ...mark, at: position } : null) : (prev?.mark ?? null),
        });
      }
    },
  };
}

type Pg = Map<string, unknown>;

/** Fold through `cursor`, persisting every checkpoint (and the end) to `store`. Returns the apply count. */
async function fold(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  pg: Pg,
  opts: { budget?: number; store?: MergeCursorStore; onPersist?: (positions: Map<string, number>) => void } = {},
): Promise<number> {
  let applies = 0;
  const persist = async (): Promise<void> => {
    opts.onPersist?.(new Map(cursor.positions));
    if (opts.store) {
      await persistCursor(cursor.positions, opts.store, null, cursor.applyFailures ?? new Map(), snapshotApplyMarks(cursor));
    }
  };
  await mergeAdmittedLogsIncremental(logs, cursor, {
    getTimeoutMs: 0,
    maxOpsPerPass: opts.budget ?? 0,
    applyImpl: (async (env: { table?: string; hbKey?: string; type: string; value?: unknown }) => {
      applies++;
      const k = `${env.table}::${env.hbKey}`;
      if (env.type === 'del') pg.delete(k);
      else pg.set(k, env.value);
      return true;
    }) as never,
    onCursorAdvance: persist,
  });
  await persist();
  return applies;
}

/** A bg-host restart: a NEW cursor (empty winners) seeded from the durable store. */
async function restart(store: MergeCursorStore): Promise<MergeCursor> {
  const cursor = createMergeCursor();
  await seedCursorFromPg(cursor, store, null);
  return cursor;
}

/** The history-only oracle: every non-snapshot op folded from 0, no set involved at all. */
async function historyOracle(log: TestLog, knownSchemaVersion = Number.POSITIVE_INFINITY): Promise<Record<string, unknown>> {
  const bare = testLog(`${log.keyHex.slice(0, 60)}ffff`);
  bare.append(...log.history.filter((op) => op.schema_version <= knownSchemaVersion));
  const pg: Pg = new Map();
  await fold([bare], createMergeCursor(), pg);
  return Object.fromEntries(pg);
}

/** 200 live keys, then a (multi-chunk) set over them, then a short tail. */
function logWithSetAfterHistory(): { log: TestLog; set: ReturnType<TestLog['appendSet']> } {
  const log = testLog();
  for (let i = 0; i < 200; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
  const set = log.appendSet({ maxChunkBytes: 4_000 });
  for (let i = 0; i < 10; i++) log.append(put(`T${i}`, { v: i }, 10_000 + i));
  return { log, set };
}

describe('P-008 (a) a restarted sequential reader skips a set it already folded', () => {
  it('applies ZERO set rows, persists no watermark, and still lands on the history-only oracle', async () => {
    const { log, set } = logWithSetAfterHistory();
    expect(set.chunkCount).toBeGreaterThan(1);
    const store = memStore();
    const pg: Pg = new Map();

    // Fold exactly [0, coversUpTo) op by op, then "restart".
    await fold([log], createMergeCursor(), pg, { budget: set.coversUpTo, store });
    expect(store.rows.get(KEY)).toMatchObject({ position: set.coversUpTo, mark: { applyThrough: NO_SNAPSHOT_APPLY, hole: null } });

    const cursor = await restart(store);
    const setApplies = await fold([log], cursor, pg, { budget: set.chunkCount, store });
    expect(setApplies).toBe(0);
    expect(cursor.positions.get(KEY)).toBe(set.coversUpTo + set.chunkCount);
    const skippedLine = `set@${set.coversUpTo}: SKIPPED ${set.chunkCount} chunk(s)`;
    expect(infoSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(skippedLine))).toBe(true);

    await fold([log], cursor, pg, { store });
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('CONTROL: the same restart with the set marked OWED applies every one of its rows', async () => {
    const { log, set } = logWithSetAfterHistory();
    const store = memStore();
    await fold([log], createMergeCursor(), new Map(), { budget: set.coversUpTo, store });
    store.rows.get(KEY)!.mark = { applyThrough: set.coversUpTo, hole: null, at: set.coversUpTo };

    const setApplies = await fold([log], await restart(store), new Map(), { budget: set.chunkCount });
    expect(setApplies).toBe(set.rowCount);
  });

  it('an UNSTAMPED row (older build, or a manual position edit) owes the next set once, then skips', async () => {
    const { log, set } = logWithSetAfterHistory();
    const store = memStore();
    await fold([log], createMergeCursor(), new Map(), { budget: set.coversUpTo, store });
    // A writer that moved the position without re-stamping (the D-060 rig edit shape).
    store.rows.get(KEY)!.mark!.at = set.coversUpTo - 1;

    const cursor = await restart(store);
    expect(snapshotApplyMarkOf(cursor, KEY)).toEqual({ applyThrough: NO_SNAPSHOT_APPLY, hole: 0 });
    expect(await fold([log], cursor, new Map(), { budget: set.chunkCount, store })).toBe(set.rowCount);
    // Crossing it resolved the conservative hole and restamped the row.
    expect(snapshotApplyMarkOf(cursor, KEY)).toEqual({ applyThrough: set.coversUpTo, hole: null });
    expect(store.rows.get(KEY)!.mark).toMatchObject({ at: set.coversUpTo + set.chunkCount, hole: null });

    // The NEXT set is redundant again and is skipped after another restart.
    for (let i = 0; i < 5; i++) log.append(put(`K${i}`, { v: `late${i}` }, 20_000 + i));
    await fold([log], await restart(store), new Map(), { store });
    const next = log.appendSet({ maxChunkBytes: 4_000 });
    expect(await fold([log], await restart(store), new Map(), { budget: next.chunkCount })).toBe(0);
  });
});

describe('P-008 (b) seeded readers still apply the set they were seeded at', () => {
  it('a fresh seed marks its set owed, applies it, and lands on the oracle', async () => {
    const { log, set } = logWithSetAfterHistory();
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor);
    expect(cursor.positions.get(KEY)).toBe(set.coversUpTo);
    expect(snapshotApplyMarkOf(cursor, KEY)).toEqual({ applyThrough: set.coversUpTo, hole: null });

    const pg: Pg = new Map();
    expect(await fold([log], cursor, pg, { budget: set.chunkCount })).toBe(set.rowCount);
    await fold([log], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('the P-004 far-behind jump marks the jumped-to set owed and lands on the oracle', async () => {
    const log = testLog();
    for (let i = 0; i < 10; i++) log.append(put(`A${i}`, { v: i }, 1 + i));
    const cursor = createMergeCursor();
    const pg: Pg = new Map();
    await fold([log], cursor, pg);
    for (let i = 0; i < SNAPSHOT_JUMP_MIN_BACKLOG_OPS + 100; i++) log.append(put(`F${i % 50}`, { i }, 100 + i));
    const set = log.appendSet({ ts: 200_000 });
    log.append(put('tail', { v: 1 }, 300_000));

    await seedCursorFromSnapshots([log], cursor);
    expect(cursor.positions.get(KEY)).toBe(set.coversUpTo);
    expect(snapshotApplyMarkOf(cursor, KEY).applyThrough).toBe(set.coversUpTo);
    await fold([log], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });
});

describe('P-008 (c) a seeded reader interrupted mid-set resumes and finishes the set', () => {
  it('resumes from the stamped store row, and forcing "not owed" instead loses the rest of the set', async () => {
    const { log, set } = logWithSetAfterHistory();
    expect(set.chunkCount).toBeGreaterThanOrEqual(3);

    const run = async (tamper: boolean): Promise<Record<string, unknown>> => {
      const store = memStore();
      const cursor = createMergeCursor();
      await seedCursorFromSnapshots([log], cursor);
      const pg: Pg = new Map();
      await fold([log], cursor, pg, { budget: 2, store }); // chunks 0 and 1 only
      const row = store.rows.get(KEY)!;
      expect(row).toMatchObject({ position: set.coversUpTo + 2, mark: { applyThrough: set.coversUpTo } });
      if (tamper) row.mark = { applyThrough: NO_SNAPSHOT_APPLY, hole: null, at: row.position };
      await fold([log], await restart(store), pg, { store });
      return Object.fromEntries(pg);
    };

    const oracle = await historyOracle(log);
    expect(await run(false)).toEqual(oracle);
    const tampered = await run(true);
    expect(tampered).not.toEqual(oracle);
    expect(Object.keys(tampered).length).toBeLessThan(Object.keys(oracle).length);
  });
});

describe('P-008 (d) an op the reader moved past unapplied makes the next set owed', () => {
  /** v1 history with ONE v2 op in it, then a set produced by the upgraded (v2) writer. */
  function skewLog(): { log: TestLog; newOpAt: number; set: ReturnType<TestLog['appendSet']> } {
    const log = testLog();
    for (let i = 0; i < 50; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
    const newOpAt = log.length;
    log.append(put('NEW', { v: 'v2-only' }, 100, 2));
    for (let i = 0; i < 20; i++) log.append(put(`K${i}`, { v: `b${i}` }, 200 + i));
    const set = log.appendSet({ schemaVersion: 2, maxChunkBytes: 4_000 });
    log.append(put('tail', { v: 1 }, 1_000));
    return { log, newOpAt, set };
  }

  it('an old reader records the gated op as a hole; after the upgrade restart the set re-delivers it', async () => {
    const { log, newOpAt, set } = skewLog();
    const store = memStore();
    const pg: Pg = new Map();
    const old = createMergeCursor();
    await fold([readAs(log, 1)], old, pg, { budget: set.coversUpTo, store });
    expect(pg.has('queue::NEW')).toBe(false);
    expect(store.rows.get(KEY)!.mark).toMatchObject({ hole: newOpAt });

    const upgraded = await restart(store);
    await fold([readAs(log, 2)], upgraded, pg, { store });
    expect(pg.get('queue::NEW')).toEqual({ v: 'v2-only' });
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
    expect(snapshotApplyMarkOf(upgraded, KEY)).toEqual({ applyThrough: set.coversUpTo, hole: null });
  });

  it('CONTROL: the same upgrade with the hole erased from the store skips the set and loses the row', async () => {
    const { log, set } = skewLog();
    const store = memStore();
    const pg: Pg = new Map();
    await fold([readAs(log, 1)], createMergeCursor(), pg, { budget: set.coversUpTo, store });
    store.rows.get(KEY)!.mark!.hole = null;
    await fold([readAs(log, 2)], await restart(store), pg, { store });
    expect(pg.has('queue::NEW')).toBe(false);
  });
});

describe('P-008 (e) sets that do not summarize this log\'s own prefix always apply', () => {
  it('the seed-core shape (a set at coversUpTo 0 summarizing ANOTHER log) is applied by a sequential reader', async () => {
    const source = testLog('cd'.repeat(32));
    for (let i = 0; i < 30; i++) source.append(put(`S${i}`, { v: i }, 1 + i));
    const seedCore = testLog('ef'.repeat(32));
    seedCore.ops.push(
      ...buildSnapshotOps({ ops: source.history, coversUpTo: 0, author_pubkey: 'me', ts: 1_000, schema_version: 1, excludeTables: ['presence'] }),
    );
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([seedCore], cursor);
    const pg: Pg = new Map();
    await fold([seedCore], cursor, pg);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(source));
  });

  it('an unmarked set carrying excludeTables, produced after the legacy cutoff, is applied even by a restarted reader that folded the prefix', async () => {
    const log = testLog();
    for (let i = 0; i < 40; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
    const store = memStore();
    await fold([log], createMergeCursor(), new Map(), { budget: log.length, store });
    const set = log.appendSet({ excludeTables: ['presence'], ts: LEGACY_UNMARKED_FILTERED_SET_CUTOFF_MS });
    expect(await fold([log], await restart(store), new Map(), { budget: set.chunkCount })).toBe(set.rowCount);
  });
});

/**
 * WI-10005425. The release cut writes a FILTERED head snapshot (`excludeTables` =
 * presence) into the live own log, and it summarizes exactly that log's prefix. Before
 * the `ownPrefix` marker existed, `excludeTables` alone made every such set ineligible,
 * so each reader re-applied ~968k rows per cut on the tower.
 */
/**
 * 40 queue keys plus one row of the excluded table, folded op by op, then a filtered set
 * stamped `ts` (default: after the legacy cutoff, so only the marker can make it eligible).
 */
async function foldedPrefixThenFilteredSet(ownPrefix: boolean, ts = LEGACY_UNMARKED_FILTERED_SET_CUTOFF_MS) {
  const log = testLog();
  for (let i = 0; i < 40; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
  log.append({ type: 'put', table: 'presence', hbKey: 'P1', value: { at: 1 }, ts: 100, schema_version: 1, author_pubkey: 'me' });
  const store = memStore();
  const pg: Pg = new Map();
  await fold([log], createMergeCursor(), pg, { budget: log.length, store });
  const set = log.appendSet({ excludeTables: ['presence'], ownPrefix, maxChunkBytes: 400, ts });
  return { log, set, store, pg };
}

describe('P-008 (e) a filtered set marked ownPrefix summarizes this log, so a reader that folded the prefix skips it', () => {
  it('applies ZERO rows of the marked set and still lands on the history-only oracle', async () => {
    const { log, set, store, pg } = await foldedPrefixThenFilteredSet(true);
    expect(set.chunkCount).toBeGreaterThan(1);
    expect(set.rowCount).toBeGreaterThan(0);

    const cursor = await restart(store);
    expect(await fold([log], cursor, pg, { budget: set.chunkCount, store })).toBe(0);
    expect(cursor.positions.get(KEY)).toBe(set.coversUpTo + set.chunkCount);
    const skippedLine = `set@${set.coversUpTo}: SKIPPED ${set.chunkCount} chunk(s)`;
    expect(infoSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(skippedLine))).toBe(true);

    for (let i = 0; i < 5; i++) log.append(put(`T${i}`, { v: i }, 10_000 + i));
    await fold([log], cursor, pg, { store });
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('CONTROL: the identical set WITHOUT the marker is applied in full', async () => {
    const { log, set, store } = await foldedPrefixThenFilteredSet(false);
    expect(await fold([log], await restart(store), new Map(), { budget: set.chunkCount })).toBe(set.rowCount);
  });

  it('the marker never makes a set summarizing ANOTHER log skippable (coversUpTo 0 still applies)', async () => {
    const source = testLog('cd'.repeat(32));
    for (let i = 0; i < 30; i++) source.append(put(`S${i}`, { v: i }, 1 + i));
    const core = testLog('ef'.repeat(32));
    core.ops.push(
      ...buildSnapshotOps({
        ops: source.history,
        coversUpTo: 0,
        author_pubkey: 'me',
        ts: 1_000,
        schema_version: 1,
        excludeTables: ['presence'],
        ownPrefix: true,
      }),
    );
    const pg: Pg = new Map();
    expect(await fold([core], createMergeCursor(), pg)).toBe(30);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(source));
  });
});

/**
 * WI-6554700010008538. Release-cut sets produced BEFORE the `ownPrefix` marker are filtered
 * and unmarked. A reader re-folding the papercusp own log from 0 re-applied each one in full
 * (~1.4M rows, ~5 min per set, one every ~2-4K ops). Before the cutoff, such a set provably
 * summarizes its carrier's prefix when it sits at its own anchor (`coversUpTo > 0`): every
 * synthetic seed core was minted fresh, so its sets are at `coversUpTo` 0.
 */
describe('P-008 (e) a LEGACY unmarked filtered set at its own anchor summarizes this log, so it is skipped', () => {
  const LEGACY_TS = LEGACY_UNMARKED_FILTERED_SET_CUTOFF_MS - 1;

  it('applies ZERO rows of a pre-cutoff unmarked filtered set and still lands on the history-only oracle', async () => {
    const { log, set, store, pg } = await foldedPrefixThenFilteredSet(false, LEGACY_TS);
    expect(set.chunkCount).toBeGreaterThan(1);
    expect(set.rowCount).toBeGreaterThan(0);

    const cursor = await restart(store);
    expect(await fold([log], cursor, pg, { budget: set.chunkCount, store })).toBe(0);
    expect(cursor.positions.get(KEY)).toBe(set.coversUpTo + set.chunkCount);
    const skippedLine = `set@${set.coversUpTo}: SKIPPED ${set.chunkCount} chunk(s)`;
    expect(infoSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(skippedLine))).toBe(true);

    for (let i = 0; i < 5; i++) log.append(put(`T${i}`, { v: i }, 10_000 + i));
    await fold([log], cursor, pg, { store });
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(log));
  });

  it('BOUNDARY: the identical set stamped AT the cutoff keeps the apply path', async () => {
    const { log, set, store } = await foldedPrefixThenFilteredSet(false, LEGACY_UNMARKED_FILTERED_SET_CUTOFF_MS);
    expect(await fold([log], await restart(store), new Map(), { budget: set.chunkCount })).toBe(set.rowCount);
  });

  it('a pre-cutoff unmarked filtered set that is NOT at its own anchor is applied in full', async () => {
    const log = testLog();
    for (let i = 0; i < 40; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
    const store = memStore();
    await fold([log], createMergeCursor(), new Map(), { budget: log.length, store });
    // coversUpTo 2 short of where chunk 0 lands: the set does not start at its anchor.
    const set = buildSnapshotOps({
      ops: log.history.slice(0, log.ops.length - 2),
      coversUpTo: log.ops.length - 2,
      author_pubkey: 'me',
      ts: LEGACY_TS,
      schema_version: 1,
      excludeTables: ['presence'],
      maxChunkBytes: 400,
    });
    expect(set.length).toBeGreaterThan(1);
    log.ops.push(...set);
    const rowCount = set.reduce((n, op) => n + (op.value as SnapshotPayload).rows.length, 0);
    expect(await fold([log], await restart(store), new Map(), { budget: set.length })).toBe(rowCount);
  });

  it('the legacy rule never makes a pre-cutoff seed-core set (coversUpTo 0, another log) skippable', async () => {
    const source = testLog('cd'.repeat(32));
    for (let i = 0; i < 30; i++) source.append(put(`S${i}`, { v: i }, 1 + i));
    const core = testLog('ef'.repeat(32));
    core.ops.push(
      ...buildSnapshotOps({ ops: source.history, coversUpTo: 0, author_pubkey: 'me', ts: LEGACY_TS, schema_version: 1, excludeTables: ['presence'] }),
    );
    const pg: Pg = new Map();
    expect(await fold([core], createMergeCursor(), pg)).toBe(30);
    expect(Object.fromEntries(pg)).toEqual(await historyOracle(source));
  });
});

describe('P-008 (f) a seeded set checkpoints by ROWS, so a restart resumes mid-set', () => {
  it(`persists inside a ${MERGE_PERSIST_EVERY_OPS}+-row set, at a chunk boundary`, async () => {
    const log = testLog();
    const n = MERGE_PERSIST_EVERY_OPS * 2;
    for (let i = 0; i < n; i++) log.append(put(`K${i}`, { v: i }, 1 + i));
    const set = log.appendSet({ maxChunkBytes: 200_000 });
    expect(set.chunkCount).toBeGreaterThanOrEqual(3);
    expect(set.rowCount).toBe(n);

    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor);
    const persisted: number[] = [];
    await fold([log], cursor, new Map(), { onPersist: (p) => persisted.push(p.get(KEY)!) });
    const inside = persisted.filter((p) => p > set.coversUpTo && p < set.coversUpTo + set.chunkCount);
    expect(inside.length).toBeGreaterThan(0);
  });
});

describe('P-008 (g) combineSnapshotApplyMarks — the durable mark under the WI-3985 min position', () => {
  it('takes the max watermark and keeps any hole', () => {
    const none: SnapshotApplyMark = { applyThrough: NO_SNAPSHOT_APPLY, hole: null };
    expect(combineSnapshotApplyMarks(none, none)).toEqual(none);
    expect(combineSnapshotApplyMarks({ applyThrough: 40, hole: null }, { applyThrough: 7, hole: null })).toEqual({ applyThrough: 40, hole: null });
    expect(combineSnapshotApplyMarks({ applyThrough: NO_SNAPSHOT_APPLY, hole: 3 }, { applyThrough: 12, hole: null })).toEqual({ applyThrough: 12, hole: 3 });
    expect(combineSnapshotApplyMarks({ applyThrough: 1, hole: 3 }, { applyThrough: 1, hole: 9 })).toEqual({ applyThrough: 1, hole: 9 });
  });
});

describe('P-008 (h) randomized: restarts at arbitrary points never change the folded state', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  for (const seed of [1, 7, 42, 1234]) {
    it(`seed ${seed}: sequential and seeded readers restarting every few ops match the history oracle`, async () => {
      const r = rng(seed);
      const log = testLog();
      let ts = 1;
      for (let step = 0; step < 6; step++) {
        const n = 20 + Math.floor(r() * 60);
        for (let i = 0; i < n; i++) {
          const k = `K${Math.floor(r() * 25)}`;
          log.append(r() < 0.2 ? del(k, ts++) : put(k, { v: ts }, ts++));
        }
        if (r() < 0.8) log.appendSet({ maxChunkBytes: 300 + Math.floor(r() * 1_500), ts: ts + 10 });
      }
      const oracle = await historyOracle(log);

      for (const seeded of [false, true]) {
        const store = memStore();
        const pg: Pg = new Map();
        let cursor = createMergeCursor();
        if (seeded) await seedCursorFromSnapshots([log], cursor);
        while ((cursor.positions.get(KEY) ?? 0) < log.length) {
          await fold([log], cursor, pg, { budget: 1 + Math.floor(r() * 9), store });
          cursor = await restart(store);
        }
        expect(Object.fromEntries(pg)).toEqual(oracle);
      }
    });
  }
});
