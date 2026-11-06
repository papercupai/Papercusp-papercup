/**
 * P-019 (plan memory-corpus-hygiene-and-release-distribution-2026-08-03, D-012) —
 * `handle.produceHeadSnapshotNow()`: the ON-DEMAND head snapshot that restores the
 * NO-OUTAGE sparse release cut.
 *
 * Boots a REAL substrate over a tmp Corestore with the merge poll timer DISABLED
 * (mirrors boot.test.ts's single-peer setup), because the whole point of the
 * mechanism is that the request is serviced INSIDE the serialized merge pass — a
 * fake handle could not distinguish that from an append done anywhere else.
 *
 * The load-bearing claims, each with its own case below:
 *  1. it actually appends a snapshot AT THE TAIL (that is the precondition
 *     `computeSparseFrom` scans for; without it a "sparse" cut ships the FULL core);
 *  2. it is NOT gated by the `SUBSTRATE_LOG_SNAPSHOT` producer flag — forced OFF in
 *     that case (the flag defaults ON since p2p-join-catchup-speed P-005);
 *  3. concurrent callers COALESCE onto one snapshot (a naive flag would orphan the
 *     first waiter and hang it forever);
 *  4. a stopped engine REJECTS rather than hanging (mergeNow short-circuits when
 *     stopped, so an armed request would never be serviced);
 *  5. the published seed drops dead governor receipts like the own compaction does,
 *     and a failed census degrades to an unfiltered cut (WI-10003060).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate, type BootHarnessOpts } from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { findLatestSnapshotIndex } from '../read-merge';
import { isSnapshotOp, SNAPSHOT_READ_CONCURRENCY, type SnapshotPayload } from '../log-snapshot';
import { _resetBootHistoryForTests, _setPgWriteForTests, listBootHistory } from '../boot-history';
import * as ownCompactionAnchor from '../own-compaction-anchor';
import type { PeerLogOp } from '../peer-log';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p019-head-snap-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return dir;
}

async function bootWithOps(
  slug: string,
  opCount: number,
  extra: Pick<BootHarnessOpts, 'loadOwnCompactionGovernorReceiptKeys' | 'ownCompactionProgressIntervalMs'> = {},
) {
  const handle = await bootHarnessSubstrate({
    workspaceRoot: tmpWorkspaceRoot(),
    workspaceId: 'ws-p019',
    harnessSlug: slug,
    mergePollMs: 0, // drive mergeNow by hand
    loadRevokedOverride: async () => new Set(), // avoid real PG
    applyOverride: async () => true,
    rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
    loadOwnCompactionGovernorReceiptKeys: async () => [], // the head census, without real PG
    ...extra,
  });
  expect(
    listBootHistory({
      workspaceId: 'ws-p019',
      harnessSlug: slug,
      kinds: ['epoch_gate_skipped'],
    }),
  ).toHaveLength(0);
  cleanups.push(() => handle.close());
  for (let i = 0; i < opCount; i++) {
    await handle.append({
      type: 'put',
      table: 'p019_test_table',
      hbKey: `K-${i}`,
      value: { id: `K-${i}` },
      ts: 1000 + i,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  }
  return handle;
}

describe('produceHeadSnapshotNow (P-019 / D-012)', () => {
  it('appends a head snapshot AT THE TAIL, covering every op written so far', async () => {
    const handle = await bootWithOps('p019-a', 3);
    const lengthBefore = handle.ownLog.length;
    expect(lengthBefore).toBe(3);

    const snap = await handle.produceHeadSnapshotNow();

    expect(snap.appended).toBe(true);
    // `coversUpTo` MUST equal the pre-append length: that is the value
    // computeSparseFrom resolves to, and the only reason a sparse cut can trim.
    expect(snap.coversUpTo).toBe(lengthBefore);
    expect(snap.chunkCount).toBeGreaterThanOrEqual(1);
    expect(handle.ownLog.length).toBe(lengthBefore + snap.chunkCount);

    // The snapshot is really ON the log at the tail, not merely reported.
    expect(await findLatestSnapshotIndex(handle.ownLog)).toBe(lengthBefore);
    const tailOp = await handle.ownLog.get(lengthBefore);
    expect(isSnapshotOp(tailOp)).toBe(true);
  });

  it('runs with the SUBSTRATE_LOG_SNAPSHOT producer flag forced OFF — the request is not rationed by it', async () => {
    // The producer flag defaults ON since p2p-join-catchup-speed P-005, so force it OFF
    // here (env override precedes the default; the flag is read once at boot). If this
    // request were gated on it, a box running with the producer switched off would lose
    // the no-outage cut — strictly weaker than the outage-taking one it replaces, for no
    // new exposure, since the QUIESCED cut path already calls produceLogSnapshot
    // unconditionally (cut-seed-cli refreshCorestoreStateForSeed).
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
    const prior = process.env[FLAG_ENV];
    process.env[FLAG_ENV] = '0';
    cleanups.push(() => {
      if (prior === undefined) delete process.env[FLAG_ENV];
      else process.env[FLAG_ENV] = prior;
    });
    const handle = await bootWithOps('p019-b', 2);
    const snap = await handle.produceHeadSnapshotNow();
    expect(snap.appended).toBe(true);
    expect(snap.coversUpTo).toBe(2);
  });

  it('an empty own log reports appended:false rather than writing a degenerate snapshot', async () => {
    const handle = await bootWithOps('p019-c', 0);
    const snap = await handle.produceHeadSnapshotNow();
    expect(snap.appended).toBe(false);
    expect(handle.ownLog.length).toBe(0);
  });

  it('rejects an unreadable anchor without folding history and permits a later recovered request', async () => {
    const anchor = vi.spyOn(ownCompactionAnchor, 'discoverOwnCompactionAnchor').mockResolvedValue({
      known: false,
      outcome: 'unreadable(atIndex=1,cause=timeout)',
    });
    cleanups.push(() => anchor.mockRestore());
    const handle = await bootWithOps('head-unreadable-anchor', 2);
    const lengthBefore = handle.ownLog.length;
    const reads = vi.spyOn(handle.ownLog, 'get');

    await expect(handle.produceHeadSnapshotNow()).rejects.toThrow(/anchor.*unreadable/);

    // The normal merge can still read the tail. It must not start the snapshot's
    // fallback scan at block zero or append a replacement set on unknown history.
    expect(reads.mock.calls.map(([index]) => index)).not.toContain(0);
    expect(handle.ownLog.length).toBe(lengthBefore);
    reads.mockRestore();
    anchor.mockRestore();

    // The failed request must release both its coalescing slot and merge pass.
    await handle.mergeNow();
    const recovered = await handle.produceHeadSnapshotNow();
    expect(recovered).toMatchObject({ appended: true, coversUpTo: lengthBefore });
    expect(await findLatestSnapshotIndex(handle.ownLog)).toBe(lengthBefore);
  });

  it.each([0, 60_000])('reports real head-fold cursors with a %ims progress throttle', async (interval) => {
    const slug = `head-progress-${interval}`;
    const rows: Array<{ harnessSlug: string; message?: string }> = [];
    _setPgWriteForTests((entry) => rows.push(entry));
    cleanups.push(() => _resetBootHistoryForTests());
    const count = SNAPSHOT_READ_CONCURRENCY * 3 + 1;
    const handle = await bootWithOps(slug, count, { ownCompactionProgressIntervalMs: interval });
    // Freeze only the wall clock, keeping the real Corestore and event loop. A
    // short fold must stay quiet under the production throttle, while interval 0
    // exposes every completed read window for the behavioral wiring check.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const snap = await handle.produceHeadSnapshotNow();
      expect(snap).toMatchObject({ appended: true, coversUpTo: count });
      const messages = rows.filter((event) => event.harnessSlug === slug)
        .map((event) => event.message ?? '');
      const progress = messages.filter((message) => message.startsWith('on-demand head snapshot progress: '));
      if (interval === 0) {
        const cursors = progress.map((message) => Number(/cursor=(\d+)\//.exec(message)?.[1]));
        expect(cursors).toEqual([
          SNAPSHOT_READ_CONCURRENCY,
          SNAPSHOT_READ_CONCURRENCY * 2,
          SNAPSHOT_READ_CONCURRENCY * 3,
          count,
        ]);
        expect(progress.every((message) => message.includes(`/${count} `))).toBe(true);
        expect(progress.at(-1)).toContain(`decodedOps=${count}`);
        const chronological = listBootHistory({ workspaceId: 'ws-p019', harnessSlug: slug })
          .reverse().map((event) => event.message ?? '');
        const completedAt = chronological.findIndex((message) => message.startsWith('on-demand head snapshot: '));
        expect(completedAt).toBeGreaterThan(0);
        // The durable writer observes progress in arrival order. The ring also
        // holds the completion: every cursor must precede it.
        expect(chronological.slice(0, completedAt).filter((message) => progress.includes(message))).toEqual(progress);
      } else {
        expect(progress).toEqual([]);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('CONCURRENT callers coalesce onto ONE snapshot — neither waiter is orphaned', async () => {
    // The failure this pins: a request channel that just assigns `pending = {...}`
    // lets a second caller overwrite the first waiter, whose promise then never
    // settles. Under a release cut that is an indefinite hang, not an error.
    const handle = await bootWithOps('p019-d', 4);
    const lengthBefore = handle.ownLog.length;

    const [a, b] = await Promise.all([
      handle.produceHeadSnapshotNow(),
      handle.produceHeadSnapshotNow(),
    ]);

    expect(a).toEqual(b);
    expect(a.coversUpTo).toBe(lengthBefore);
    // ONE snapshot set landed, not two — the O(history) read was paid once.
    expect(handle.ownLog.length).toBe(lengthBefore + a.chunkCount);
  });

  it('a SECOND request after the first completes produces a NEW snapshot (coalescing is per-flight, not once-ever)', async () => {
    const handle = await bootWithOps('p019-e', 2);
    const first = await handle.produceHeadSnapshotNow();
    await handle.append({
      type: 'put',
      table: 'p019_test_table',
      hbKey: 'K-later',
      value: { id: 'K-later' },
      ts: 9999,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    const second = await handle.produceHeadSnapshotNow();
    expect(second.coversUpTo).toBeGreaterThan(first.coversUpTo);
    expect(await findLatestSnapshotIndex(handle.ownLog)).toBe(second.coversUpTo);
  });

  it('REJECTS on a stopped engine instead of hanging forever', async () => {
    // mergeNow() short-circuits to 0 once stopped, so an armed request would never be
    // serviced. A cut awaiting it would wait out its whole budget for no reason.
    const handle = await bootWithOps('p019-f', 1);
    await handle.close();
    await expect(handle.produceHeadSnapshotNow()).rejects.toThrow(/stopped|closing/i);
  });

  it('drops absent pre-census governor receipts and keeps live ones (WI-10003060 / P-530)', async () => {
    // The cut ships this set as the published seed. Before WI-10003060 the head path
    // passed only excludeTables, so every cut re-shipped the dead receipts.
    const slug = 'wi3060-a';
    const handle = await bootWithOps(slug, 2, {
      loadOwnCompactionGovernorReceiptKeys: async () => ['papercusp/WI-LIVE'],
    });
    await handle.append(governorReceipt('papercusp/WI-DEAD'));
    await handle.append(governorReceipt('papercusp/WI-LIVE'));

    const snap = await handle.produceHeadSnapshotNow();

    expect(snap).toMatchObject({ appended: true, droppedGovernorReceipts: 1 });
    const keys = await snapshotRowKeys(handle, snap);
    expect(keys).not.toContain('papercusp/WI-DEAD');
    expect(keys).toContain('papercusp/WI-LIVE');
    expect(keys).toContain('K-0');
    expect(headSnapshotEvent(slug)).toContain('receiptFilter=on droppedGovernorReceipts=1');
  });

  it('a failed receipt census still cuts, unfiltered, instead of failing the release cut (WI-10003060)', async () => {
    const slug = 'wi3060-b';
    const handle = await bootWithOps(slug, 1, {
      loadOwnCompactionGovernorReceiptKeys: async () => {
        throw new Error('census unavailable');
      },
    });
    await handle.append(governorReceipt('papercusp/WI-DEAD'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => consoleError.mockRestore());

    const snap = await handle.produceHeadSnapshotNow();

    expect(snap.appended).toBe(true);
    expect(await snapshotRowKeys(handle, snap)).toContain('papercusp/WI-DEAD');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('head snapshot: governor-receipt census failed; the set keeps every receipt: census unavailable'),
    );
    expect(headSnapshotEvent(slug)).toContain('receiptFilter=off droppedGovernorReceipts=0');
  });
});

function governorReceipt(hbKey: string): PeerLogOp {
  return {
    type: 'put',
    table: 'engineer-issues',
    hbKey,
    value: { payload: { resource_governor: { schemaVersion: 1, state: 'completed' } } },
    ts: 2_000,
    schema_version: CURRENT_SCHEMA_VERSION,
    author_pubkey: '',
  };
}

async function snapshotRowKeys(
  handle: Awaited<ReturnType<typeof bootWithOps>>,
  snap: { coversUpTo: number; chunkCount: number },
): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < snap.chunkCount; i++) {
    const op = await handle.ownLog.get(snap.coversUpTo + i);
    keys.push(...((op?.value as SnapshotPayload | undefined)?.rows ?? []).map((row) => row.hbKey));
  }
  return keys;
}

function headSnapshotEvent(slug: string): string | undefined {
  return listBootHistory({ workspaceId: 'ws-p019', harnessSlug: slug, kinds: ['peer_capped'] })
    .map((e) => e.message ?? '')
    .find((m) => m.startsWith('on-demand head snapshot: '));
}
