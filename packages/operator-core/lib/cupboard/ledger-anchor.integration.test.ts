/**
 * Hourly ledger anchoring on Postgres (P-041, R-29; migration 1289). Real
 * migrations, the real ledger_chain_links feed, and an in-memory stand-in for
 * the public chain.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendLinks, entryDigest, type ChainLink } from '@papercusp/hash-chain';
import { verifyConsistency } from '@papercusp/merkle-log';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import {
  HOUR_SECONDS,
  buildInclusionBundle,
  pendingLeaves,
  runAnchorTick,
  verifyInclusionBundle,
  type AnchorBackend,
  type AnchoredRoot,
  type AnchorInclusionBundle,
  type AnchorReader,
} from './ledger-anchor';
import { anchorWorkspaces, ledgerAnchorLogId, pgAnchorLinkFeed, pgLedgerAnchorStore } from './ledger-anchor-store';
import { pgLedgerChainLinkStore } from './ledger-chain';

const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

function publicChain(): { backend: AnchorBackend; reader: AnchorReader } {
  const records = new Map<string, AnchoredRoot>();
  let n = 0;
  return {
    backend: {
      kind: 'test-chain',
      async publish(p) {
        const ref = `0x${(++n).toString(16).padStart(64, '0')}`;
        records.set(ref, { ...p, attester: ATTESTER, revoked: false });
        return { backend: 'test-chain', chainId: 84532, ref, txHash: null, attester: ATTESTER };
      },
    },
    reader: { read: async (ref) => records.get(ref) ?? null },
  };
}

async function chainEntries(ws: string, streamId: string, head: ChainLink | null, entries: readonly unknown[]): Promise<ChainLink[]> {
  const links = appendLinks(streamId, head, entries.map((e) => entryDigest(e)));
  const res = await pgLedgerChainLinkStore(db.adminSql).append(
    ws,
    links.map((link) => ({ sourceId: `${streamId}#${link.seq}`, link })),
  );
  expect(res).toBe('ok');
  return links;
}

describe('ledger anchoring on Postgres (P-041, R-29)', () => {
  it('retains the original publication receipt across a fresh store after interruption', async () => {
    const workspaceId = 'anchor-receipt-recovery';
    await chainEntries(workspaceId, 'recovery-stream', null, [{ value: 1 }]);
    const store = pgLedgerAnchorStore(db.adminSql);
    const chain = publicChain();
    const publish = vi.spyOn(chain.backend, 'publish');
    vi.spyOn(store, 'recordAnchor').mockRejectedValueOnce(new Error('interrupted after receipt commit'));
    const args = { workspaceId, logId: ledgerAnchorLogId(workspaceId), nowSeconds: T0 + 60,
      store, feed: pgAnchorLinkFeed(db.adminSql), backend: chain.backend };
    await expect(runAnchorTick(args)).rejects.toThrow(/interrupted/);
    const recoveredStore = pgLedgerAnchorStore(db.adminSql);
    expect((await recoveredStore.pendingPublication(workspaceId))?.receipt).toBeDefined();
    await expect(runAnchorTick({ ...args, store: recoveredStore })).resolves.toMatchObject({ status: 'anchored' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await recoveredStore.pendingPublication(workspaceId)).toBeNull();
  });

  it('records a completed quiet hour with the same root and size and an unchanged prefix', async () => {
    const ws = `ws-anchor-quiet-${Date.now()}`;
    const store = pgLedgerAnchorStore(db.adminSql);
    const feed = pgAnchorLinkFeed(db.adminSql);
    const chain = publicChain();
    await chainEntries(ws, 'money-journal', null, [{ cents: 100 }]);
    const tick = (nowSeconds: number) =>
      runAnchorTick({ workspaceId: ws, logId: ledgerAnchorLogId(ws), nowSeconds, store, feed, backend: chain.backend });
    const first = await tick(T0 + 60);
    const quiet = await tick(T0 + HOUR_SECONDS + 60);
    expect(first).toMatchObject({ status: 'anchored', newLeaves: 1 });
    expect(quiet).toMatchObject({ status: 'anchored', newLeaves: 0 });
    if (first.status !== 'anchored' || quiet.status !== 'anchored') throw new Error('expected both completed hours to be anchored');
    expect(quiet.anchor).toMatchObject({
      anchorSeq: 1,
      logRoot: first.anchor.logRoot,
      treeSize: first.anchor.treeSize,
      consistencyFrom: first.anchor.treeSize,
      windowStart: T0,
      windowEnd: T0 + HOUR_SECONDS,
    });
    expect(quiet.anchor.ref).not.toBe(first.anchor.ref);
    expect(await chain.reader.read(quiet.anchor.ref)).toMatchObject({ logRoot: first.anchor.logRoot, treeSize: 1 });
    expect(verifyConsistency({
      oldSize: first.anchor.treeSize, newSize: quiet.anchor.treeSize,
      oldRoot: first.anchor.logRoot, newRoot: quiet.anchor.logRoot, proof: quiet.anchor.consistencyProof,
    })).toBe(true);
    expect((await tick(T0 + HOUR_SECONDS + 900)).status).toBe('already-anchored');
    expect(await store.anchors(ws)).toHaveLength(2);
    expect(await store.leaves(ws)).toHaveLength(1);
  });

  it('anchors every chain link hourly, proves inclusion, and stays append-only and consistent', async () => {
    const ws = `ws-anchor-${Date.now()}`;
    const store = pgLedgerAnchorStore(db.adminSql);
    const feed = pgAnchorLinkFeed(db.adminSql);
    const chain = publicChain();
    const tick = (nowSeconds: number) =>
      runAnchorTick({ workspaceId: ws, logId: ledgerAnchorLogId(ws), nowSeconds, store, feed, backend: chain.backend });

    const journal = await chainEntries(ws, 'money-journal', null, [{ cents: 100 }, { cents: -40 }]);
    await chainEntries(ws, 'plan-admission:pot-a', null, [{ event: 'admitted' }]);
    expect(await anchorWorkspaces(db.adminSql)).toContain(ws);

    const first = await tick(T0 + 120);
    expect(first).toMatchObject({ status: 'anchored', newLeaves: 3 });
    // Repeating the tick in the same hour publishes nothing.
    expect((await tick(T0 + 900)).status).toBe('already-anchored');

    const more = await chainEntries(ws, 'money-journal', journal.at(-1)!, [{ cents: 7 }]);
    const second = await tick(T0 + HOUR_SECONDS + 60);
    expect(second).toMatchObject({ status: 'anchored', newLeaves: 1 });
    if (first.status !== 'anchored' || second.status !== 'anchored') return;

    const anchors = await store.anchors(ws);
    expect(anchors.map((a) => [a.anchorSeq, a.treeSize, a.windowStart, a.windowEnd])).toEqual([
      [0, 3, T0 - HOUR_SECONDS, T0],
      [1, 4, T0, T0 + HOUR_SECONDS],
    ]);
    expect(
      verifyConsistency({
        oldSize: anchors[1]!.consistencyFrom,
        newSize: anchors[1]!.treeSize,
        oldRoot: anchors[0]!.logRoot,
        newRoot: anchors[1]!.logRoot,
        proof: anchors[1]!.consistencyProof,
      }),
    ).toBe(true);

    // The early entry is proven against the EARLIEST anchor; the late one against the second.
    const early = await buildInclusionBundle({ workspaceId: ws, link: journal[0]!, entry: { cents: 100 }, store });
    const late = await buildInclusionBundle({ workspaceId: ws, link: more[0]!, entry: { cents: 7 }, store });
    for (const [bundle, windowEnd] of [
      [early, T0],
      [late, T0 + HOUR_SECONDS],
    ] as const) {
      const portable = JSON.parse(JSON.stringify(bundle)) as AnchorInclusionBundle;
      await expect(verifyInclusionBundle(portable, chain.reader, { expectedAttester: ATTESTER })).resolves.toEqual({
        ok: true,
        anchoredWindowEnd: windowEnd,
        attester: ATTESTER,
      });
    }

    // A writer holding a stale view loses the race instead of leaving a gap or a duplicate.
    const stale = pendingLeaves((await store.leaves(ws)).slice(0, 3), [{ streamId: 'x', seq: 0, entryHash: 'f'.repeat(64) }]);
    expect(await store.appendLeaves(ws, stale)).toBe('conflict');
    const gap = pendingLeaves(await store.leaves(ws), [{ streamId: 'x', seq: 0, entryHash: 'f'.repeat(64) }]).map((l) => ({
      ...l,
      leafIndex: l.leafIndex + 2,
    }));
    expect(await store.appendLeaves(ws, gap)).toBe('conflict');
    expect(await store.recordAnchor(ws, { ...anchors[1]!, ref: '0xdup' })).toBe('conflict');

    await expect(
      db.adminSql.unsafe(`UPDATE harness_shared.ledger_anchors SET log_root = $1 WHERE workspace_id = $2`, ['0'.repeat(64), ws]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      db.adminSql.unsafe(`DELETE FROM harness_shared.ledger_anchor_leaves WHERE workspace_id = $1`, [ws]),
    ).rejects.toMatchObject({ code: '55000' });
    expect((await store.leaves(ws)).length).toBe(4);
  });
});
