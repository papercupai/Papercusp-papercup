import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { appendLinks, entryDigest, type ChainLink } from '@papercusp/hash-chain';
import { rootHash, verifyConsistency } from '@papercusp/merkle-log';
import {
  HOUR_SECONDS,
  anchorCadence,
  buildInclusionBundle,
  checkAnchorCadence,
  memoryLedgerAnchorStore,
  runAnchorTick,
  verifyInclusionBundle,
  type AnchorBackend,
  type AnchorInclusionBundle,
  type AnchorLinkFeed,
  type AnchorPublication,
  type AnchorReader,
  type AnchoredRoot,
} from './ledger-anchor';

const WS = 'ws-anchor-test';
const LOG_ID = 'papercusp:ws-anchor-test';
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS); // an hour boundary

/** A stand-in for public chain data: publish() is the attester's write, read() is anyone's public read. */
function fakeChain(attester = ATTESTER): { backend: AnchorBackend; reader: AnchorReader; records: Map<string, AnchoredRoot> } {
  const records = new Map<string, AnchoredRoot>();
  let n = 0;
  const backend: AnchorBackend = {
    kind: 'fake-chain',
    async publish(p: AnchorPublication) {
      n += 1;
      const ref = '0x' + createHash('sha256').update(`uid-${n}`).digest('hex');
      records.set(ref, { ...p, attester, revoked: false });
      return { backend: 'fake-chain', chainId: 84532, ref, txHash: `0x${'ab'.repeat(32)}`, attester };
    },
  };
  const reader: AnchorReader = { read: async (ref) => records.get(ref) ?? null };
  return { backend, reader, records };
}

interface Ledger {
  readonly entries: Map<string, unknown>;
  readonly links: ChainLink[];
  add(streamId: string, entries: readonly unknown[]): void;
  feed: AnchorLinkFeed;
}

function ledger(): Ledger {
  const entries = new Map<string, unknown>();
  const links: ChainLink[] = [];
  return {
    entries,
    links,
    add(streamId, es) {
      const head = [...links].reverse().find((l) => l.streamId === streamId) ?? null;
      const added = appendLinks(streamId, head, es.map((e) => entryDigest(e)));
      added.forEach((l, i) => entries.set(`${streamId}#${l.seq}`, es[i]));
      links.push(...added);
    },
    feed: { links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) },
  };
}

const linkOf = (l: Ledger, streamId: string, seq: number): ChainLink => l.links.find((x) => x.streamId === streamId && x.seq === seq)!;

async function setup() {
  const store = memoryLedgerAnchorStore();
  const chain = fakeChain();
  const l = ledger();
  l.add('money-journal', [{ amountCents: 1200, ref: 'txn_1' }, { amountCents: -300, ref: 'txn_2' }]);
  l.add('plan-admission:pot-a', [{ event: 'admitted', plan: 'p1' }]);
  const tick = (nowSeconds: number) =>
    runAnchorTick({ workspaceId: WS, logId: LOG_ID, nowSeconds, store, feed: l.feed, backend: chain.backend });
  return { store, chain, l, tick };
}

describe('ledger anchor: inclusion against an anchored root (R-29)', () => {
  it('a covered entry verifies from the bundle plus public chain reads only', async () => {
    const { store, chain, l, tick } = await setup();
    const r = await tick(T0 + 5 * 60);
    expect(r.status).toBe('anchored');
    if (r.status !== 'anchored') return;
    expect(r.anchor).toMatchObject({ treeSize: 3, windowStart: T0 - HOUR_SECONDS, windowEnd: T0, attester: ATTESTER });

    const link = linkOf(l, 'money-journal', 1);
    const bundle = await buildInclusionBundle({ workspaceId: WS, link, entry: l.entries.get('money-journal#1'), store });
    expect('error' in bundle).toBe(false);
    // Round-trip through JSON: the verifier gets plain data, no store, no server.
    const portable = JSON.parse(JSON.stringify(bundle)) as AnchorInclusionBundle;
    await expect(verifyInclusionBundle(portable, chain.reader, { expectedAttester: ATTESTER })).resolves.toEqual({
      ok: true,
      anchoredWindowEnd: T0,
      attester: ATTESTER,
    });
  });

  it('refuses a non-member and every tampered bundle', async () => {
    const { store, chain, l, tick } = await setup();
    await tick(T0 + 60);
    const link = linkOf(l, 'money-journal', 0);
    const good = (await buildInclusionBundle({ workspaceId: WS, link, entry: l.entries.get('money-journal#0'), store })) as AnchorInclusionBundle;
    const verify = (b: AnchorInclusionBundle, attester = ATTESTER) => verifyInclusionBundle(b, chain.reader, { expectedAttester: attester });

    // A link that was never written to the ledger is not in the log.
    const stranger = appendLinks('money-journal', linkOf(l, 'money-journal', 1), [entryDigest({ forged: true })])[0]!;
    await expect(buildInclusionBundle({ workspaceId: WS, link: stranger, store })).resolves.toEqual({ error: 'not-in-log' });

    // A non-member presented with a real proof and root is refused.
    await expect(verify({ ...good, link: stranger, entry: undefined })).resolves.toEqual({ ok: false, reason: 'not-included' });
    // The entry was altered after the fact.
    await expect(verify({ ...good, entry: { amountCents: 999_999, ref: 'txn_1' } })).resolves.toEqual({ ok: false, reason: 'entry-mismatch' });
    // The link was altered (its stored hash no longer matches).
    await expect(verify({ ...good, entry: undefined, link: { ...good.link, seq: 7 } })).resolves.toEqual({ ok: false, reason: 'link-mismatch' });
    // A self-consistent proof against a root the chain never recorded.
    const forgedRoot = rootHash([good.proof[0] ?? good.logRoot]);
    await expect(verify({ ...good, logRoot: forgedRoot, proof: [], treeSize: 1, leafIndex: 0 })).resolves.toMatchObject({ ok: false });
    // An anchor ref that does not exist on chain.
    await expect(verify({ ...good, anchor: { ...good.anchor, ref: '0x' + '00'.repeat(32) } })).resolves.toEqual({ ok: false, reason: 'anchor-not-found' });
    // Anchored by someone other than the published attester.
    await expect(verify(good, '0x000000000000000000000000000000000000bad0')).resolves.toEqual({ ok: false, reason: 'attester-mismatch' });
    // A revoked record is not trusted.
    chain.records.set(good.anchor.ref, { ...chain.records.get(good.anchor.ref)!, revoked: true });
    await expect(verify(good)).resolves.toEqual({ ok: false, reason: 'anchor-revoked' });
  });

  it('an entry written after an anchor is provable only once the next hour is anchored, against the earliest covering root', async () => {
    const { store, chain, l, tick } = await setup();
    await tick(T0 + 60);
    l.add('money-journal', [{ amountCents: 50, ref: 'txn_3' }]);
    const late = linkOf(l, 'money-journal', 2);
    await expect(buildInclusionBundle({ workspaceId: WS, link: late, store })).resolves.toEqual({ error: 'not-in-log' });

    const r2 = await tick(T0 + HOUR_SECONDS + 60);
    expect(r2).toMatchObject({ status: 'anchored', newLeaves: 1 });
    const b = (await buildInclusionBundle({ workspaceId: WS, link: late, store })) as AnchorInclusionBundle;
    expect(b.anchor.windowEnd).toBe(T0 + HOUR_SECONDS);
    await expect(verifyInclusionBundle(b, chain.reader)).resolves.toMatchObject({ ok: true });

    // An earlier entry is proven against the FIRST anchor, which shows it existed by then.
    const early = (await buildInclusionBundle({ workspaceId: WS, link: linkOf(l, 'money-journal', 0), store })) as AnchorInclusionBundle;
    expect(early.anchor.windowEnd).toBe(T0);
  });
});

describe('ledger anchor: cadence, idempotence and append-only consistency', () => {
  it('recovers a saved publication receipt after losing the final anchor write', async () => {
    const { store, chain, tick } = await setup();
    const write = vi.spyOn(store, 'recordAnchor').mockRejectedValueOnce(new Error('host stopped before anchor record'));
    await expect(tick(T0 + 60)).rejects.toThrow(/host stopped/);
    expect(chain.records.size).toBe(1);
    write.mockRestore();
    await expect(tick(T0 + 120)).resolves.toMatchObject({ status: 'anchored' });
    expect(chain.records.size).toBe(1);
  });

  it('halts an uncertain non-replayable publication instead of submitting again', async () => {
    const { store, chain, l } = await setup();
    const real = chain.backend.publish.bind(chain.backend);
    const publish = vi.spyOn(chain.backend, 'publish').mockImplementationOnce(async (...args) => {
      await real(...args); throw new Error('receipt lost');
    });
    const tick = () => runAnchorTick({ workspaceId: WS, logId: LOG_ID, nowSeconds: T0 + 60, store, feed: l.feed, backend: chain.backend });
    await expect(tick()).rejects.toThrow(/receipt lost/);
    await expect(tick()).rejects.toThrow(/needs reconciliation/);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(chain.records.size).toBe(1);
  });

  it('reuses the prepared transaction and pinned root after interrupted receipt persistence', async () => {
    const { store, chain, l } = await setup();
    chain.backend.prepare = vi.fn(async () => ({ rawTransaction: 'signed', txHash: 'stable-hash',
      chainId: 84532, attester: ATTESTER, nonce: 1 }));
    const physical = chain.backend.publish.bind(chain.backend);
    let receipt: Awaited<ReturnType<typeof physical>> | undefined;
    const publish = vi.spyOn(chain.backend, 'publish').mockImplementation(async (p) => receipt ??= await physical(p));
    const save = vi.spyOn(store, 'recordPublicationReceipt').mockRejectedValueOnce(new Error('process lost'));
    const tick = () => runAnchorTick({ workspaceId: WS, logId: LOG_ID, nowSeconds: T0 + 60, store, feed: l.feed, backend: chain.backend });
    await expect(tick()).rejects.toThrow(/process lost/);
    l.add('money-journal', [{ amountCents: 5 }]);
    save.mockRestore();
    await expect(tick()).resolves.toMatchObject({ status: 'anchored', anchor: { treeSize: 3 } });
    expect(chain.backend.prepare).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
    expect(chain.records.size).toBe(1);
  });

  it('a repeated tick inside the same hour publishes nothing', async () => {
    const { chain, tick } = await setup();
    await tick(T0 + 60);
    await expect(tick(T0 + 30 * 60)).resolves.toMatchObject({ status: 'already-anchored' });
    expect(chain.records.size).toBe(1);
  });

  it('after missed hours one anchor covers the gap, and each anchor proves the log only appended', async () => {
    const { store, l, tick } = await setup();
    const r1 = await tick(T0 + 60);
    l.add('plan-admission:pot-a', [{ event: 'admitted', plan: 'p2' }, { event: 'admitted', plan: 'p3' }]);
    const r2 = await tick(T0 + 3 * HOUR_SECONDS + 60); // two hours skipped
    if (r1.status !== 'anchored' || r2.status !== 'anchored') throw new Error('expected two anchors');
    expect(r2.anchor).toMatchObject({ windowStart: T0, windowEnd: T0 + 3 * HOUR_SECONDS, consistencyFrom: 3, treeSize: 5 });
    expect(
      verifyConsistency({
        oldSize: r1.anchor.treeSize,
        newSize: r2.anchor.treeSize,
        oldRoot: r1.anchor.logRoot,
        newRoot: r2.anchor.logRoot,
        proof: r2.anchor.consistencyProof,
      }),
    ).toBe(true);
    expect((await store.anchors(WS)).map((a) => a.anchorSeq)).toEqual([0, 1]);
  });

  it('a skipped hour fires the alert; an anchored hour does not', async () => {
    const { store, tick } = await setup();
    const alert = { missedHour: vi.fn(async () => undefined) };

    // Nothing anchored yet, and the hour plus grace has passed.
    const none = await checkAnchorCadence({ workspaceId: WS, nowSeconds: T0 + 30 * 60, store, alert });
    expect(none).toMatchObject({ status: 'missed', lastWindowEnd: null, expectedWindowEnd: T0 });
    expect(alert.missedHour).toHaveBeenCalledTimes(1);

    await tick(T0 + 31 * 60);
    alert.missedHour.mockClear();
    await expect(checkAnchorCadence({ workspaceId: WS, nowSeconds: T0 + 40 * 60, store, alert })).resolves.toMatchObject({ status: 'on-time' });
    expect(alert.missedHour).not.toHaveBeenCalled();

    // The next hour goes unanchored (e.g. publication failed): alert once grace expires.
    await expect(checkAnchorCadence({ workspaceId: WS, nowSeconds: T0 + HOUR_SECONDS + 10 * 60, store, alert })).resolves.toMatchObject({ status: 'on-time' });
    const missed = await checkAnchorCadence({ workspaceId: WS, nowSeconds: T0 + 3 * HOUR_SECONDS + 25 * 60, store, alert });
    expect(missed).toMatchObject({ status: 'missed', lastWindowEnd: T0, expectedWindowEnd: T0 + 3 * HOUR_SECONDS, hoursBehind: 3 });
    expect(alert.missedHour).toHaveBeenCalledTimes(1);
  });

  it('a failed publication records nothing, so the hour surfaces as missed', async () => {
    const { store, l } = await setup();
    const failing: AnchorBackend = { kind: 'down', publish: async () => Promise.reject(new Error('rpc unreachable')) };
    await expect(runAnchorTick({ workspaceId: WS, logId: LOG_ID, nowSeconds: T0 + 60, store, feed: l.feed, backend: failing })).rejects.toThrow('rpc unreachable');
    expect(await store.anchors(WS)).toEqual([]);
    expect(anchorCadence({ workspaceId: WS, nowSeconds: T0 + 30 * 60, lastWindowEnd: null })).toMatchObject({ status: 'missed' });
  });
});
