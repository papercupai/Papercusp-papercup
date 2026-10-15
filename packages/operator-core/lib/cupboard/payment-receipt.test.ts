import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HOUR_SECONDS,
  memoryLedgerAnchorStore,
  runAnchorTick,
  type AnchorBackend,
  type AnchorLinkFeed,
  type AnchorPublication,
  type AnchorReader,
  type AnchoredRoot,
} from './ledger-anchor';
import { memoryLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import type { StripeBalanceTransaction } from './money-journal-producers';
import {
  PAYMENT_RECEIPT_STREAM_ID,
  receiptCommitment,
  verifyPaymentReceipt,
  type PaymentReceipt,
  type ReceiptTransaction,
} from './payment-receipt';
import {
  customerPaymentReceipts,
  issuePaymentReceipt,
  memoryPaymentReceiptStore,
  paymentReceiptsLedgerSource,
  recordPaymentReceipts,
} from './payment-receipt-store';

const WS = 'ws-receipts';
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

const TX: ReceiptTransaction = { id: 'txn_1', amount: 2_000, currency: 'usd', fee: 88, created: T0 + 60 };

function bt(id: string, amount: number, customer: string | null, fee = 30): StripeBalanceTransaction {
  return {
    id,
    type: 'charge',
    amount,
    fee,
    currency: 'usd',
    created: T0 + 120,
    source: { id: `ch_${id}`, object: 'charge', customer },
  };
}

function fakeChain(): { backend: AnchorBackend; reader: AnchorReader; records: Map<string, AnchoredRoot> } {
  const records = new Map<string, AnchoredRoot>();
  let n = 0;
  return {
    records,
    backend: {
      kind: 'fake-chain',
      async publish(p: AnchorPublication) {
        n += 1;
        const ref = '0x' + createHash('sha256').update(`uid-${n}`).digest('hex');
        records.set(ref, { ...p, attester: ATTESTER, revoked: false });
        return { backend: 'fake-chain', chainId: 84532, ref, txHash: `0x${'ab'.repeat(32)}`, attester: ATTESTER };
      },
    },
    reader: { read: async (ref) => records.get(ref) ?? null },
  };
}

/** Records, chains and anchors receipts; returns everything needed to issue and verify. */
async function anchoredWorld(transactions: readonly StripeBalanceTransaction[]) {
  const store = memoryPaymentReceiptStore();
  const chain = memoryLedgerChainLinkStore();
  const anchors = memoryLedgerAnchorStore();
  let saltN = 0;
  const salt = () => (++saltN).toString(16).padStart(64, '0');
  const recorded = await recordPaymentReceipts(WS, transactions, { store, chain, salt });
  const feed: AnchorLinkFeed = {
    links: async (ws) =>
      (await chain.links(ws, PAYMENT_RECEIPT_STREAM_ID)).map((s) => ({ streamId: s.link.streamId, seq: s.link.seq, entryHash: s.link.entryHash })),
  };
  const fake = fakeChain();
  const tick = await runAnchorTick({ workspaceId: WS, logId: `papercusp:${WS}`, nowSeconds: T0 + HOUR_SECONDS + 5, store: anchors, feed, backend: fake.backend });
  return { store, chain, anchors, recorded, tick, fake, deps: { store, chain, anchors } };
}

describe('receiptCommitment', () => {
  it('is deterministic for the same salt and fields', () => {
    expect(receiptCommitment(TX, SALT_A)).toBe(receiptCommitment({ ...TX }, SALT_A));
    expect(receiptCommitment(TX, SALT_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the salt and with every committed field', () => {
    const base = receiptCommitment(TX, SALT_A);
    expect(receiptCommitment(TX, SALT_B)).not.toBe(base);
    for (const changed of [
      { ...TX, id: 'txn_2' },
      { ...TX, amount: 2_001 },
      { ...TX, currency: 'eur' },
      { ...TX, fee: 89 },
      { ...TX, created: TX.created + 1 },
    ]) {
      expect(receiptCommitment(changed, SALT_A)).not.toBe(base);
    }
  });

  it('refuses a malformed salt or transaction', () => {
    expect(() => receiptCommitment(TX, 'nope')).toThrow(/salt/);
    expect(() => receiptCommitment({ ...TX, fee: -1 }, SALT_A)).toThrow(/fee/);
    expect(() => receiptCommitment({ ...TX, currency: 'USD' }, SALT_A)).toThrow(/currency/);
  });
});

describe('recordPaymentReceipts', () => {
  it('records each new balance transaction once, keeps its first salt, and chains only the commitment', async () => {
    const store = memoryPaymentReceiptStore();
    const chain = memoryLedgerChainLinkStore();
    const first = await recordPaymentReceipts(WS, [bt('a', 1000, 'cus_1'), bt('b', 500, 'cus_2')], { store, chain, salt: () => SALT_A });
    expect(first).toMatchObject({ recorded: 2, existing: 0, chained: 2, rejected: [] });
    const again = await recordPaymentReceipts(WS, [bt('a', 1000, 'cus_1'), bt('c', 700, null)], { store, chain, salt: () => SALT_B });
    expect(again).toMatchObject({ recorded: 1, existing: 1, chained: 1 });
    expect((await store.get(WS, 'a'))?.salt).toBe(SALT_A);
    expect((await store.get(WS, 'a'))?.sourceCustomer).toBe('cus_1');
    expect((await store.get(WS, 'c'))?.sourceCustomer).toBeNull();

    const listed = await paymentReceiptsLedgerSource(WS, store).list();
    expect(listed.map((e) => Object.keys(e.entry as object))).toEqual([['commitment'], ['commitment'], ['commitment']]);
    const report = await verifyLedger(WS, paymentReceiptsLedgerSource(WS, store), chain);
    expect(report.ok).toBe(true);
  });

  it('reports a transaction it cannot commit instead of dropping it silently', async () => {
    const r = await recordPaymentReceipts(WS, [{ ...bt('bad', 10, null), fee: -5 }], {
      store: memoryPaymentReceiptStore(),
      chain: memoryLedgerChainLinkStore(),
    });
    expect(r.recorded).toBe(0);
    expect(r.rejected).toEqual([{ id: 'bad', reason: expect.stringMatching(/fee/) }]);
  });
});

describe('issue + verify', () => {
  it('a receipt for an anchored payment verifies against the anchored root', async () => {
    const w = await anchoredWorld([bt('a', 1000, 'cus_1'), bt('b', 2500, 'cus_1'), bt('c', 900, 'cus_2')]);
    expect(w.tick.status).toBe('anchored');
    const issued = await issuePaymentReceipt(WS, 'b', w.deps);
    if (!issued.ok) throw new Error(`issue failed: ${issued.error}`);
    expect(issued.receipt.transaction).toEqual({ id: 'b', amount: 2500, currency: 'usd', fee: 30, created: T0 + 120 });
    const verdict = await verifyPaymentReceipt(issued.receipt, w.fake.reader, { expectedAttester: ATTESTER });
    expect(verdict).toMatchObject({ ok: true, transaction: { id: 'b', amount: 2500 }, attester: ATTESTER });
  });

  it('rejects a receipt whose amount, salt or stream was altered', async () => {
    const w = await anchoredWorld([bt('a', 1000, 'cus_1'), bt('b', 2500, 'cus_1')]);
    const issued = await issuePaymentReceipt(WS, 'a', w.deps);
    if (!issued.ok) throw new Error(issued.error);
    const r: PaymentReceipt = issued.receipt;
    const check = (x: PaymentReceipt) => verifyPaymentReceipt(x, w.fake.reader, { expectedAttester: ATTESTER });

    expect(await check({ ...r, transaction: { ...r.transaction, amount: 999_999 } })).toEqual({ ok: false, reason: 'commitment-mismatch' });
    expect(await check({ ...r, salt: SALT_B })).toEqual({ ok: false, reason: 'commitment-mismatch' });
    // A recomputed commitment for forged fields still has to be the entry the anchored proof covers.
    const forged = { ...r.transaction, amount: 1 };
    const forgedCommitment = receiptCommitment(forged, r.salt);
    expect(
      await check({ ...r, transaction: forged, commitment: forgedCommitment, bundle: { ...r.bundle, entry: { commitment: forgedCommitment } } }),
    ).toEqual({ ok: false, reason: 'entry-mismatch' });
    expect(await check({ ...r, bundle: { ...r.bundle, link: { ...r.bundle.link, streamId: 'money-journal' } } })).toEqual({
      ok: false,
      reason: 'wrong-stream',
    });
    expect(await check({ ...r, format: 'nope' as PaymentReceipt['format'] })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a receipt when the anchor is revoked or signed by someone else', async () => {
    const w = await anchoredWorld([bt('a', 1000, 'cus_1')]);
    const issued = await issuePaymentReceipt(WS, 'a', w.deps);
    if (!issued.ok) throw new Error(issued.error);
    expect(await verifyPaymentReceipt(issued.receipt, w.fake.reader, { expectedAttester: '0x' + '1'.repeat(40) })).toEqual({
      ok: false,
      reason: 'attester-mismatch',
    });
    const ref = issued.receipt.bundle.anchor.ref;
    w.fake.records.set(ref, { ...w.fake.records.get(ref)!, revoked: true });
    expect(await verifyPaymentReceipt(issued.receipt, w.fake.reader)).toEqual({ ok: false, reason: 'anchor-revoked' });
  });

  it('answers not-yet-anchored before the covering hour is published, and unknown-transaction for a stranger', async () => {
    const store = memoryPaymentReceiptStore();
    const chain = memoryLedgerChainLinkStore();
    const anchors = memoryLedgerAnchorStore();
    await recordPaymentReceipts(WS, [bt('a', 1000, 'cus_1')], { store, chain });
    expect(await issuePaymentReceipt(WS, 'zzz', { store, chain, anchors })).toEqual({ ok: false, error: 'unknown-transaction' });
    expect(await issuePaymentReceipt(WS, 'a', { store, chain, anchors })).toEqual({ ok: false, error: 'not-in-log' });
  });

  it("lists only the signed-in customer's receipts, newest first", async () => {
    const w = await anchoredWorld([bt('a', 1000, 'cus_1'), bt('b', 2500, 'cus_2'), bt('c', 900, 'cus_1')]);
    const mine = await customerPaymentReceipts(WS, 'cus_1', w.deps);
    expect(mine.map((r) => r.balanceTransactionId)).toEqual(['c', 'a']);
    expect(mine.every((r) => r.result.ok)).toBe(true);
  });
});
