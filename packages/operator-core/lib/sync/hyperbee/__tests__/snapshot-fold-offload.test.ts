/**
 * WI-10002855 — the own-log compaction fold runs in a worker thread.
 *
 * The inline fold of the tower's first papercusp compaction (7.76M ops from index 0)
 * held bg-host's event loop for 30+ minutes: lag p50 2.8s, every PG connect timed out,
 * routines and git-sync stalled. These tests pin the replacement:
 *  - the offloaded producer preserves the inline producer's captured row bytes, for a
 *    fresh fold, a seeded fold (a prior set on the log) and deletes/tombstones — using
 *    the REAL worker thread, so the worker loading under this runtime is itself proven;
 *  - the raw read/append seam round-trips exactly what the json session stores;
 *  - a worker that cannot start fails the compaction (no silent inline fallback);
 *  - the worker's state machine refuses out-of-order use and releases its fold on finish.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type OwnLog, type PeerLogOp } from '../peer-log';
import {
  produceLogSnapshot,
  SnapshotAbortedError,
  SNAPSHOT_READ_CONCURRENCY,
  type ProduceSnapshotResult,
  type SnapshotPayload,
} from '../log-snapshot';
import {
  acquireSnapshotFoldSlot,
  SNAPSHOT_FOLD_MAX_CONCURRENT,
  SnapshotFoldWorker,
  snapshotFoldSlotState,
} from '../snapshot-fold-offload';
import {
  createSnapshotFoldHandler,
  encodeStoredBlock,
  packBlocks,
  type SnapshotFoldResponse,
} from '../snapshot-fold-protocol';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { createHiveEpochCrypto } from '../hive-epoch-crypto-impl';
import type { EpochKey } from '../hive-epoch-crypto';
import { buildOpAAD } from '../hive-epoch-serving';
import { isValidOpHlc } from '../hlc-stamp';
import { encodeHlc, processHlc } from '@papercusp/locks-core';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * Every log shares ONE fixed primary key, so each store derives the SAME peer-log
 * keypair. The snapshot chunks embed `author_pubkey` (the log key), so without this two
 * logs could never produce identical bytes and the byte comparisons below would be
 * vacuous in the other direction — always failing for a reason unrelated to the fold.
 */
const TEST_PRIMARY_KEY = Buffer.alloc(32, 7);

async function freshLog(): Promise<OwnLog> {
  const dir = mkdtempSync(join(tmpdir(), 'wi10002855-'));
  const store = new Corestore(dir, { primaryKey: TEST_PRIMARY_KEY, unsafe: true });
  cleanups.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return openOwnLog(store);
}

/** Enough ops to span several read windows, with overwrites and deletes. */
function history(count: number, salt = ''): PeerLogOp[] {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < count; i++) {
    const key = `K-${i % 97}`;
    ops.push(
      i % 13 === 5
        ? {
            type: 'del',
            table: 'wi10002855_t',
            hbKey: key,
            value: null,
            ts: 10_000 + i,
            schema_version: CURRENT_SCHEMA_VERSION,
            author_pubkey: '', // the owner's single-writer log writes ''
          }
        : {
            type: 'put',
            table: i % 3 === 0 ? 'wi10002855_a' : 'wi10002855_t',
            hbKey: key,
            value: { i, salt, note: 'é∑ unicode survives the raw path' },
            ts: 10_000 + i,
            schema_version: CURRENT_SCHEMA_VERSION,
            author_pubkey: '',
          },
    );
  }
  // Every fixture replays one captured history into both independent logs.
  return ops.map((op, i) => ({ ...op, hlc: `${String(10_000 + i).padStart(15, '0')}:00000` }));
}

/** Compare all stored bytes except newly allocated snapshot-envelope clocks. */
async function comparableRange(log: OwnLog, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const raw = (await log.getRaw!(i))!;
    const op = JSON.parse(Buffer.from(raw).toString()) as PeerLogOp;
    if (op.table === '__snapshot__') {
      expect(isValidOpHlc(op.hlc), `snapshot envelope ${i} has a canonical HLC`).toBe(true);
      const { hlc: _hlc, ...rest } = op;
      out.push(Buffer.from(JSON.stringify(rest)).toString('hex'));
    } else out.push(Buffer.from(raw).toString('hex'));
  }
  return out;
}

/** Every row of the snapshot set at `[coversUpTo, coversUpTo + chunkCount)`. */
async function setRows(log: OwnLog, coversUpTo: number, chunkCount: number): Promise<SnapshotPayload['rows']> {
  const rows: SnapshotPayload['rows'] = [];
  for (let i = 0; i < chunkCount; i++) {
    rows.push(...(((await log.get(coversUpTo + i))?.value as SnapshotPayload | undefined)?.rows ?? []));
  }
  return rows;
}

/**
 * D-025 — both paths build and append under the own log's append hold, and each reports
 * how long it held other appends. That is wall-clock, so it is checked for presence and
 * dropped before the byte-identity comparison.
 */
function heldResult(result: ProduceSnapshotResult): Omit<ProduceSnapshotResult, 'appendsHeldMs'> {
  const { appendsHeldMs, ...rest } = result;
  expect(appendsHeldMs).toBeGreaterThanOrEqual(0);
  return rest;
}

const NOW = 50_000;
const inlineOpts ={ now: NOW, schemaVersion: CURRENT_SCHEMA_VERSION, maxChunkBytes: 2_048 };
const offloadOpts = {
  ...inlineOpts,
  foldWorker: (init: { excludeTables: readonly string[] }) => SnapshotFoldWorker.open(init),
};

describe('the raw block seam (OwnLog.getRaw / appendRawBatch)', () => {
  it('stamps fresh worker envelopes on the producer clock without restamping captured rows', async () => {
    const log = await freshLog();
    const original = { ...history(1)[0]!, hlc: '000000000010000:00000' };
    await log.append(original);
    const before = encodeHlc(processHlc().peek());
    const result = await produceLogSnapshot(log, offloadOpts);
    const snapshot = (await log.get(result.coversUpTo))!;
    expect(isValidOpHlc(snapshot.hlc)).toBe(true);
    expect(snapshot.hlc! > before).toBe(true);
    const { type: _type, ...capturedRow } = original;
    expect((snapshot.value as SnapshotPayload).rows[0]).toEqual(capturedRow);
    await log.append({ ...original, hlc: undefined });
    expect((await log.get(log.length - 1))!.hlc! > snapshot.hlc!).toBe(true);
  });

  it('reads the exact bytes the json session stores, and appends bytes that read back as the op', async () => {
    const log = await freshLog();
    const [op] = history(1);
    await log.append(op!);
    const raw = await log.getRaw!(0);
    expect(Buffer.from(raw!).equals(Buffer.from(encodeStoredBlock(op!)))).toBe(true);
    await log.appendRawBatch!([encodeStoredBlock(op!)]);
    expect(await log.get(1)).toEqual(await log.get(0));
    expect(await log.getRaw!(2)).toBeNull();
    expect(await log.getRaw!(-1)).toBeNull();
  });
});

describe('offloaded own compaction is byte-identical to the inline fold (real worker thread)', () => {
  it('fresh fold from index 0 across several read windows', async () => {
    const ops = history(SNAPSHOT_READ_CONCURRENCY * 3 + 17);
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);

    const inline = await produceLogSnapshot(a, inlineOpts);
    const offloaded = await produceLogSnapshot(b, offloadOpts);

    expect(heldResult(offloaded)).toEqual(heldResult(inline));
    expect(inline.appended).toBe(true);
    expect(inline.chunkCount).toBeGreaterThan(1); // the small chunk cap forces a multi-chunk set
    expect(await comparableRange(b, 0, b.length)).toEqual(await comparableRange(a, 0, a.length));
  });

  it('WI-10005425: a filtered own-log set carries ownPrefix on every chunk on both paths, byte-identically', async () => {
    const ops = history(SNAPSHOT_READ_CONCURRENCY * 2 + 5);
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);
    const excludeTables = ['wi10002855_a'];

    const inline = await produceLogSnapshot(a, { ...inlineOpts, excludeTables });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, excludeTables });

    expect(heldResult(offloaded)).toEqual(heldResult(inline));
    expect(inline.chunkCount).toBeGreaterThan(1);
    expect(await comparableRange(b, 0, b.length)).toEqual(await comparableRange(a, 0, a.length));
    for (let i = 0; i < offloaded.chunkCount; i++) {
      const v = (await b.get(offloaded.coversUpTo + i))?.value as SnapshotPayload;
      expect(v.excludeTables).toEqual(excludeTables);
      expect(v.ownPrefix).toBe(true);
    }
  });

  it('applies the P-530 live-receipt census identically inline and in the worker', async () => {
    const receipt = (hbKey: string): PeerLogOp => ({
      type: 'put',
      table: 'engineer-issues',
      hbKey,
      value: { payload: { resource_governor: { schemaVersion: 1, state: 'completed' } } },
      ts: 20_000,
      schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: '',
      hlc: '000000000020000:00000',
    });
    const ops: PeerLogOp[] = [
      receipt('papercusp/WI-DEAD'),
      receipt('papercusp/WI-LIVE'),
      { ...receipt('papercusp/WI-NORMAL'), value: { payload: { real_work: true } } },
    ];
    const filter = {
      maxSourceIndexExclusive: ops.length,
      liveQualifiedKeys: ['papercusp/WI-LIVE'],
    };
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);

    const inline = await produceLogSnapshot(a, { ...inlineOpts, governorReceiptFilter: filter });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, governorReceiptFilter: filter });

    expect(heldResult(offloaded)).toEqual(heldResult(inline));
    expect(inline.droppedGovernorReceipts).toBe(1);
    expect(inline.rowCount).toBe(2);
    expect(await comparableRange(b, 0, b.length)).toEqual(await comparableRange(a, 0, a.length));
    const rows = Array.from({ length: inline.chunkCount }, (_, i) => i)
      .map((i) => a.get(inline.coversUpTo + i))
      .reduce(
        async (accP, opP) => {
          const acc = await accP;
          const op = await opP;
          return acc.concat((op?.value as SnapshotPayload | undefined)?.rows ?? []);
        },
        Promise.resolve([] as SnapshotPayload['rows']),
      );
    await expect(rows).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hbKey: 'papercusp/WI-LIVE' }),
        expect.objectContaining({ hbKey: 'papercusp/WI-NORMAL' }),
      ]),
    );
    await expect(rows).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hbKey: 'papercusp/WI-DEAD' })]),
    );
  });

  /**
   * D-024 — own-log engineer-issues rows are `{__rekey}` envelopes, so P-530 only sees a
   * receipt through the epoch key. Sealed with the REAL encryptOp + AAD derivation, so a
   * framing drift between the writer and the filter fails here.
   */
  const epochCrypto = createHiveEpochCrypto();
  const EPOCH1_KEY = new Uint8Array(32).fill(9) as EpochKey;
  const EPOCH2_KEY = new Uint8Array(32).fill(4) as EpochKey;
  const sealedIssue = async (hbKey: string, value: unknown, epoch = 1): Promise<PeerLogOp> => {
    const ct = await epochCrypto.encryptOp(
      new TextEncoder().encode(JSON.stringify(value)),
      epoch === 1 ? EPOCH1_KEY : EPOCH2_KEY,
      buildOpAAD('papercusp', epoch, { tableTag: 'engineer-issues', rowKey: hbKey, authorPubkey: '' }),
    );
    return {
      type: 'put',
      table: 'engineer-issues',
      hbKey,
      value: { __rekey: Buffer.from(ct).toString('base64') },
      epoch,
      ts: 20_000,
      schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: '',
    };
  };
  const governorReceipt = { payload: { resource_governor: { schemaVersion: 1, state: 'completed' } } };
  const envelopeKeys = { potId: 'papercusp', keys: [{ epoch: 1, key: EPOCH1_KEY }] };

  it('D-024: opens encrypted rows and drops an absent receipt identically inline and in the worker', async () => {
    const ops = [
      await sealedIssue('papercusp/WI-DEAD', governorReceipt),
      await sealedIssue('papercusp/WI-LIVE', governorReceipt),
      await sealedIssue('papercusp/WI-NORMAL', { payload: { real_work: true } }),
      // No key for epoch 2 here: kept, and counted so the gap is visible.
      await sealedIssue('papercusp/WI-EPOCH2', governorReceipt, 2),
    ];
    const filter = { maxSourceIndexExclusive: ops.length, liveQualifiedKeys: ['papercusp/WI-LIVE'], envelopeKeys };
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);

    const inline = await produceLogSnapshot(a, { ...inlineOpts, governorReceiptFilter: filter });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, governorReceiptFilter: filter });

    expect(heldResult(offloaded)).toEqual(heldResult(inline));
    expect(inline).toMatchObject({ droppedGovernorReceipts: 1, unopenedGovernorEnvelopes: 1, rowCount: 3 });
    const keys = (await setRows(a, inline.coversUpTo, inline.chunkCount)).map((r) => r.hbKey).sort();
    expect(keys).toEqual(['papercusp/WI-EPOCH2', 'papercusp/WI-LIVE', 'papercusp/WI-NORMAL']);
  });

  it('D-024: without envelope keys an encrypted receipt is kept (the 00:07Z tower outcome)', async () => {
    const log = await freshLog();
    await log.appendBatch([await sealedIssue('papercusp/WI-DEAD', governorReceipt)]);
    const snap = await produceLogSnapshot(log, {
      ...offloadOpts,
      governorReceiptFilter: { maxSourceIndexExclusive: 1, liveQualifiedKeys: [] },
    });
    // Kept, but no longer silent: the unopened count is what 00:07Z lacked.
    expect(snap).toMatchObject({ droppedGovernorReceipts: 0, unopenedGovernorEnvelopes: 1, rowCount: 1 });
  });

  it('D-024: a seeded worker fold drops a receipt carried in by the prior set', async () => {
    const log = await freshLog();
    await log.appendBatch([
      await sealedIssue('papercusp/WI-DEAD', governorReceipt),
      await sealedIssue('papercusp/WI-NORMAL', { payload: { real_work: true } }),
    ]);
    // The keyless compaction publishes a set that still carries the dead receipt.
    const first = await produceLogSnapshot(log, {
      ...offloadOpts,
      governorReceiptFilter: { maxSourceIndexExclusive: log.length, liveQualifiedKeys: [] },
    });
    expect(first).toMatchObject({ droppedGovernorReceipts: 0, unopenedGovernorEnvelopes: 2, rowCount: 2 });
    await log.append(await sealedIssue('papercusp/WI-TAIL', { payload: { real_work: true } }));

    // The keyed compaction seeds from that set: the receipt reaches the filter as a
    // snapshot ROW, so its epoch + author_pubkey must be threaded from the row.
    const second = await produceLogSnapshot(log, {
      ...offloadOpts,
      priorSnapshotHint: { coversUpTo: first.coversUpTo, chunkCount: first.chunkCount },
      governorReceiptFilter: { maxSourceIndexExclusive: log.length, liveQualifiedKeys: [], envelopeKeys },
    });
    expect(second).toMatchObject({ appended: true, droppedGovernorReceipts: 1, unopenedGovernorEnvelopes: 0 });
    const keys = (await setRows(log, second.coversUpTo, second.chunkCount)).map((r) => r.hbKey).sort();
    expect(keys).toEqual(['papercusp/WI-NORMAL', 'papercusp/WI-TAIL']);
  });

  it('seeded fold: a prior complete set on the log is found by the summary seek and folded in the worker', async () => {
    const a = await freshLog();
    const b = await freshLog();
    for (const log of [a, b]) {
      await log.appendBatch(history(300, 'first'));
      await produceLogSnapshot(log, inlineOpts); // the prior set, written the same way on both
      await log.appendBatch(history(120, 'second'));
    }
    const hint = { coversUpTo: 300, chunkCount: (await produceLogSnapshotPeek(a)).chunkCount };

    const inline = await produceLogSnapshot(a, { ...inlineOpts, priorSnapshotHint: hint });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, priorSnapshotHint: hint });

    expect(heldResult(offloaded)).toEqual(heldResult(inline));
    expect(await comparableRange(b, 0, b.length)).toEqual(await comparableRange(a, 0, a.length));
  });

  it('an empty log appends nothing on either path', async () => {
    const log = await freshLog();
    expect(await produceLogSnapshot(log, offloadOpts)).toEqual({
      appended: false,
      coversUpTo: 0,
      rowCount: 0,
      chunkCount: 0,
    });
  });

  it('reports fold progress from the worker path, monotonically, ending at the log length', async () => {
    const log = await freshLog();
    await log.appendBatch(history(SNAPSHOT_READ_CONCURRENCY * 2 + 3));
    const seen: number[] = [];
    await produceLogSnapshot(log, { ...offloadOpts, onProgress: (p) => seen.push(p.processed) });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(seen[seen.length - 1]).toBe(SNAPSHOT_READ_CONCURRENCY * 2 + 3);
  });

  it('shouldAbort stops a running fold between windows and appends nothing', async () => {
    const log = await freshLog();
    await log.appendBatch(history(SNAPSHOT_READ_CONCURRENCY * 4));
    const lengthBefore = log.length;
    let windows = 0;
    await expect(
      produceLogSnapshot(log, { ...offloadOpts, onProgress: () => void windows++, shouldAbort: () => windows >= 1 }),
    ).rejects.toThrow(/aborted mid-fold/);
    expect(log.length).toBe(lengthBefore);
  });
});

/** chunkCount of the newest set: it is the only snapshot on the log in the seeded test. */
async function produceLogSnapshotPeek(log: OwnLog): Promise<{ chunkCount: number }> {
  const op = await log.get(300);
  return { chunkCount: (op!.value as { chunkCount: number }).chunkCount };
}

describe('no inline fallback: a worker that cannot run fails the compaction', () => {
  it('open() rejects when the worker script does not exist', async () => {
    await expect(
      SnapshotFoldWorker.open(
        { excludeTables: [] },
        { workerPath: join(tmpdir(), 'no-such-snapshot-fold.worker.mjs') },
      ),
    ).rejects.toBeTruthy();
  });

  it('the producer surfaces the failure and appends nothing', async () => {
    const log = await freshLog();
    await log.appendBatch(history(10));
    await expect(
      produceLogSnapshot(log, {
        ...inlineOpts,
        foldWorker: () => Promise.reject(new Error('worker unavailable')),
      }),
    ).rejects.toThrow(/worker unavailable/);
    expect(log.length).toBe(10);
  });
});

describe('the worker state machine (createSnapshotFoldHandler)', () => {
  const block = (op: PeerLogOp) => packBlocks([encodeStoredBlock(op)]);

  it('refuses a fold before init, and after finish released the fold', () => {
    const handle = createSnapshotFoldHandler();
    const [op] = history(1);
    const before: SnapshotFoldResponse = handle({ kind: 'fold', id: 1, ...block(op!) }).res;
    expect(before.kind).toBe('error');

    expect(handle({ kind: 'init', id: 2, excludeTables: [] }).res.kind).toBe('ok');
    const folded = handle({ kind: 'fold', id: 3, ...block(op!), sourceStart: 0 }).res;
    expect(folded).toMatchObject({ kind: 'folded', decodedOps: 1, keyCount: 1 });
    // P-006: the fold is index-only, so finish refuses until the winner's block is read back.
    const early = { kind: 'finish' as const, now: NOW, coversUpTo: 1, author_pubkey: 'k', ts: NOW, schema_version: CURRENT_SCHEMA_VERSION, excludeTables: [] };
    expect(handle({ ...early, id: 30 }).res).toMatchObject({ kind: 'error', message: expect.stringMatching(/not materialized/) });
    expect(handle({ kind: 'pending', id: 31 }).res).toEqual({ kind: 'pending', id: 31, indexes: [0] });
    expect(handle({ kind: 'materialize', id: 32, ...block(op!), indexes: [0], now: NOW }).res).toMatchObject({
      kind: 'materialized',
      remaining: 0,
    });
    const finished = handle({
      kind: 'finish',
      id: 4,
      now: NOW,
      coversUpTo: 1,
      author_pubkey: 'k',
      ts: NOW,
      schema_version: CURRENT_SCHEMA_VERSION,
      excludeTables: [],
    });
    expect(finished.res).toMatchObject({ kind: 'finished', rowCount: 1 });
    expect(finished.transfer).toHaveLength(1);
    expect(handle({ kind: 'fold', id: 5, ...block(op!) }).res.kind).toBe('error');
  });

  it('inspect returns snapshot metadata without rows, and keeps non-snapshot ops tiny', () => {
    const handle = createSnapshotFoldHandler();
    const snapshotOp = {
      type: 'put',
      table: '__snapshot__',
      hbKey: 'snap',
      ts: 1,
      schema_version: CURRENT_SCHEMA_VERSION,
      value: { coversUpTo: 7, chunkIdx: 0, chunkCount: 2, excludeTables: ['x'], rows: [{ table: 't', hbKey: 'k' }] },
    } as unknown as PeerLogOp;
    const [plain] = history(1);
    const res = handle({
      kind: 'inspect',
      id: 1,
      ...packBlocks([encodeStoredBlock(snapshotOp), null, encodeStoredBlock(plain!)]),
    }).res;
    expect(res.kind).toBe('inspected');
    const ops = (res as Extract<SnapshotFoldResponse, { kind: 'inspected' }>).ops;
    expect(ops[0]!.value).toEqual({ coversUpTo: 7, chunkIdx: 0, chunkCount: 2, excludeTables: ['x'], rows: [] });
    expect(ops[1]).toBeNull();
    expect(ops[2]).not.toHaveProperty('value');
  });
});

/**
 * WI-10002836 — the per-worker heap cap bounds the host only if folds do not stack: one
 * bg-host boots ~100 pots, many due at the same boot. `SnapshotFoldWorker.open` therefore
 * takes a process-wide fold slot, held until the worker is gone. A leaked slot would freeze
 * every other pot's compaction forever, so each release path is pinned here.
 */
describe('process-wide fold slots (SNAPSHOT_FOLD_MAX_CONCURRENT)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('allows one fold at a time by default', () => {
    expect(SNAPSHOT_FOLD_MAX_CONCURRENT).toBe(1);
  });

  it('a second acquire waits for the first release; release is idempotent', async () => {
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
    const release1 = await acquireSnapshotFoldSlot();
    let granted2 = false;
    const second = acquireSnapshotFoldSlot().then((r) => {
      granted2 = true;
      return r;
    });
    await settle();
    expect(granted2).toBe(false);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });

    release1();
    const release2 = await second;
    expect(granted2).toBe(true);
    release1(); // a double release must not hand out a second concurrent slot
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    release2();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('an abort while queued rejects with SnapshotAbortedError and leaves the queue', async () => {
    const release1 = await acquireSnapshotFoldSlot();
    const ac = new AbortController();
    const queued = acquireSnapshotFoldSlot(ac.signal);
    await settle();
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    release1();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('an already-aborted signal is refused without taking a slot', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquireSnapshotFoldSlot(ac.signal)).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a second worker waits while one is open, and close() hands the slot on (real worker)', async () => {
    const first = await SnapshotFoldWorker.open({ excludeTables: [] });
    let opened2 = false;
    const secondOpen = SnapshotFoldWorker.open({ excludeTables: [] }).then((w) => {
      opened2 = true;
      return w;
    });
    await settle();
    expect(opened2).toBe(false);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });
    await first.close();
    const second = await secondOpen;
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    await second.close();
    await second.close(); // idempotent
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a worker that dies without close() (e.g. a heap-cap OOM) still releases its slot', async () => {
    const w = await SnapshotFoldWorker.open({ excludeTables: [] });
    expect(snapshotFoldSlotState().active).toBe(1);
    await (w as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await vi.waitFor(() => expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 }));
    await expect(w.fold([])).rejects.toThrow(/exited unexpectedly/);
    await w.close();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a worker that cannot start releases its slot', async () => {
    await expect(
      SnapshotFoldWorker.open(
        { excludeTables: [] },
        { workerPath: join(tmpdir(), 'no-such-snapshot-fold.worker.mjs') },
      ),
    ).rejects.toBeTruthy();
    await vi.waitFor(() => expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 }));
  });
});
