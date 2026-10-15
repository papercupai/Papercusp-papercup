/**
 * WI-10002836 — the guards against the 2026-09-24 02:38Z OOM recycle of bg-host.
 *
 * The papercusp pot's first own compaction folded all 7.76M ops from index 0 and died at
 * 99.5% with the process at 25.1 GB. Four independent defects compounded; each has a
 * guard here:
 *  (a) boot read an UNREADABLE snapshot scan as "never snapshotted" and armed a fold
 *      from 0 (`discoverOwnCompactionAnchor` must say `known: false`);
 *  (b) every set on that log was a presence-filtered release-cut head snapshot, and the
 *      unfiltered compaction refused to seed from any of them;
 *  (c) the fold from 0 re-expanded every prior set it passed (~1.9M rows, ~4 GB each),
 *      ~120 GB of decoding in the last 3.5% of the log, in 1 GiB windows of 4 MiB chunks;
 *  (d) the worker had no heap cap of its own, so the HOST recycled instead of the fold failing.
 *      Its `resourceLimits` cap is IGNORED under a global --max-old-space-size (bg-host sets
 *      one), so the cap is a soft cap the host enforces from the worker's own heap reports.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type OwnLog, type PeerLogOp } from '../peer-log';
import {
  buildSnapshotOpsFromRows,
  buildSnapshotRows,
  isSeedableForUnfilteredFold,
  isSnapshotBlock,
  OWN_COMPACTION_BACKOFF_MAX_MS,
  ownCompactionBackoffMs,
  produceLogSnapshot,
  SNAPSHOT_TABLE_TAG,
  type SnapshotFoldProgress,
  type SnapshotPayload,
  type SnapshotRow,
} from '../log-snapshot';
import {
  SnapshotFoldHeapCapError,
  SnapshotFoldWorker,
  snapshotFoldWorkerHeapMb,
  SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR,
  SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB,
} from '../snapshot-fold-offload';
import { createSnapshotFoldHandler, encodeStoredBlock, packBlocks } from '../snapshot-fold-protocol';
import { SEED_EXCLUDED_TABLES, SELF_REGENERATING_TABLES } from '../seed-excluded-tables';
import { discoverOwnCompactionAnchor } from '../own-compaction-anchor';
import type { AdmittedLog } from '../read-merge';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Shared primary key: identical histories on two logs then produce identical bytes. */
const TEST_PRIMARY_KEY = Buffer.alloc(32, 9);
const NOW = 50_000;
/** Small chunks, so every set spans several chunk ops (the skip is per op, not per set). */
const CHUNK_BYTES = 2048;
const HOLE_KEY = 'HOLE-KEY';
const FILTERED_TABLE = 'oom_a';

type Path = 'inline' | 'worker';
const PATHS: Path[] = ['inline', 'worker'];

async function freshLog(): Promise<OwnLog> {
  const dir = mkdtempSync(join(tmpdir(), 'wi10002836-'));
  const store = new Corestore(dir, { primaryKey: TEST_PRIMARY_KEY, unsafe: true });
  cleanups.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return openOwnLog(store);
}

function history(count: number, salt: string, opts: { holeAt?: number; presence?: boolean } = {}): PeerLogOp[] {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < count; i++) {
    const base = { ts: 10_000 + ops.length, schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: '' };
    if (i === opts.holeAt) {
      // The ONLY op for this key, so a fold that misses it can learn it only from a set.
      ops.push({ ...base, type: 'put', table: 'oom_t', hbKey: HOLE_KEY, value: { salt } });
    } else if (opts.presence && i % 50 === 0) {
      ops.push({ ...base, type: 'put', table: 'presence', hbKey: 'user/tower', value: { at: i, salt } });
    } else if (i % 13 === 5) {
      ops.push({ ...base, type: 'del', table: 'oom_t', hbKey: `K-${i % 61}`, value: null });
    } else {
      ops.push({
        ...base,
        type: 'put',
        table: i % 3 === 0 ? FILTERED_TABLE : 'oom_t',
        hbKey: `K-${i % 61}`,
        value: { i, salt },
      });
    }
  }
  return ops;
}

async function allOps(log: OwnLog, to = log.length): Promise<PeerLogOp[]> {
  const out: PeerLogOp[] = [];
  for (let i = 0; i < to; i++) out.push((await log.get(i))!);
  return out;
}

async function setRows(log: OwnLog, set: { coversUpTo: number; chunkCount: number }): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for (let j = 0; j < set.chunkCount; j++) rows.push(...((await log.get(set.coversUpTo + j))!.value as SnapshotPayload).rows);
  return rows;
}

async function rawRange(log: OwnLog, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(Buffer.from((await log.getRaw!(i))!).toString('hex'));
  return out;
}

function snapshot(log: OwnLog, path: Path, extra: Partial<Parameters<typeof produceLogSnapshot>[1]> = {}) {
  return produceLogSnapshot(log, {
    now: NOW,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    maxChunkBytes: CHUNK_BYTES,
    ...(path === 'worker' ? { foldWorker: (init) => SnapshotFoldWorker.open(init) } : {}),
    ...extra,
  });
}

/**
 * Three prior sets, the newest of which excludes a table with REAL history, so the final
 * unfiltered compaction must refuse it and fold from 0 — straight through all three.
 */
async function logWithPriorSets(holeAt?: number) {
  const log = await freshLog();
  await log.appendBatch(history(700, 'a', { holeAt }));
  const s1 = await snapshot(log, 'inline');
  await log.appendBatch(history(300, 'b'));
  const s2 = await snapshot(log, 'inline', { excludeTables: SEED_EXCLUDED_TABLES });
  await log.appendBatch(history(200, 'c'));
  const s3 = await snapshot(log, 'inline', { excludeTables: [FILTERED_TABLE] });
  await log.appendBatch(history(100, 'd'));
  const priorChunks = s1.chunkCount + s2.chunkCount + s3.chunkCount;
  expect(s1.chunkCount).toBeGreaterThan(1);
  return { log, priorChunks };
}

/**
 * The producer logs (console.error) when it refuses a prior set and folds from 0. These
 * tests CAUSE that on purpose, so they assert the line instead of letting the
 * fail-on-console guard trip on it.
 */
function expectRefusal(): () => void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => {
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(lines.some((l) => l.includes(`excluded table '${FILTERED_TABLE}' which this fold keeps; folding from 0`))).toBe(true);
  };
}

/** A view of `log` whose block at `hole` reads as null on both the decoded and raw paths. */
function withHole(log: OwnLog, hole: number): OwnLog {
  return {
    append: (op) => log.append(op),
    appendBatch: (ops) => log.appendBatch(ops),
    get: (i) => (i === hole ? Promise.resolve(null) : log.get(i)),
    getRaw: (i) => (i === hole ? Promise.resolve(null) : log.getRaw!(i)),
    appendRawBatch: (blocks) => log.appendRawBatch!(blocks),
    get length() {
      return log.length;
    },
    get keyHex() {
      return log.keyHex;
    },
  };
}

describe('(c) a contiguous fold passes over prior snapshot sets instead of re-expanding them', () => {
  for (const path of PATHS) {
    it(`[${path}] folds from 0 through three prior sets, skips every chunk, and yields exactly the expanding fold's rows`, async () => {
      const { log, priorChunks } = await logWithPriorSets();
      const before = await allOps(log);
      const progress: SnapshotFoldProgress[] = [];
      const refused = expectRefusal();
      const res = await snapshot(log, path, { onProgress: (p) => progress.push(p) });
      refused();

      // The reference EXPANDS every snapshot op it meets — the pre-fix semantics.
      expect(await setRows(log, res)).toEqual(buildSnapshotRows(before, { now: NOW }));
      expect(progress[0]!.sourceStart).toBe(0); // the filtered newest set was refused: a fold from 0
      const last = progress[progress.length - 1]!;
      expect(last.skippedSnapshotOps).toBe(priorChunks);
      expect(last.decodedOps).toBe(before.length - priorChunks);
    });
  }

  it('the worker path appends byte-identical blocks to the inline path', async () => {
    const a = await logWithPriorSets();
    const b = await logWithPriorSets();
    expect(await rawRange(a.log, 0, a.log.length)).toEqual(await rawRange(b.log, 0, b.log.length));
    const refused = expectRefusal();
    const ra = await snapshot(a.log, 'inline');
    const rb = await snapshot(b.log, 'worker');
    refused();
    // The hold duration measures two separate executions; byte and row results
    // must agree, but elapsed milliseconds need not.
    const { appendsHeldMs: inlineHoldMs, ...inlineResult } = ra;
    const { appendsHeldMs: workerHoldMs, ...workerResult } = rb;
    expect(workerResult).toEqual(inlineResult);
    expect(inlineHoldMs).toBeGreaterThanOrEqual(0);
    expect(workerHoldMs).toBeGreaterThanOrEqual(0);
    expect(await rawRange(b.log, rb.coversUpTo, rb.coversUpTo + rb.chunkCount)).toEqual(
      await rawRange(a.log, ra.coversUpTo, ra.coversUpTo + ra.chunkCount),
    );
  });

  for (const path of PATHS) {
    it(`[${path}] after a HOLE the next sets are expanded again, so a row only a set can re-deliver survives`, async () => {
      const { log } = await logWithPriorSets(350);
      const before = await allOps(log);
      const progress: SnapshotFoldProgress[] = [];
      const refused = expectRefusal();
      const res = await snapshot(withHole(log, 350), path, { onProgress: (p) => progress.push(p) });
      refused();

      const rows = await setRows(log, res);
      // Skipping the first set here would lose HOLE_KEY: its only op sits in the hole.
      expect(rows.some((r) => r.hbKey === HOLE_KEY)).toBe(true);
      expect(rows).toEqual(buildSnapshotRows(before, { now: NOW }));
      expect(progress[progress.length - 1]!.skippedSnapshotOps).toBe(0);
    });
  }
});

describe('(b) a set that excluded only self-regenerating tables seeds the unfiltered compaction', () => {
  for (const path of PATHS) {
    it(`[${path}] seeds from the presence-filtered head snapshot instead of folding from 0`, async () => {
      const log = await freshLog();
      await log.appendBatch(history(600, 'a', { presence: true }));
      const head = await snapshot(log, 'inline', { excludeTables: SEED_EXCLUDED_TABLES });
      await log.appendBatch(history(120, 'b', { presence: true })); // the keep-alive re-announces presence
      const tailStart = head.coversUpTo + head.chunkCount;

      const progress: SnapshotFoldProgress[] = [];
      const res = await snapshot(log, path, {
        priorSnapshotHint: { coversUpTo: head.coversUpTo, chunkCount: head.chunkCount },
        onProgress: (p) => progress.push(p),
      });

      expect(progress.some((p) => p.sourceStart === 0)).toBe(false);
      expect(progress.some((p) => p.sourceStart === tailStart)).toBe(true);
      const rows = await setRows(log, res);
      // Every non-presence row is exactly what a full fold gives; presence came back from the tail.
      const full = buildSnapshotRows(await allOps(log, res.coversUpTo), { now: NOW });
      expect(rows.filter((r) => r.table !== 'presence')).toEqual(full.filter((r) => r.table !== 'presence'));
      expect(rows.find((r) => r.table === 'presence')?.value).toMatchObject({ salt: 'b' });
    });
  }

  it('a set that excluded a table with real history is still refused (fold from 0)', async () => {
    const log = await freshLog();
    await log.appendBatch(history(300, 'a'));
    const filtered = await snapshot(log, 'inline', { excludeTables: [FILTERED_TABLE] });
    await log.appendBatch(history(50, 'b'));
    const progress: SnapshotFoldProgress[] = [];
    const refused = expectRefusal();
    await snapshot(log, 'inline', {
      priorSnapshotHint: { coversUpTo: filtered.coversUpTo, chunkCount: filtered.chunkCount },
      onProgress: (p) => progress.push(p),
    });
    refused();
    expect(progress[0]!.sourceStart).toBe(0);
  });

  it('every table the seed cut drops from the live log regenerates on its own', () => {
    for (const t of SEED_EXCLUDED_TABLES) expect(SELF_REGENERATING_TABLES.has(t)).toBe(true);
    expect(isSeedableForUnfilteredFold(SEED_EXCLUDED_TABLES)).toBe(true);
    expect(isSeedableForUnfilteredFold([])).toBe(true);
    expect(isSeedableForUnfilteredFold(['presence', 'usage'])).toBe(false);
  });
});

describe('(a) the cadence anchor never reads "unreadable" as "never snapshotted"', () => {
  it('an unreadable tail is known:false, not an anchor at 0', async () => {
    const broken: AdmittedLog = {
      keyHex: 'k',
      length: 5,
      get: () => Promise.reject(new Error('read timed out under load')),
    };
    const anchor = await discoverOwnCompactionAnchor(broken, { getTimeoutMs: 50 });
    expect(anchor.known).toBe(false);
    expect(anchor.outcome).toMatch(/^unreadable\(/);
  });

  it('an empty log is known, with no set', async () => {
    const anchor = await discoverOwnCompactionAnchor(await freshLog());
    expect(anchor).toEqual({ known: true, outcome: 'none', lastCoversUpTo: 0, lastRows: 0, seedSet: null });
  });

  it('a presence-filtered set is found AND offered as the unfiltered seed; a set with real exclusions is not', async () => {
    const log = await freshLog();
    await log.appendBatch(history(300, 'a', { presence: true }));
    const head = await snapshot(log, 'inline', { excludeTables: SEED_EXCLUDED_TABLES });
    const a = await discoverOwnCompactionAnchor(log);
    expect(a).toMatchObject({
      known: true,
      outcome: 'found(excludes=presence)',
      lastCoversUpTo: head.coversUpTo,
      seedSet: { coversUpTo: head.coversUpTo, chunkCount: head.chunkCount },
    });
    if (!a.known) throw new Error('unreachable');
    expect(a.lastRows).toBeGreaterThan(0);

    await log.appendBatch(history(20, 'b'));
    const filtered = await snapshot(log, 'inline', { excludeTables: [FILTERED_TABLE] });
    const b = await discoverOwnCompactionAnchor(log);
    expect(b).toMatchObject({ known: true, lastCoversUpTo: filtered.coversUpTo, seedSet: null });
  });
});

describe('(d) the fold worker is capped below the host and reports its own heap', () => {
  it('derives the cap from the host recycle limit, with a floor', () => {
    expect(snapshotFoldWorkerHeapMb(24_576)).toBe(11_059); // bg-host on the tower
    expect(snapshotFoldWorkerHeapMb(1_000)).toBe(SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB);
  });

  it('reports the worker heap and live keys on every fold', async () => {
    const worker = await SnapshotFoldWorker.open({ excludeTables: [] });
    cleanups.push(() => worker.close());
    const r = await worker.fold(history(40, 'x').map(encodeStoredBlock));
    expect(r.decodedOps).toBe(40);
    expect(r.keyCount).toBeGreaterThan(0);
    expect(r.heapUsedBytes).toBeGreaterThan(0);
  });

  it('a fold whose live set outgrows the cap FAILS as a worker error; the host keeps running', async () => {
    const worker = await SnapshotFoldWorker.open({ excludeTables: [] }, { maxOldGenerationSizeMb: 96 });
    cleanups.push(() => worker.close());
    const big = 'x'.repeat(16 * 1024);
    const WINDOWS = 200;
    const windowAt = (w: number) =>
      Array.from({ length: 256 }, (_, k) =>
        encodeStoredBlock({
          type: 'put',
          table: 'oom_t',
          hbKey: `w${w}-${k}`,
          value: { big: big + w + k },
          ts: w,
          schema_version: CURRENT_SCHEMA_VERSION,
          author_pubkey: '',
        }),
      );
    let failure: unknown = null;
    // P-006 scans retain winning positions rather than values. Those positions and
    // the worker's other live objects still count against the heap cap, so a valid
    // soft-cap refusal can occur during either scan or materialization.
    for (let w = 0; w < WINDOWS && failure === null; w++) {
      await worker.fold(windowAt(w), { sourceStart: w * 256 }).catch((e: unknown) => {
        failure = e;
      });
    }
    if (failure === null) {
      const indexes = await worker.pendingIndexes();
      expect(indexes).toHaveLength(WINDOWS * 256);
      for (let w = 0; w < WINDOWS && failure === null; w++) {
        await worker.materialize(windowAt(w), indexes.slice(w * 256, (w + 1) * 256), 0).catch((e: unknown) => {
          failure = e;
        });
      }
    }
    // The SOFT cap, not a V8 abort: this must hold whether or not the test process carries a
    // global --max-old-space-size (the batch router's NODE_OPTIONS does; bg-host's does). The
    // first version asserted any Error and went red exactly when the flag was present, because
    // `resourceLimits` was then silently ignored and nothing ever failed.
    expect(failure).toBeInstanceOf(SnapshotFoldHeapCapError);
    expect(String((failure as Error).message)).toMatch(/snapshot fold worker exceeded its heap cap/);
    const capErr = failure as unknown as SnapshotFoldHeapCapError;
    expect(capErr.capBytes).toBe(96 * 1024 * 1024);
    expect(capErr.usedBytes).toBeGreaterThan(capErr.capBytes);
    await expect(worker.fold([]), 'a capped worker refuses further folds').rejects.toBe(failure);
  }, 60_000);

  it('PREMISE: a global --max-old-space-size overrides a Worker resourceLimits cap (why the soft cap exists)', () => {
    const probe =
      "const { Worker } = require('node:worker_threads');" +
      "const w = new Worker(\"const v8=require('node:v8');require('node:worker_threads').parentPort.postMessage(" +
      "v8.getHeapStatistics().heap_size_limit)\", { eval: true, resourceLimits: { maxOldGenerationSizeMb: 96 } });" +
      "w.on('message', (m) => { process.stdout.write(String(Math.round(m / 1048576))); w.terminate(); });";
    const limitMb = (flags: string[]) =>
      Number(
        execFileSync(process.execPath, [...flags, '-e', probe], {
          env: { ...process.env, NODE_OPTIONS: '' },
          encoding: 'utf8',
        }),
      );
    expect(limitMb([]), 'no global flag: the Worker cap is honoured').toBeLessThan(512);
    // If this ever starts honouring the Worker cap, the soft cap can be retired in favour of
    // resourceLimits alone — update snapshotFoldWorkerHeapMb's doc and this test together.
    expect(limitMb(['--max-old-space-size=3072']), 'global flag: the Worker cap is IGNORED').toBeGreaterThan(3000);
  }, 20_000);

  it('the hard resourceLimits backstop sits above the soft cap', () => {
    expect(SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR).toBeGreaterThan(1);
  });
});

describe('snapshot block recognition and the worker-side skip', () => {
  const chunk = buildSnapshotOpsFromRows({
    rows: [{ table: 'oom_t', hbKey: 'k', value: { v: 1 }, ts: 1, schema_version: CURRENT_SCHEMA_VERSION }],
    coversUpTo: 3,
    author_pubkey: '',
    ts: NOW,
    schema_version: CURRENT_SCHEMA_VERSION,
  })[0]!;
  const plain: PeerLogOp = {
    type: 'put',
    table: 'oom_t',
    hbKey: 'k',
    value: 1,
    ts: 1,
    schema_version: CURRENT_SCHEMA_VERSION,
    author_pubkey: '',
  };

  it('recognizes what both producers store, and nothing else', async () => {
    expect(isSnapshotBlock(encodeStoredBlock(chunk))).toBe(true);
    const log = await freshLog();
    await log.appendBatch(history(30, 'a'));
    const res = await snapshot(log, 'inline'); // hypercore's own json encoding, not ours
    expect(isSnapshotBlock((await log.getRaw!(res.coversUpTo))!)).toBe(true);
    expect(isSnapshotBlock((await log.getRaw!(0))!)).toBe(false);
    expect(isSnapshotBlock(encodeStoredBlock(plain))).toBe(false);
    expect(isSnapshotBlock(new Uint8Array(0))).toBe(false);
  });

  it('the worker skips a snapshot op in another key order after decoding it, and counts it', () => {
    const handle = createSnapshotFoldHandler({ heapUsedBytes: () => 123 });
    handle({ kind: 'init', id: 1, excludeTables: [] });
    const reordered = new TextEncoder().encode(JSON.stringify({ table: SNAPSHOT_TABLE_TAG, type: 'put', hbKey: '', value: chunk.value, ts: 1, schema_version: 1 }));
    expect(isSnapshotBlock(reordered)).toBe(false);
    const blocks = [encodeStoredBlock(chunk), reordered, encodeStoredBlock(plain)];
    const { buf, lengths } = packBlocks(blocks);
    const { res } = handle({ kind: 'fold', id: 2, buf, lengths, skipSnapshotOps: true });
    expect(res).toMatchObject({ kind: 'folded', decodedOps: 1, skippedSnapshotOps: 2, keyCount: 1, heapUsedBytes: 123 });

    // Without the flag the same blocks EXPAND, exactly as before.
    const expanding = createSnapshotFoldHandler();
    expanding({ kind: 'init', id: 1, excludeTables: [] });
    const again = packBlocks(blocks);
    expect(expanding({ kind: 'fold', id: 2, ...again }).res).toMatchObject({ decodedOps: 3, skippedSnapshotOps: 0 });
  });
});

describe('failure backoff', () => {
  it('doubles from the base and is capped', () => {
    expect(ownCompactionBackoffMs(0, 60_000)).toBe(0);
    expect(ownCompactionBackoffMs(1, 60_000)).toBe(60_000);
    expect(ownCompactionBackoffMs(3, 60_000)).toBe(240_000);
    expect(ownCompactionBackoffMs(99, 60_000)).toBe(OWN_COMPACTION_BACKOFF_MAX_MS);
  });
});
