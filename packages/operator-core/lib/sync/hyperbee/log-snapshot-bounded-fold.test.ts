/**
 * memory-reduction-2026-09-24 R-1 / P-006 (WI-10003473) — bg-host compaction runs in
 * bounded memory and resumes.
 *
 * Pins the two halves of the bar:
 *  1. BOUNDED: the scan retains only per-key winning positions. The scan state is exactly
 *     what `exportCheckpoint` serializes, so identical checkpoints for a log of tiny values
 *     and the same log with 64 KiB values prove retention is independent of value size —
 *     and the rows it finally emits are byte-identical to the old value-holding folder
 *     (`SnapshotRowFolder`), across puts, deletes, prior snapshot sets, exclusions and a
 *     dropping transform.
 *  2. RESUMES: a fold interrupted mid-scan persists its cursor; the next run starts
 *     scanning AT that cursor (never index 0) and still appends the same bytes as an
 *     uninterrupted fold. A checkpoint that does not fit is refused, and the fold falls
 *     back to a correct full scan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnapshotOps,
  buildSnapshotOpsFromRows,
  DROP_SNAPSHOT_ROW,
  produceLogSnapshot,
  SnapshotAbortedError,
  SnapshotRowFolder,
  SNAPSHOT_READ_CONCURRENCY,
  type SnapshotFoldCheckpointStore,
  type SnapshotFoldWorkerFactory,
  type SnapshotFoldWorkerLike,
  type SnapshotValueTransform,
} from './log-snapshot';
import { SnapshotIndexFolder } from './snapshot-index-fold';
import { SnapshotFoldWorker } from './snapshot-fold-offload';
import { encodeStoredBlock } from './snapshot-fold-protocol';
import { openOwnLog, type OwnLog, type PeerLogOp } from './peer-log';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { shouldDropGovernorReceiptSnapshotRow, type GovernorReceiptSnapshotFilter } from './governor-receipt-snapshot-filter';

const NOW = 50_000_000_000;
const SV = CURRENT_SCHEMA_VERSION;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Fixed primary key: every store derives the same log key, so appended bytes are comparable. */
const TEST_PRIMARY_KEY = Buffer.alloc(32, 9);

async function freshLog(): Promise<OwnLog> {
  const dir = mkdtempSync(join(tmpdir(), 'p006-bounded-fold-'));
  const store = new Corestore(dir, { primaryKey: TEST_PRIMARY_KEY, unsafe: true });
  cleanups.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return openOwnLog(store);
}

function memoryStore(): SnapshotFoldCheckpointStore & { bytes: Uint8Array | null; saves: number } {
  const s = {
    bytes: null as Uint8Array | null,
    saves: 0,
    async load() {
      return s.bytes;
    },
    async save(b: Uint8Array) {
      s.bytes = b;
      s.saves += 1;
    },
    async clear() {
      s.bytes = null;
    },
  };
  return s;
}

/** Overwrites, deletes, two tables; `pad` bytes of filler in each put value. */
function history(count: number, pad = 0, salt = ''): PeerLogOp[] {
  const filler = 'x'.repeat(pad);
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < count; i++) {
    const hbKey = `K-${i % 89}`;
    ops.push(
      i % 11 === 4
        ? { type: 'del', table: 't', hbKey, value: null, ts: NOW - 1000 + i, schema_version: SV, author_pubkey: '' }
        : {
            type: 'put',
            table: i % 3 === 0 ? 'a' : 't',
            hbKey,
            value: { i, salt, filler },
            ts: NOW - 1000 + i,
            schema_version: SV,
            author_pubkey: '',
            ...(i % 7 === 0 ? { hlc: `${i}:0000:${salt || 'n'}` } : {}),
          },
    );
  }
  return ops;
}

/** Scan state after folding `ops` from index 0 — what a checkpoint at the end would hold. */
function scanState(ops: readonly PeerLogOp[], opts?: { excludeTables?: string[] }): string {
  const f = new SnapshotIndexFolder(opts);
  ops.forEach((op, i) => f.add(op, i));
  return new TextDecoder().decode(f.exportCheckpoint({ logKey: 'k', cursor: ops.length }));
}

/** The index fold run end to end over an in-memory log (decoded ops stand in for blocks). */
function indexFoldBlocks(
  ops: readonly PeerLogOp[],
  opts: { excludeTables?: string[]; transformValue?: SnapshotValueTransform; maxChunkBytes?: number },
): string[] {
  const f = new SnapshotIndexFolder(opts);
  ops.forEach((op, i) => f.add(op, i));
  const idx = f.pendingBlockIndexes();
  // Materialize in two batches, as the byte-bounded caller does.
  const half = Math.ceil(idx.length / 2);
  for (const part of [idx.slice(0, half), idx.slice(half)]) {
    f.materialize(
      part.map((i) => ops[i]!),
      part,
      { now: NOW },
    );
  }
  const { blocks } = f.finishBlocks({
    coversUpTo: ops.length,
    author_pubkey: 'author',
    ts: NOW,
    schema_version: SV,
    maxChunkBytes: opts.maxChunkBytes,
    excludeTables: opts.excludeTables ?? [],
  });
  return blocks.map((b) => new TextDecoder().decode(b));
}

/** The OLD fold (SnapshotRowFolder holds every winning value), encoded the same way. */
function rowFoldBlocks(
  ops: readonly PeerLogOp[],
  opts: { excludeTables?: string[]; transformValue?: SnapshotValueTransform; maxChunkBytes?: number },
): string[] {
  const f = new SnapshotRowFolder(opts);
  ops.forEach((op, i) => f.add(op, op.value, i));
  return buildSnapshotOpsFromRows({
    rows: f.finish({ now: NOW }),
    coversUpTo: ops.length,
    author_pubkey: 'author',
    ts: NOW,
    schema_version: SV,
    maxChunkBytes: opts.maxChunkBytes,
    excludeTables: opts.excludeTables ?? [],
  }).map((op) => new TextDecoder().decode(encodeStoredBlock(op)));
}

describe('legacy engineer-issue receipt filtering across both folds', () => {
  it('filters raw and prior-snapshot aliases identically and retains authenticated headers', () => {
    const filter: GovernorReceiptSnapshotFilter = {
      maxSourceIndexExclusive: 2,
      liveQualifiedKeys: ['papercusp/WI-COLLISION', 'papercusp/WI-LIVE'],
    };
    const transformValue: SnapshotValueTransform = (value, context) =>
      shouldDropGovernorReceiptSnapshotRow(value, context, filter) ? DROP_SNAPSHOT_ROW : value;
    const receipt = (issueId: string, scope: string, storageHarnessSlug?: string) => ({
      issue_id: issueId,
      scope,
      ...(storageHarnessSlug ? { storage_harness_slug: storageHarnessSlug } : {}),
      payload: { resource_governor: { schemaVersion: 1, state: 'completed' } },
    });
    const priorRows = [
      {
        table: 'engineer-issues', hbKey: 'WI-COLLISION',
        value: receipt('WI-COLLISION', 'harness:papercup'),
        ts: NOW - 3, schema_version: SV, epoch: 21, author_pubkey: 'retired-author',
      },
      {
        table: 'engineer-issues', hbKey: 'papercusp/WI-COLLISION',
        value: receipt('WI-COLLISION', 'harness:papercusp', 'papercusp'),
        ts: NOW - 2, schema_version: SV, epoch: 22, author_pubkey: 'qualified-author',
      },
      {
        table: 'engineer-issues', hbKey: 'WI-LIVE',
        value: receipt('WI-LIVE', 'harness:papercusp', 'papercusp'),
        ts: NOW - 1, schema_version: SV, epoch: 23, author_pubkey: 'bare-author',
      },
    ];
    const ops: PeerLogOp[] = [
      {
        type: 'put', table: 'engineer-issues', hbKey: 'WI-RAW',
        value: receipt('WI-RAW', 'harness:papercup'),
        ts: NOW - 4, schema_version: SV, epoch: 20, author_pubkey: 'raw-author',
      },
      {
        type: 'put', table: '__snapshot__', hbKey: 'snapshot/0',
        value: { coversUpTo: 1, chunkIndex: 0, chunkCount: 1, rows: priorRows },
        ts: NOW, schema_version: SV, author_pubkey: 'snapshot-author',
      },
    ];
    const opts = { transformValue };
    const rowFold = rowFoldBlocks(ops, opts);
    expect(indexFoldBlocks(ops, opts)).toEqual(rowFold);
    const rows = rowFold.flatMap((block) => {
      const op = JSON.parse(block) as PeerLogOp;
      return (op.value as { rows: Array<{ hbKey: string; value: unknown; epoch?: number; author_pubkey?: string }> }).rows;
    });
    expect(rows.map((row) => row.hbKey).sort()).toEqual(['WI-LIVE', 'papercusp/WI-COLLISION'].sort());
    expect(rows.find((row) => row.hbKey === 'WI-LIVE')).toMatchObject({
      epoch: 23, author_pubkey: 'bare-author', value: receipt('WI-LIVE', 'harness:papercusp', 'papercusp'),
    });
    expect(rows.find((row) => row.hbKey === 'papercusp/WI-COLLISION')).toMatchObject({
      epoch: 22, author_pubkey: 'qualified-author',
    });
  });
});

describe('R-1 bounded: the scan retains winning positions only', () => {
  it('scan state is identical whether values are 1 byte or 64 KiB (retention independent of value size)', () => {
    const small = history(2_000, 1);
    const big = history(2_000, 64 * 1024);
    const smallState = scanState(small);
    expect(scanState(big)).toBe(smallState);
    // Positive control: the state is not vacuous — it names every live key, and it does
    // change when the WINNING POSITION changes.
    expect(smallState).toContain('K-88');
    expect(scanState(history(2_001, 1))).not.toBe(smallState);
    // And it is tiny next to what the old folder held for the big log.
    const bigValueBytes = big.reduce((n, op) => n + JSON.stringify(op.value).length, 0);
    expect(smallState.length).toBeLessThan(bigValueBytes / 100);
  });

  it('a prior snapshot set expands to positions too, never to its rows', () => {
    const ops = history(600, 32 * 1024);
    const snapshot = buildSnapshotOps({ ops, coversUpTo: ops.length, author_pubkey: 'a', ts: NOW, schema_version: SV });
    const tail = history(50, 1, 'tail');
    const withSet = [...ops, ...snapshot, ...tail];
    const f = new SnapshotIndexFolder();
    withSet.forEach((op, i) => f.add(op, i));
    const state = new TextDecoder().decode(f.exportCheckpoint({ logKey: 'k', cursor: withSet.length }));
    expect(state).not.toContain('xxxxxxxx');
    expect(f.pendingCount).toBe(f.keyCount);
  });

  it('refuses to checkpoint once materialization has begun, and to finish before it completes', () => {
    const ops = history(40);
    const f = new SnapshotIndexFolder();
    ops.forEach((op, i) => f.add(op, i));
    expect(() => f.finishBlocks({ coversUpTo: 40, author_pubkey: 'a', ts: NOW, schema_version: SV })).toThrow(
      /not materialized/,
    );
    const idx = f.pendingBlockIndexes();
    f.materialize([ops[idx[0]!]!], [idx[0]!], { now: NOW });
    expect(() => f.exportCheckpoint({ logKey: 'k', cursor: 40 })).toThrow(/after materialization/);
  });

  it('an unreadable winner block fails loudly instead of thinning the set', () => {
    const ops = history(20);
    const f = new SnapshotIndexFolder();
    ops.forEach((op, i) => f.add(op, i));
    const idx = f.pendingBlockIndexes();
    expect(() => f.materialize([null], [idx[0]!], { now: NOW })).toThrow(/unreadable/);
  });
});

describe('R-1 equivalence: the index fold emits the old folder’s bytes', () => {
  const opArb = fc.record({
    kind: fc.constantFrom('put', 'put', 'put', 'del', 'snapshot'),
    table: fc.constantFrom('a', 'a-b', 't', 'excluded'),
    key: fc.integer({ min: 0, max: 12 }),
    age: fc.integer({ min: 0, max: 30 }),
    drop: fc.boolean(),
  });

  it('matches SnapshotRowFolder for puts, deletes, prior sets, exclusions, a dropping transform and GC', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), fc.boolean(), (specs, withTransform) => {
        const ops: PeerLogOp[] = [];
        for (const [n, s] of specs.entries()) {
          if (s.kind === 'snapshot') {
            // A prior set summarizing everything so far, appended as the real producer does.
            ops.push(
              ...buildSnapshotOps({
                ops: [...ops],
                coversUpTo: ops.length,
                author_pubkey: 'a',
                ts: NOW,
                schema_version: SV,
                maxChunkBytes: 256,
              }),
            );
            continue;
          }
          // `age` in days: some tombstones fall past the 14-day horizon and are GC'd.
          const ts = NOW - s.age * 24 * 60 * 60 * 1000;
          ops.push(
            s.kind === 'del'
              ? { type: 'del', table: s.table, hbKey: `k${s.key}`, value: null, ts, schema_version: SV, author_pubkey: '' }
              : {
                  type: 'put',
                  table: s.table,
                  hbKey: `k${s.key}`,
                  value: { n, drop: s.drop },
                  ts,
                  schema_version: SV,
                  author_pubkey: '',
                  ...(n % 3 === 0 ? { hlc: `h${n}` } : {}),
                  ...(n % 4 === 0 ? { epoch: 2 } : {}),
                },
          );
        }
        const transformValue: SnapshotValueTransform | undefined = withTransform
          ? (value) =>
              value && typeof value === 'object' && (value as { drop?: boolean }).drop ? DROP_SNAPSHOT_ROW : value
          : undefined;
        const opts = {
          excludeTables: ['excluded'],
          maxChunkBytes: 300,
          ...(transformValue ? { transformValue } : {}),
        };
        expect(indexFoldBlocks(ops, opts)).toEqual(rowFoldBlocks(ops, opts));
      }),
      { numRuns: 300 },
    );
  });
});

/** The real worker, with every call recorded so the test can see WHERE the scan started. */
function recordingWorker(record: { foldStarts: number[]; aborted: { value: boolean }; abortAfterFolds?: number }): SnapshotFoldWorkerFactory {
  return async (init) => {
    const real = await SnapshotFoldWorker.open(init);
    let folds = 0;
    const w: SnapshotFoldWorkerLike = {
      fold: async (blocks, o) => {
        record.foldStarts.push(o?.sourceStart ?? -1);
        const r = await real.fold(blocks, o);
        folds += 1;
        if (record.abortAfterFolds !== undefined && folds >= record.abortAfterFolds) record.aborted.value = true;
        return r;
      },
      inspect: (b) => real.inspect(b),
      pendingIndexes: () => real.pendingIndexes(),
      materialize: (b, i, now) => real.materialize(b, i, now),
      checkpoint: (a) => real.checkpoint(a),
      restore: (b, a) => real.restore(b, a),
      finish: (a) => real.finish(a),
      close: () => real.close(),
    };
    return w;
  };
}

describe('R-1 resume: an interrupted fold continues from its persisted cursor', () => {
  it('resumes AT the saved cursor (not index 0) and appends the bytes of an uninterrupted fold', async () => {
    const ops = history(SNAPSHOT_READ_CONCURRENCY * 5 + 13, 256);
    const interrupted = await freshLog();
    const reference = await freshLog();
    await interrupted.appendBatch(ops);
    await reference.appendBatch(ops);
    const base = { now: NOW, schemaVersion: SV, maxChunkBytes: 4_096 };

    // Run 1: aborted after two windows. The abort persists everything folded so far.
    const store = memoryStore();
    const first = { foldStarts: [] as number[], aborted: { value: false }, abortAfterFolds: 2 };
    await expect(
      produceLogSnapshot(interrupted, {
        ...base,
        foldWorker: recordingWorker(first),
        foldCheckpoint: store,
        shouldAbort: () => first.aborted.value,
      }),
    ).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(interrupted.length, 'an aborted fold appends nothing').toBe(ops.length);
    expect(store.bytes, 'the abort persisted a checkpoint').not.toBeNull();
    const savedCursor = JSON.parse(new TextDecoder().decode(store.bytes!)).cursor as number;
    expect(savedCursor).toBe(SNAPSHOT_READ_CONCURRENCY * 2);

    // Run 2: resumes. The first window scanned starts at the cursor, never at 0.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => errors.mockRestore());
    const second = { foldStarts: [] as number[], aborted: { value: false } };
    const resumed = await produceLogSnapshot(interrupted, {
      ...base,
      foldWorker: recordingWorker(second),
      foldCheckpoint: store,
    });
    expect(second.foldStarts[0]).toBe(savedCursor);
    expect(Math.min(...second.foldStarts)).toBe(savedCursor);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`resuming the fold from checkpoint cursor ${savedCursor}`));
    expect(store.bytes, 'a successful append clears the superseded checkpoint').toBeNull();

    // Same bytes as a fold that was never interrupted (the old inline folder).
    const inline = await produceLogSnapshot(reference, base);
    expect({ ...resumed, appendsHeldMs: 0 }).toEqual({ ...inline, appendsHeldMs: 0 });
    for (let i = 0; i < interrupted.length; i++) {
      expect(Buffer.from((await interrupted.getRaw!(i))!).equals(Buffer.from((await reference.getRaw!(i))!))).toBe(
        true,
      );
    }
  });

  it('a checkpoint for another log, or past the log end, is refused and the fold scans from 0', async () => {
    const ops = history(SNAPSHOT_READ_CONCURRENCY + 40);
    const foreign = new SnapshotIndexFolder();
    ops.slice(0, 100).forEach((op, i) => foreign.add(op, i));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => errors.mockRestore());
    for (const kind of ['other-log', 'past-end'] as const) {
      // A fresh log per case: a successful run appends a set that would seed the next.
      const log = await freshLog();
      await log.appendBatch(ops);
      const bytes =
        kind === 'other-log'
          ? foreign.exportCheckpoint({ logKey: 'someone-else', cursor: 100 })
          : foreign.exportCheckpoint({ logKey: log.keyHex, cursor: ops.length + 5 });
      const store = memoryStore();
      store.bytes = bytes;
      const rec = { foldStarts: [] as number[], aborted: { value: false } };
      const res = await produceLogSnapshot(log, {
        now: NOW,
        schemaVersion: SV,
        foldWorker: recordingWorker(rec),
        foldCheckpoint: store,
      });
      expect(res.appended).toBe(true);
      expect(rec.foldStarts[0]).toBe(0);
    }
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('checkpoint not used: checkpoint is for another log'));
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/checkpoint not used: cursor \d+ is past the log end/));
  });
});
