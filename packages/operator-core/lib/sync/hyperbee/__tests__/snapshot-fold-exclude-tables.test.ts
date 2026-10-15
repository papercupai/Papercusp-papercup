import { describe, it, expect, vi } from 'vitest';
import {
  produceLogSnapshot,
  produceFilteredSnapshotIntoLog,
  formatSnapshotFoldStall,
  SnapshotRowFolder,
  isSnapshotOp,
  SNAPSHOT_READ_CONCURRENCY,
  FILTERED_SNAPSHOT_SCAN_STALL_MS,
  type SnapshotPayload,
  type SnapshotFoldProgress,
} from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

const NEVER_EMIT_MARKER = 'never-emit-me';

describe('bounded snapshot fold stall formatting', () => {
  it('bounds and sanitizes attribution labels without serializing extra data', () => {
    const diagnostic = {
      phase: `fold\n\u001b${'x'.repeat(10_000)}`,
      coreKey: `core\r\n${'a'.repeat(10_000)}`,
      sourceStart: 12,
      sourceEnd: 32,
      processed: 24,
      total: 32,
      decodedOps: 12,
      decodedBytes: 1024,
      stalledForMs: 30_000,
      rawValue: { secret: NEVER_EMIT_MARKER },
    };
    const message = formatSnapshotFoldStall(diagnostic);
    expect(message).toContain(`phase=fold__${'x'.repeat(58)}`);
    expect(message).toContain(`core=core__${'a'.repeat(58)}`);
    expect(message).toContain('sourceStart=12 sourceEnd=32 cursor=24/32 decodedOps=12 decodedBytes=1024 stalledForMs=30000');
    expect(message).not.toMatch(/[\r\n\u001b]|rawValue/);
    expect(message).not.toContain(NEVER_EMIT_MARKER);
    expect(message.length).toBeLessThan(300);
  });

  it('reports unknown rather than inventing an absent core identity', () => {
    expect(formatSnapshotFoldStall({
      phase: 'source-scan',
      sourceStart: 0,
      sourceEnd: 1,
      processed: 0,
      total: 1,
      decodedOps: 0,
      decodedBytes: 0,
      stalledForMs: 30_000,
    })).toBe('phase=source-scan core=unknown sourceStart=0 sourceEnd=1 cursor=0/1 decodedOps=0 decodedBytes=0 stalledForMs=30000');
  });
});

/**
 * EI-20108164746219771 — the SERVER installer ships the build box owner's identity.
 *
 * The seed corestore bundled by `tauri.server.conf.json` carried live `presence`
 * rows keyed by `<github_user_id>/<machine_label>`, so every published SERVER
 * artifact on every platform disclosed the owner's hostname, OS username and
 * GitHub ids to whoever downloaded it.
 *
 * These tests pin the fold-time exclusion that removes them at the source.
 *
 * ── WHY THE SNAPSHOT-EXPANSION CASE IS THE ONE THAT MATTERS ──────────────────
 * The obvious test — "a raw `put` to an excluded table is dropped" — would pass
 * against a filter that is USELESS in production. Measured 2026-08-11 against the
 * committed seed: its 45 shipped blocks are ENTIRELY a 45-chunk snapshot set
 * (snapshotChunks=45, rawOps=0). So in the real artifact the leaking rows never
 * arrive as raw ops at all; they arrive as rows expanded out of a PRIOR snapshot.
 * A filter applied only to the put/del branch would therefore be green on the
 * obvious test and still ship every identity row. `should drop excluded tables
 * when the source log is ITSELF a snapshot` is the test that can actually fail.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}
function del(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table, hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string, opts: { readDelayMs?: number; neverAt?: number } = {}): OwnLog {
  const ops: PeerLogOp[] = [];
  return {
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
      if (opts.neverAt === i) return new Promise<null>(() => {});
      if (opts.readDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.readDelayMs));
      }
      return ops[i] ?? null;
    },
  } as unknown as OwnLog;
}

/** Collect every row carried by the snapshot set anchored at `coversUpTo`. */
async function rowsOfSetAt(log: OwnLog, coversUpTo: number, chunkCount: number) {
  const rows: { table: string; hbKey: string }[] = [];
  for (let j = 0; j < chunkCount; j++) {
    const op = await log.get(coversUpTo + j);
    if (!op || !isSnapshotOp(op)) throw new Error(`no snapshot chunk at ${coversUpTo + j}`);
    for (const r of (op.value as SnapshotPayload).rows) {
      rows.push({ table: r.table, hbKey: r.hbKey });
    }
  }
  return rows;
}

/**
 * A SYNTHETIC stand-in for the leaking row's shape — deliberately NOT the real
 * build box's github id or hostname.
 *
 * Pinning the actual literals here would have put the exact strings this fix
 * removes from the product back into shipped source, where `check-no-identity-
 * literals` reds the green-checkpoint gate and freezes `main` fleet-wide. (I wrote
 * them in on the first draft and the pre-write hook caught it — the same trap the
 * identity-gate test avoided by DERIVING its sentinel rather than hardcoding one.)
 *
 * The shape is what matters to the fold: `presence` is keyed
 * `<github_user_id>/<machine_label>`, and the filter keys off `table`, never the
 * value — so a synthetic id exercises exactly the same path.
 */
const SYNTHETIC_GITHUB_ID = '4242424242';
const SYNTHETIC_MACHINE_LABEL = 'synthetic-test-host-not-a-real-machine';
const IDENTITY_ROW = {
  table: 'presence',
  hbKey: `${SYNTHETIC_GITHUB_ID}/${SYNTHETIC_MACHINE_LABEL}`,
};

describe('SnapshotRowFolder excludeTables (EI-20108164746219771)', () => {
  it('defaults to excluding NOTHING — the live path must be unchanged', () => {
    const folder = new SnapshotRowFolder();
    folder.add(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 1));
    folder.add(put('plans', 'p1', { title: 'x' }, 2));
    const tables = folder.finish({ now: 10 }).map((r) => r.table).sort();
    expect(tables).toEqual(['plans', 'presence']);
  });

  it('drops excluded tables arriving as raw put/del ops', () => {
    const folder = new SnapshotRowFolder({ excludeTables: ['presence', 'usage'] });
    folder.add(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 1));
    folder.add(put('usage', 'u1', { tokens: 5 }, 2));
    folder.add(del('presence', 'other/host', 3));
    folder.add(put('plans', 'p1', { title: 'x' }, 4));
    folder.add(del('plans', 'p2', 5));

    const rows = folder.finish({ now: 10 });
    expect(rows.map((r) => r.table)).toEqual(['plans', 'plans']);
    // The surviving tombstone still reads as a delete — exclusion must not disturb
    // the tombstone semantics EI-1688 depends on.
    expect(rows.find((r) => r.hbKey === 'p2')?.deleted).toBe(true);
  });

  it('keeps hive-members, which the seed REQUIRES and the owner authorised', () => {
    // Guards against over-filtering: the membership roster is identity-bearing but
    // is intended content, unlike presence/usage. Widening the exclusion set to
    // "anything with an id in it" would break seeding.
    const folder = new SnapshotRowFolder({ excludeTables: ['presence', 'usage'] });
    folder.add(put('hive-members', 'm1', { github_user_id: 1567022 }, 1));
    expect(folder.finish({ now: 10 }).map((r) => r.table)).toEqual(['hive-members']);
  });

  it('drops excluded tables when the source log is ITSELF a snapshot (the shipped-seed shape)', async () => {
    const log = memLog('src');
    await log.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await log.append(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 2));
    await log.append(put('usage', 'u1', { tokens: 5 }, 3));

    // Snapshot with NO filter: this is what the committed seed corestore contains.
    const first = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1 });
    expect(first.appended).toBe(true);
    const firstRows = await rowsOfSetAt(log, first.coversUpTo, first.chunkCount);
    expect(firstRows.some((r) => r.table === 'presence')).toBe(true);

    // Re-snapshot WITH the filter. Every row now reaches the folder ONLY via
    // snapshot expansion — the branch the real artifact exercises.
    const second = await produceLogSnapshot(log, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });
    expect(second.appended).toBe(true);

    const secondRows = await rowsOfSetAt(log, second.coversUpTo, second.chunkCount);
    expect(secondRows.some((r) => r.table === 'presence')).toBe(false);
    expect(secondRows.some((r) => r.table === 'usage')).toBe(false);
    expect(secondRows.some((r) => r.table === 'plans')).toBe(true);
  });

  it('leaves no trace of the excluded identity string anywhere in the emitted bytes', async () => {
    // The end-to-end property the release identity gate scans for. Asserting on the
    // serialized set (not the row list) is deliberate: a row could be dropped from
    // `rows` while the identity survived in some other field of the payload.
    const log = memLog('src');
    await log.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await log.append(
      put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 2),
    );
    const unfiltered = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1 });

    const serializeSet = async (r: { coversUpTo: number; chunkCount: number }) =>
      JSON.stringify(
        await Promise.all(
          Array.from({ length: r.chunkCount }, (_, j) => log.get(r.coversUpTo + j)),
        ),
      );

    // CONTROL FIRST — the unfiltered set MUST carry the identity. Without this the
    // assertions below would pass against a filter that does nothing at all (and
    // against a typo'd table name, which is the likelier real-world mistake).
    const unfilteredBytes = await serializeSet(unfiltered);
    expect(unfilteredBytes).toContain(SYNTHETIC_MACHINE_LABEL);
    expect(unfilteredBytes).toContain(SYNTHETIC_GITHUB_ID);

    const filtered = await produceLogSnapshot(log, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });
    const bytes = await serializeSet(filtered);
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
    expect(bytes).not.toContain(SYNTHETIC_GITHUB_ID);
  });
});

describe('produceFilteredSnapshotIntoLog — the synthetic seed core (EI-20108164746219771)', () => {
  /** A source log in the shape the real seed has: content already folded into a snapshot. */
  async function sourceInShippedSeedShape() {
    const src = memLog('source-own-log');
    await src.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await src.append(put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 2));
    await src.append(put('usage', 'u1', { tokens: 5 }, 3));
    await produceLogSnapshot(src, { now: 1000, schemaVersion: 1 });
    return src;
  }

  it('NEVER writes the source log — the whole reason this function exists', async () => {
    const src = await sourceInShippedSeedShape();
    const lengthBefore = src.length;
    const target = memLog('synthetic-seed-core');

    await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    // Filtering in place would make historical `usage` unreachable for every live
    // reader folding forward from the newest snapshot. The source must be untouched.
    expect(src.length).toBe(lengthBefore);
    expect(target.length).toBeGreaterThan(0);
  });

  it('anchors coversUpTo to the TARGET position, so the set is findable where the reader looks', async () => {
    const src = await sourceInShippedSeedShape();
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    // A fresh core ⇒ the set begins at 0, NOT at the source's length. Anchoring to
    // the source would be readable but unfindable (WI-37526).
    expect(res.coversUpTo).toBe(0);
    expect(res.coversUpTo).not.toBe(src.length);

    // Every chunk present at [coversUpTo, coversUpTo + chunkCount), which is the span
    // verifySnapshotSet scans.
    for (let j = 0; j < res.chunkCount; j++) {
      const op = await target.get(res.coversUpTo + j);
      expect(op && isSnapshotOp(op)).toBe(true);
      expect((op!.value as SnapshotPayload).coversUpTo).toBe(res.coversUpTo);
    }
  });

  it('carries the intended content and none of the identity', async () => {
    const src = await sourceInShippedSeedShape();
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    const rows = await rowsOfSetAt(target, res.coversUpTo, res.chunkCount);
    expect(rows.some((r) => r.table === 'plans')).toBe(true);
    expect(rows.some((r) => r.table === 'presence')).toBe(false);
    expect(rows.some((r) => r.table === 'usage')).toBe(false);

    const bytes = JSON.stringify(
      await Promise.all(
        Array.from({ length: res.chunkCount }, (_, j) => target.get(res.coversUpTo + j)),
      ),
    );
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
    expect(bytes).not.toContain(SYNTHETIC_GITHUB_ID);
  });

  it('re-authors only the ENVELOPE — rows keep their original author_pubkey', async () => {
    // Row-level author_pubkey is bound into the epoch-decrypt AAD, so rewriting it
    // would make encrypted content undecryptable for a seeded joiner (WI-808 / the
    // seed-57-drop sibling). Only the snapshot op itself is authored by the new core.
    const src = memLog('source-own-log');
    await src.append(put('plans', 'p1', { title: 'keep me' }, 1));
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });

    const chunk = await target.get(res.coversUpTo);
    expect(chunk!.author_pubkey).toBe('synthetic-seed-core');
    expect((chunk!.value as SnapshotPayload).rows[0]!.author_pubkey).toBe('me');
  });

  it('reports appended:false for an empty source rather than claiming a set it never wrote', async () => {
    const src = memLog('source-own-log');
    const target = memLog('synthetic-seed-core');
    const res = await produceFilteredSnapshotIntoLog(src, target, { now: 2000, schemaVersion: 1 });
    expect(res.appended).toBe(false);
    expect(res.chunkCount).toBe(0);
    expect(target.length).toBe(0);
  });

  it('DOES append an empty snapshot when a non-empty source folds to zero rows', async () => {
    // The deliberate other half of the rule above. "No source at all" and "a real hive
    // whose every row was excluded" are different facts and must seed differently:
    // the second is a legitimate empty-content seed, the first is nothing to seed from.
    // Pinned because `chunkSnapshotRows([])` returns one empty chunk, so the two cases
    // are trivially easy to collapse into whichever the implementation happens to do.
    const src = memLog('source-own-log');
    await src.append(put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 1));
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });

    expect(res.appended).toBe(true);
    expect(res.rowCount).toBe(0);
    expect(target.length).toBe(res.chunkCount);
    const bytes = JSON.stringify(await target.get(res.coversUpTo));
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
  });

  it('emits phase + source cursor progress once per completed read window', async () => {
    const src = memLog('source-own-log');
    for (let i = 0; i < SNAPSHOT_READ_CONCURRENCY + 1; i++) {
      await src.append(put('plans', `p-${i}`, { i }, i));
    }
    const target = memLog('synthetic-seed-core');
    const progress: SnapshotFoldProgress[] = [];

    await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      onProgress: (event) => progress.push(event),
    });

    expect(progress.map(({ phase, processed, total }) => ({ phase, processed, total }))).toEqual([
      { phase: 'filtered-source-scan', processed: SNAPSHOT_READ_CONCURRENCY, total: SNAPSHOT_READ_CONCURRENCY + 1 },
      { phase: 'filtered-source-scan', processed: SNAPSHOT_READ_CONCURRENCY + 1, total: SNAPSHOT_READ_CONCURRENCY + 1 },
    ]);
    expect(progress.map((event) => event.decodedOps)).toEqual([SNAPSHOT_READ_CONCURRENCY, SNAPSHOT_READ_CONCURRENCY + 1]);
    expect(progress.every((event) => event.coreKey === 'source-own-log')).toBe(true);
    expect(progress.every((event) => event.sourceStart === 0 && event.sourceEnd === SNAPSHOT_READ_CONCURRENCY + 1)).toBe(true);
    expect(progress.every((event) => event.decodedBytes > 0)).toBe(true);
  });

  it('does not call the stall sink for a slow scan whose source cursor keeps advancing', async () => {
    // Seven individually bounded windows take longer than the 150ms diagnostic
    // threshold in total. Only a cursor that stops advancing is a stall: a total
    // wall-clock timeout would falsely alarm this healthy scan.
    const src = memLog('source-own-log', { readDelayMs: 25 });
    const total = SNAPSHOT_READ_CONCURRENCY * 7 + 1;
    for (let i = 0; i < total; i++) await src.append(put('plans', `p-${i}`, { i }, i));
    const stalls: Array<{ processed: number; total: number }> = [];

    await produceFilteredSnapshotIntoLog(src, memLog('synthetic-seed-core'), {
      now: 2000,
      schemaVersion: 1,
      stallMs: 150,
      onStall: (event) => stalls.push({ processed: event.processed, total: event.total }),
    });

    expect(stalls).toEqual([]);
  });

  it('abandons a hung prior-snapshot seek, then reports one edge-triggered fold stall', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const src = memLog('source-own-log', { neverAt: 0 });
      await src.append(put('plans', 'p-0', { title: 'stuck' }, 1));
      const stalls: Array<{ phase: string; processed: number; total: number; stalledForMs: number }> = [];
      const pending = produceFilteredSnapshotIntoLog(src, memLog('synthetic-seed-core'), {
        now: 2000,
        schemaVersion: 1,
        stallMs: 25,
        seekReadBudgetMs: 5,
        onStall: (event) => stalls.push(event),
      });

      // THE SEEK RUNS FIRST AND MUST NOT SWALLOW THE HANG. `neverAt: 0` makes the read
      // HANG rather than throw, and the seek's `try/catch` cannot observe a hang — so
      // without its read budget the seek parks here forever and the fold below is never
      // entered: no progress line, no stall, no timeout. That is strictly worse than the
      // slow fold it replaces, and reads externally as a wedged release cut.
      await vi.advanceTimersByTimeAsync(5);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain('prior-snapshot seek abandoned');
      expect(stalls).toEqual([]);

      // Abandoning the seek must FALL BACK to the full fold (foldFrom stays 0), which is
      // the behavior that shipped before the seek existed — so the fold's own stall
      // diagnostic still arms on the very same hung block.
      await vi.advanceTimersByTimeAsync(25);
      expect(stalls).toHaveLength(1);
      expect(stalls[0]).toMatchObject({
        phase: 'filtered-source-scan',
        processed: 0,
        total: 1,
      });
      // A stuck cursor is edge-triggered, not a repeating timer storm. The abandoned
      // seek is likewise reported once, not re-reported as the fold keeps waiting.
      await vi.advanceTimersByTimeAsync(100);
      expect(stalls).toHaveLength(1);
      expect(errors).toHaveBeenCalledTimes(1);
      void pending;
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { mode: 'own', sink: 'default' },
    { mode: 'filtered', sink: 'default' },
    { mode: 'own', sink: 'custom' },
    { mode: 'filtered', sink: 'custom' },
  ])('delivers attributed $mode stalls through the $sink sink without aborting', async ({ mode, sink }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const customStall = vi.fn();
    const source = memLog('ab'.repeat(32));
    const total = SNAPSHOT_READ_CONCURRENCY + 1;
    let decodedBytes = 0;
    for (let index = 0; index < total; index++) {
      const operation = put('private-table', `private-row-${index}`, { secret: NEVER_EMIT_MARKER }, index);
      await source.append(operation);
      if (index < SNAPSHOT_READ_CONCURRENCY) decodedBytes += Buffer.byteLength(JSON.stringify(operation), 'utf8');
    }
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reportBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
    const originalGet = source.get.bind(source);
    let tailReads = 0;
    const reads = vi.spyOn(source, 'get').mockImplementation(async (index) => {
      // Block the FOLD's read of the tail, which is the SECOND one in both modes:
      // the prior-snapshot seek reads the tail block first, scanning backward for a
      // snapshot set before the fold starts. Blocking the first read would gate the
      // SEEK instead, which is bounded and falls back — so no fold stall would arm.
      if (index === SNAPSHOT_READ_CONCURRENCY && ++tailReads === 2) {
        reportBlocked();
        await readGate;
      }
      return originalGet(index);
    });
    const options = { now: 2000, schemaVersion: 1, ...(sink === 'custom' ? { onStall: customStall } : {}) };
    let settled = false;
    const pending = (mode === 'own'
      ? produceLogSnapshot(source, options)
      : produceFilteredSnapshotIntoLog(source, memLog('synthetic-seed-core'), options)
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await blocked;
      await vi.advanceTimersByTimeAsync(FILTERED_SNAPSHOT_SCAN_STALL_MS - 1);
      expect(errors).not.toHaveBeenCalled();
      expect(customStall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const phase = mode === 'own' ? 'own-compaction' : 'filtered-source-scan';
      if (sink === 'default') {
        expect(errors).toHaveBeenCalledTimes(1);
        const message = String(errors.mock.calls[0]![0]);
        for (const field of [
          `phase=${phase}`,
          `core=${source.keyHex}`,
          'sourceStart=0',
          `sourceEnd=${total}`,
          `cursor=${SNAPSHOT_READ_CONCURRENCY}/${total}`,
          `decodedOps=${SNAPSHOT_READ_CONCURRENCY}`,
          `decodedBytes=${decodedBytes}`,
          `stalledForMs=${FILTERED_SNAPSHOT_SCAN_STALL_MS}`,
        ]) expect(message).toContain(field);
        expect(message).not.toMatch(/private-table|private-row/);
        expect(message).not.toContain(NEVER_EMIT_MARKER);
        expect(message.length).toBeLessThan(600);
      } else {
        expect(errors).not.toHaveBeenCalled();
        expect(customStall).toHaveBeenCalledExactlyOnceWith({
          phase,
          coreKey: source.keyHex,
          sourceStart: 0,
          sourceEnd: total,
          processed: SNAPSHOT_READ_CONCURRENCY,
          total,
          decodedOps: SNAPSHOT_READ_CONCURRENCY,
          decodedBytes,
          stalledForMs: FILTERED_SNAPSHOT_SCAN_STALL_MS,
        });
      }
      await vi.advanceTimersByTimeAsync(FILTERED_SNAPSHOT_SCAN_STALL_MS * 2);
      expect(errors).toHaveBeenCalledTimes(sink === 'default' ? 1 : 0);
      expect(customStall).toHaveBeenCalledTimes(sink === 'custom' ? 1 : 0);
      expect(settled).toBe(false);
      releaseRead();
      expect((await pending).appended).toBe(true);
      await vi.advanceTimersByTimeAsync(FILTERED_SNAPSHOT_SCAN_STALL_MS * 2);
      expect(errors).toHaveBeenCalledTimes(sink === 'default' ? 1 : 0);
      expect(customStall).toHaveBeenCalledTimes(sink === 'custom' ? 1 : 0);
    } finally {
      releaseRead();
      await pending;
      reads.mockRestore();
      errors.mockRestore();
      vi.useRealTimers();
    }
  });
});

/**
 * WI-10001822 — the seed fold used to start at a HARDCODED 0, re-expanding every
 * superseded snapshot generation in the source log's tail. Measured on the failed
 * 0.0.21 cut: 39,340,332 row-projections to yield 1,415,542 rows (27.7x), ~half the
 * ~7h wall clock spent on 1.1% of the blocks. Its sibling `produceLogSnapshot`
 * already seeks the latest snapshot and folds only the new tail.
 *
 * ── WHAT MAKES THESE TESTS ABLE TO FAIL ──────────────────────────────────────────
 * The cheap version of this test asserts the RESULT is unchanged — and it passes
 * whether or not the seek happens, because a full fold and a seeded fold produce the
 * same rows BY DESIGN. That is the whole point of the optimization, so a row
 * assertion cannot detect it. These tests instead assert on WHICH INDICES WERE READ,
 * which is the only observable that distinguishes O(new tail) from O(history).
 */
describe('produceFilteredSnapshotIntoLog — prior-snapshot seek (WI-10001822)', () => {
  /** Wrap a log, recording every index handed to `get`. */
  function readRecording(inner: OwnLog): { log: OwnLog; reads: number[] } {
    const reads: number[] = [];
    const log = {
      get keyHex() {
        return inner.keyHex;
      },
      get length() {
        return inner.length;
      },
      append: (op: PeerLogOp) => inner.append(op),
      appendBatch: (batch: PeerLogOp[]) => inner.appendBatch(batch),
      async get(i: number) {
        reads.push(i);
        return inner.get(i);
      },
    } as unknown as OwnLog;
    return { log, reads };
  }

  /**
   * A source in the real seed's shape: `historyOps` raw ops already folded into a
   * snapshot set, then a short tail of newer raw ops. Returns the boundary index
   * below which nothing should be read once the seek works.
   */
  async function sourceWithSnapshotThenTail(opts: { producerExcludes?: string[] } = {}) {
    const src = memLog('source-own-log');
    await src.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await src.append(put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 2));
    await src.append(put('usage', 'u1', { tokens: 5 }, 3));
    const historyOps = src.length;
    await produceLogSnapshot(src, {
      now: 1000,
      schemaVersion: 1,
      ...(opts.producerExcludes ? { excludeTables: opts.producerExcludes } : {}),
    });
    // The newer tail the seed must still fold.
    await src.append(put('plans', 'p2', { title: 'newer' }, 4));
    return { src, historyOps };
  }

  it('folds only the new tail — the summarized history is never re-read', async () => {
    const { src, historyOps } = await sourceWithSnapshotThenTail();
    const { log, reads } = readRecording(src);
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(log, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });

    // THE ASSERTION THAT FAILS AGAINST THE HARDCODED 0: every op below the snapshot
    // anchor is summarized by the set we seeded from, so reading any of them is the
    // redundant work this fix removes.
    expect(reads.filter((i) => i < historyOps)).toEqual([]);

    // ...and the output is still complete: the seeded rows AND the newer tail.
    const rows = await rowsOfSetAt(target, res.coversUpTo, res.chunkCount);
    expect(rows.filter((r) => r.table === 'plans').map((r) => r.hbKey).sort()).toEqual(['p1', 'p2']);
    expect(rows.some((r) => r.table === 'presence')).toBe(false);
    expect(rows.some((r) => r.table === 'usage')).toBe(true);
  });

  it('refuses the seek when the prior snapshot dropped a table this seed KEEPS', async () => {
    // The producer excluded `usage`; this seed keeps it. Seeding would ship a seed
    // with no `usage` rows at all — silently thinner than the source, which is worse
    // than being slow.
    const { src, historyOps } = await sourceWithSnapshotThenTail({ producerExcludes: ['usage'] });
    const { log, reads } = readRecording(src);
    const target = memLog('synthetic-seed-core');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await produceFilteredSnapshotIntoLog(log, target, {
        now: 2000,
        schemaVersion: 1,
        excludeTables: ['presence'],
      });

      // Fell back to the full fold: history WAS re-read, deliberately.
      expect(reads.filter((i) => i < historyOps).length).toBeGreaterThan(0);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("'usage'");

      // The point of the refusal: `usage` survives because the full fold read the
      // original raw op instead of a snapshot that had already dropped it.
      const rows = await rowsOfSetAt(target, res.coversUpTo, res.chunkCount);
      expect(rows.some((r) => r.table === 'usage')).toBe(true);
      expect(rows.some((r) => r.table === 'presence')).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('takes the seek when the prior snapshot dropped only tables this seed also drops', async () => {
    // Producer dropped `presence`; this seed drops `presence` too ⇒ nothing the seed
    // wants is missing from the snapshot, so the seek is safe. This is the real
    // release-cut pairing (both sides use SEED_EXCLUDED_TABLES).
    const { src, historyOps } = await sourceWithSnapshotThenTail({ producerExcludes: ['presence'] });
    const { log, reads } = readRecording(src);
    const target = memLog('synthetic-seed-core');

    await produceFilteredSnapshotIntoLog(log, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    expect(reads.filter((i) => i < historyOps)).toEqual([]);
  });

  it('records the excluded set on every chunk, and omits it when nothing was excluded', async () => {
    const { src } = await sourceWithSnapshotThenTail();
    const filtered = memLog('filtered-seed-core');
    const res = await produceFilteredSnapshotIntoLog(src, filtered, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['usage', 'presence'],
    });

    for (let j = 0; j < res.chunkCount; j++) {
      const op = await filtered.get(res.coversUpTo + j);
      // Sorted, so the serialization is stable rather than caller-order dependent.
      expect((op!.value as SnapshotPayload).excludeTables).toEqual(['presence', 'usage']);
    }

    // An unfiltered snapshot stays byte-for-byte what it was before this field existed.
    const plain = memLog('plain-source');
    await plain.append(put('plans', 'p1', { title: 'x' }, 1));
    const plainRes = await produceLogSnapshot(plain, { now: 1000, schemaVersion: 1 });
    const plainOp = await plain.get(plainRes.coversUpTo);
    expect((plainOp!.value as SnapshotPayload).excludeTables).toBeUndefined();
  });

  /**
   * WI-10005425 — `ownPrefix` is what lets read-merge skip a filtered set a reader
   * already folded. It must appear on EVERY chunk of the own-log producer's filtered
   * set (the release-cut head snapshot), and NEVER on the seed core, which summarizes
   * another log. An unfiltered set stays unmarked (it is already skip-eligible).
   */
  it('marks an own-log filtered set ownPrefix on every chunk, and never the seed core or an unfiltered set', async () => {
    const own = memLog('own-log');
    for (let i = 0; i < 30; i++) await own.append(put('plans', `p${i}`, { title: `t${i}` }, 1 + i));
    await own.append(put('presence', 'me', { at: 1 }, 50));
    const ownRes = await produceLogSnapshot(own, {
      now: 1000,
      schemaVersion: 1,
      excludeTables: ['presence'],
      maxChunkBytes: 200,
    });
    expect(ownRes.chunkCount).toBeGreaterThan(1);
    for (let j = 0; j < ownRes.chunkCount; j++) {
      const v = (await own.get(ownRes.coversUpTo + j))!.value as SnapshotPayload;
      expect(v.excludeTables).toEqual(['presence']);
      expect(v.ownPrefix).toBe(true);
    }

    const { src } = await sourceWithSnapshotThenTail();
    const seedCore = memLog('seed-core');
    const seedRes = await produceFilteredSnapshotIntoLog(src, seedCore, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });
    for (let j = 0; j < seedRes.chunkCount; j++) {
      const v = (await seedCore.get(seedRes.coversUpTo + j))!.value as SnapshotPayload;
      expect(v.excludeTables).toEqual(['presence']);
      expect(v).not.toHaveProperty('ownPrefix');
    }

    const plain = memLog('plain-own-log');
    await plain.append(put('plans', 'p1', { title: 'x' }, 1));
    const plainRes = await produceLogSnapshot(plain, { now: 1000, schemaVersion: 1 });
    expect((await plain.get(plainRes.coversUpTo))!.value).not.toHaveProperty('ownPrefix');
  });
});
